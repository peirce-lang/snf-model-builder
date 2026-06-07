/**
 * ModelBuilderApp.jsx
 *
 * SNF Model Builder — Browser Wizard
 *
 * Six-step wizard: choose source → map columns → review flags → pick nucleus → name & target → compile + download
 *
 * Two source paths:
 *   FILE   — CSV or Excel. Drop a file. Python reads it, returns columns + samples.
 *   SQL    — Live Postgres connection. Paste connection string + table name. Python
 *            introspects schema read-only via SQLAlchemy. Data never leaves the database.
 *            Output is a SQL views script, not a .duckdb file.
 *
 * SECURITY INVARIANT (SQL path):
 *   Python uses SQLAlchemy read-only. No writes, no exports, no CSV on disk.
 *   The connection string goes to Python — it never touches the JS layer after submission.
 *   Output artifact is a .sql script. The DBA reviews and runs it. Data stays in the database.
 *
 * Follows the same conventions as ReckonerSNF.jsx:
 *   - Tailwind for styling
 *   - lucide-react for icons
 *   - fetch to localhost:8000/api
 *   - JS collects intent, Python does the work
 *   - No compilation logic here — BuildSpec goes to Python, BuildResult comes back
 *
 * API endpoints (Python backend — implement these):
 *
 *   POST /api/mb/upload        body: FormData { file }
 *                              returns: { upload_token, columns: [{ name, samples, suggested_dim, suggested_key }] }
 *
 *   POST /api/mb/introspect    body: { connection_string, table_name, schema_name? }
 *                              SQLAlchemy read-only. Returns same column shape as /upload.
 *                              returns: { introspect_token, columns: [...], row_count }
 *                              NEVER writes. NEVER exports. Only reads information_schema + LIMIT 10 sample.
 *
 *   POST /api/mb/review        body: { source_token, columns_mapped: [...] }
 *                              returns: { flags: [{ id, type, severity, message, details }] }
 *
 *   POST /api/mb/compile       body: BuildSpec (see below)
 *                              returns: BuildResult + { download_url }
 *
 * BuildSpec shape (mirrors spec section 7):
 * {
 *   source: {
 *     type: 'file' | 'sql',
 *     // file path:
 *     upload_token: str,  filename: str,  format: 'csv'|'excel',
 *     // sql path:
 *     introspect_token: str,  table_name: str,  schema_name: str,
 *   },
 *   mapping:    [{ column, dimension, semantic_key }],
 *   nucleus:    { type: 'single'|'compound', columns: [str], separator: str, prefix: str },
 *   lens:       { lens_id: str, version: str },
 *   target:     { backend: 'duckdb'|'postgres-views'|'postgres-import', output_name: str },
 *   provenance: { created_at: str },
 *   options:    { overwrite: bool }
 * }
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  Upload, ChevronRight, ChevronLeft, CheckCircle2, AlertTriangle,
  Info, Download, Database, FileText, Loader2, X, Plus, RefreshCw,
  Server, Eye, EyeOff, Table2
} from 'lucide-react';
import { Step5a_DataConnect } from './Step5a_DataConnect';
import { Step4b_StructuralGroups } from './Step4b_StructuralGroups';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const API_URL = 'http://localhost:8000/api';

// ─────────────────────────────────────────────────────────────────────────────
// Constants — mirror Reckoner's DIM_COLORS exactly
// ─────────────────────────────────────────────────────────────────────────────

const DIMENSIONS = ['WHO', 'WHAT', 'WHEN', 'WHERE', 'WHY', 'HOW'];

const DIM_COLORS = {
  WHO:   { bg: 'bg-blue-50',   border: 'border-blue-200',  text: 'text-blue-800',   pill: 'bg-blue-100 text-blue-700 border-blue-200'   },
  WHAT:  { bg: 'bg-purple-50', border: 'border-purple-200',text: 'text-purple-800', pill: 'bg-purple-100 text-purple-700 border-purple-200'},
  WHEN:  { bg: 'bg-green-50',  border: 'border-green-200', text: 'text-green-800',  pill: 'bg-green-100 text-green-700 border-green-200'  },
  WHERE: { bg: 'bg-amber-50',  border: 'border-amber-200', text: 'text-amber-800',  pill: 'bg-amber-100 text-amber-700 border-amber-200'  },
  WHY:   { bg: 'bg-rose-50',   border: 'border-rose-200',  text: 'text-rose-800',   pill: 'bg-rose-100 text-rose-700 border-rose-200'    },
  HOW:   { bg: 'bg-slate-50',  border: 'border-slate-200', text: 'text-slate-800',  pill: 'bg-slate-100 text-slate-700 border-slate-200'  },
};

const DIM_DESCRIPTIONS = {
  WHO:   'People, organizations, entities',
  WHAT:  'Things, titles, subjects, types',
  WHEN:  'Dates, times, durations',
  WHERE: 'Places, locations, jurisdictions',
  WHY:   'Reasons, purposes, classifications',
  HOW:   'Methods, conditions, formats',
};

const STEPS = [
  { n: 1, label: 'Source'        },
  { n: 2, label: 'Map columns'   },
  { n: 3, label: 'Review'        },
  { n: 4, label: 'Nucleus'       },
  { n: 5, label: 'Name & target' },
  { n: 6, label: 'Compile'       },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function humanize(s) {
  return String(s).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function clamp(s, n = 40) {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// ─────────────────────────────────────────────────────────────────────────────
// StepBar — progress indicator at the top
// ─────────────────────────────────────────────────────────────────────────────

function StepBar({ currentStep }) {
  return (
    <div className="flex items-center gap-0 mb-8">
      {STEPS.map((s, i) => {
        const done    = s.n < currentStep;
        const active  = s.n === currentStep;
        const future  = s.n > currentStep;
        return (
          <React.Fragment key={s.n}>
            <div className="flex flex-col items-center">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold border-2 transition-all
                ${done   ? 'bg-emerald-500 border-emerald-500 text-white' : ''}
                ${active ? 'bg-white border-blue-500 text-blue-600'       : ''}
                ${future ? 'bg-white border-gray-200 text-gray-400'       : ''}
              `}>
                {done ? <CheckCircle2 size={16} /> : s.n}
              </div>
              <span className={`text-xs mt-1 font-medium
                ${active ? 'text-blue-600' : done ? 'text-emerald-600' : 'text-gray-400'}`}>
                {s.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div className={`flex-1 h-0.5 mb-4 mx-1 transition-all
                ${s.n < currentStep ? 'bg-emerald-400' : 'bg-gray-200'}`} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// NavButtons — Back / Continue at the bottom of each step
// ─────────────────────────────────────────────────────────────────────────────

function NavButtons({ step, onBack, onNext, nextLabel = 'Continue', nextDisabled = false, loading = false }) {
  return (
    <div className="flex justify-between items-center mt-8 pt-4 border-t border-gray-100">
      {step > 1 ? (
        <button onClick={onBack}
          className="flex items-center gap-1.5 px-4 py-2 text-sm text-gray-600 hover:text-gray-900 rounded-lg hover:bg-gray-100 transition-colors">
          <ChevronLeft size={16} /> Back
        </button>
      ) : <div />}
      <button onClick={onNext} disabled={nextDisabled || loading}
        className={`flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold transition-all
          ${nextDisabled || loading
            ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
            : 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm hover:shadow'}`}>
        {loading && <Loader2 size={15} className="animate-spin" />}
        {nextLabel}
        {!loading && <ChevronRight size={15} />}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DimPill — dimension badge used in column mapping
// ─────────────────────────────────────────────────────────────────────────────

function DimPill({ dim }) {
  if (!dim || dim === 'skip') return (
    <span className="px-2 py-0.5 rounded border text-xs bg-gray-50 border-gray-200 text-gray-400">skip</span>
  );
  const c = DIM_COLORS[dim];
  return (
    <span className={`px-2 py-0.5 rounded border text-xs font-semibold ${c?.pill || 'bg-gray-100 text-gray-600'}`}>
      {dim}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FlagCard — one pre-ingest flag in step 3
// ─────────────────────────────────────────────────────────────────────────────

function FlagCard({ flag, onAcknowledge, acknowledged }) {
  const isWarning = flag.severity === 'warning';
  return (
    <div className={`rounded-lg border p-4 transition-all
      ${acknowledged ? 'opacity-50' : ''}
      ${isWarning ? 'bg-amber-50 border-amber-200' : 'bg-blue-50 border-blue-200'}`}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5">
          {isWarning
            ? <AlertTriangle size={16} className="text-amber-500" />
            : <Info size={16} className="text-blue-400" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className={`text-sm font-semibold ${isWarning ? 'text-amber-800' : 'text-blue-800'}`}>
            {flag.message}
          </div>
          {flag.details && (
            <div className="text-xs text-gray-600 mt-1">{flag.details}</div>
          )}
        </div>
        <button onClick={() => onAcknowledge(flag.id)}
          className={`flex-shrink-0 text-xs px-2.5 py-1 rounded font-medium border transition-colors
            ${acknowledged
              ? 'bg-emerald-100 border-emerald-300 text-emerald-700'
              : isWarning
                ? 'bg-white border-amber-300 text-amber-700 hover:bg-amber-100'
                : 'bg-white border-blue-300 text-blue-700 hover:bg-blue-100'}`}>
          {acknowledged ? '✓ Noted' : 'Got it'}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — Choose Source (File or SQL)
// ─────────────────────────────────────────────────────────────────────────────

function Step1_ChooseSource({ onSourceReady }) {
  const [sourceType, setSourceType] = useState(null);
  // 'file' | 'sql' | 'osi' | 'json' | 'yaml' | 'dbt' | null

  return (
    <div>
      <h2 className="text-xl font-bold text-gray-900 mb-1">Where is your data?</h2>
      <p className="text-sm text-gray-500 mb-6">
        Pick how you want to bring it in. Every path ends up in Reckoner.
      </p>

      {!sourceType && (
        <div className="space-y-4">
          {/* Row 1 — raw data */}
          <div>
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">Raw data</p>
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => setSourceType('file')}
                className="text-left p-5 rounded-xl border-2 border-gray-200 hover:border-blue-400 hover:bg-blue-50/30 transition-all group">
                <Upload size={24} className="text-gray-400 group-hover:text-blue-500 mb-2 transition-colors" />
                <div className="font-semibold text-gray-800 mb-0.5 text-sm">Upload a file</div>
                <div className="text-xs text-gray-500">CSV or Excel. Drag and drop or browse.</div>
              </button>
              <button onClick={() => setSourceType('sql')}
                className="text-left p-5 rounded-xl border-2 border-gray-200 hover:border-blue-400 hover:bg-blue-50/30 transition-all group">
                <Server size={24} className="text-gray-400 group-hover:text-blue-500 mb-2 transition-colors" />
                <div className="font-semibold text-gray-800 mb-0.5 text-sm">Connect to Postgres</div>
                <div className="text-xs text-gray-500">Read directly from a live database.</div>
              </button>
            </div>
          </div>

          {/* Row 2 — semantic vocabularies */}
          <div>
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">Semantic vocabularies</p>
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => setSourceType('dbt')}
                className="text-left p-5 rounded-xl border-2 border-gray-200 hover:border-purple-400 hover:bg-purple-50/30 transition-all group">
                <Database size={24} className="text-gray-400 group-hover:text-purple-500 mb-2 transition-colors" />
                <div className="font-semibold text-gray-800 mb-0.5 text-sm">Upload a dbt schema</div>
                <div className="text-xs text-gray-500">schema.yml — dimension mappings pre-filled from your dbt model.</div>
              </button>
              <button onClick={() => setSourceType('osi')}
                className="text-left p-5 rounded-xl border-2 border-gray-200 hover:border-purple-400 hover:bg-purple-50/30 transition-all group">
                <Table2 size={24} className="text-gray-400 group-hover:text-purple-500 mb-2 transition-colors" />
                <div className="font-semibold text-gray-800 mb-0.5 text-sm">Upload an OSI model</div>
                <div className="text-xs text-gray-500">Open Semantic Interchange YAML or JSON.</div>
              </button>
            </div>
          </div>

          {/* Row 3 — generic structured files */}
          <div>
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">Generic structured files</p>
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => setSourceType('json')}
                className="text-left p-5 rounded-xl border-2 border-gray-200 hover:border-blue-400 hover:bg-blue-50/30 transition-all group">
                <FileText size={24} className="text-gray-400 group-hover:text-blue-500 mb-2 transition-colors" />
                <div className="font-semibold text-gray-800 mb-0.5 text-sm">Upload JSON</div>
                <div className="text-xs text-gray-500">Flat JSON array. Common envelope shapes unwrapped automatically.</div>
              </button>
              <button onClick={() => setSourceType('yaml')}
                className="text-left p-5 rounded-xl border-2 border-gray-200 hover:border-blue-400 hover:bg-blue-50/30 transition-all group">
                <FileText size={24} className="text-gray-400 group-hover:text-blue-500 mb-2 transition-colors" />
                <div className="font-semibold text-gray-800 mb-0.5 text-sm">Upload YAML</div>
                <div className="text-xs text-gray-500">Generic YAML flat arrays. Full mapping required.</div>
              </button>
            </div>
          </div>
        </div>
      )}

      {sourceType === 'file' && (
        <Step1_FileUpload onReady={onSourceReady} onBack={() => setSourceType(null)} />
      )}
      {sourceType === 'sql' && (
        <Step1_SqlConnect onReady={onSourceReady} onBack={() => setSourceType(null)} />
      )}
      {sourceType === 'dbt' && (
        <Step1_VocabUpload
          onReady={onSourceReady}
          onBack={() => setSourceType(null)}
          vocabType="dbt"
          endpoint="/mb/dbt/parse"
          accept=".yaml,.yml"
          label="dbt schema.yml"
          hint="Drop your dbt schema.yml here — dimension mappings will be pre-filled from your model."
        />
      )}
      {sourceType === 'osi' && (
        <Step1_VocabUpload
          onReady={onSourceReady}
          onBack={() => setSourceType(null)}
          vocabType="osi"
          endpoint="/mb/osi/parse"
          accept=".yaml,.yml,.json"
          label="OSI model"
          hint="Drop your OSI YAML or JSON model here."
        />
      )}
      {sourceType === 'json' && (
        <Step1_VocabUpload
          onReady={onSourceReady}
          onBack={() => setSourceType(null)}
          vocabType="json"
          endpoint="/mb/upload"
          accept=".json"
          label="JSON file"
          hint="Drop a flat JSON array here. Common envelope shapes (data, results, items) are unwrapped automatically."
        />
      )}
      {sourceType === 'yaml' && (
        <Step1_VocabUpload
          onReady={onSourceReady}
          onBack={() => setSourceType(null)}
          vocabType="yaml"
          endpoint="/mb/upload"
          accept=".yaml,.yml"
          label="YAML file"
          hint="Drop a flat YAML array here. Full column mapping required."
        />
      )}
    </div>
  );
}

// ── File upload sub-panel ────────────────────────────────────────────────────

function Step1_FileUpload({ onReady, onBack }) {
  const [dragging, setDragging] = useState(false);
  const [file, setFile]         = useState(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const inputRef = useRef();

  const handleFile = useCallback(async (f) => {
    if (!f) return;
    const ext = f.name.split('.').pop().toLowerCase();
    if (!['csv', 'xlsx', 'xls'].includes(ext)) {
      setError('Please upload a CSV or Excel file.');
      return;
    }
    setFile(f);
    setError(null);
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append('file', f);
      // TODO: backend endpoint POST /api/mb/upload
      const r = await fetch(`${API_URL}/mb/upload`, { method: 'POST', body: fd });
      if (!r.ok) throw new Error(`Upload failed: ${r.status}`);
      const data = await r.json();
      onReady({
        type:         'file',
        file:         f,
        format:       ext === 'csv' ? 'csv' : 'excel',
        columns:      data.columns,
        source_token: data.upload_token,
        label:        f.name,
      });
    } catch (e) {
      setError(`Couldn't read the file: ${e.message}`);
      setFile(null);
    } finally {
      setLoading(false);
    }
  }, [onReady]);

  // Native drop handler — used in dev (Firefox). WebView2 silently empties
  // dataTransfer.files, so in the Tauri bundle we use the Tauri event instead.
  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  }, [handleFile]);

  // Tauri drag-drop — uses onDragDropEvent (Tauri v2 proper API).
  // Falls back gracefully in dev (Firefox) via .catch().
  const dropZoneRef = useRef();
  const [pendingDropPath, setPendingDropPath] = useState(null);

  const loadDroppedFile = () => {
    if (!pendingDropPath) return;
    const filePath = pendingDropPath;
    setPendingDropPath(null);
    const fileName = filePath.split(/[\/]/).pop();
    setLoading(true);
    setError(null);
    fetch(`${API_URL}/mb/upload_path`.replace('localhost', '127.0.0.1'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_path: filePath }),
    })
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e)))
      .then(data => {
        const ext = fileName.split('.').pop().toLowerCase();
        setFile({ name: fileName, size: 0 });
        onReady({
          type:         'file',
          format:       ext === 'csv' ? 'csv' : 'excel',
          columns:      data.columns,
          source_token: data.upload_token,
          row_count:    data.row_count,
          label:        fileName,
          source_label: fileName,
          local_path:   filePath,
        });
      })
      .catch(e => setError(`Could not load file: ${e?.detail || e?.message || String(e)}`))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    let unlisten;
    import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) => {
        return getCurrentWebview().onDragDropEvent((event) => {
          const { type, paths } = event.payload || {};
          if (type === 'enter' || type === 'over') { setDragging(true);  return; }
          if (type === 'leave' || type === 'cancel') { setDragging(false); return; }
          if (type !== 'drop' || !paths?.length) return;
          setDragging(false);
          // Store path in state — fetch happens in useEffect (Tauri event
          // callbacks cannot make fetch requests in WebView2 context)
          setPendingDropPath(paths[0]);
        });
      })
      .then(fn => {
        unlisten = fn;
      })
      .catch(err => console.log('[MB drop] not in Tauri context', err));
    return () => { if (unlisten) unlisten(); };
  }, [onReady]);

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 mb-4">
        <ChevronLeft size={13} /> Back
      </button>

      {pendingDropPath && (
        <div className="mb-3 flex items-center gap-3 p-3 bg-blue-50 border border-blue-200 rounded-lg">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-blue-900 truncate">
              {pendingDropPath.split(/[\/]/).pop()}
            </p>
            <p className="text-xs text-blue-600 truncate">{pendingDropPath}</p>
          </div>
          <button
            onClick={loadDroppedFile}
            className="shrink-0 px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            Load file
          </button>
          <button
            onClick={() => setPendingDropPath(null)}
            className="shrink-0 text-blue-400 hover:text-blue-600 text-xs"
          >
            ✕
          </button>
        </div>
      )}

      <div
        ref={dropZoneRef}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => !loading && inputRef.current?.click()}
        className={`relative border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-all
          ${dragging          ? 'border-blue-400 bg-blue-50 scale-[1.01]'        : ''}
          ${file && !loading  ? 'border-emerald-300 bg-emerald-50'               : ''}
          ${!file && !dragging ? 'border-gray-200 hover:border-blue-300 hover:bg-blue-50/30' : ''}
        `}
      >
        <input ref={inputRef} type="file" accept=".csv,.xlsx,.xls" className="hidden"
          onChange={e => handleFile(e.target.files[0])} />
        {loading ? (
          <div className="flex flex-col items-center gap-3">
            <Loader2 size={40} className="text-blue-400 animate-spin" />
            <p className="text-sm text-gray-500">Reading your file…</p>
          </div>
        ) : file ? (
          <div className="flex flex-col items-center gap-3">
            <CheckCircle2 size={40} className="text-emerald-500" />
            <div>
              <p className="font-semibold text-gray-900">{file.name}</p>
              <p className="text-xs text-gray-500 mt-0.5">{(file.size / 1024).toFixed(0)} KB</p>
            </div>
            <button onClick={e => { e.stopPropagation(); setFile(null); setError(null); }}
              className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1">
              <X size={12} /> Choose a different file
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <Upload size={40} className="text-gray-300" />
            <div>
              <p className="font-semibold text-gray-700">Drop your file here</p>
              <p className="text-sm text-gray-400 mt-1">or click to browse — CSV or Excel</p>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="mt-3 flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertTriangle size={14} /> {error}
        </div>
      )}
    </div>
  );
}

// ── Vocabulary upload sub-panel (OSI, dbt, JSON, YAML) ───────────────────────
// Generic drop-zone for any vocabulary-type upload. vocabType, endpoint, accept,
// label, and hint are passed as props so this one component handles all four paths.

function Step1_VocabUpload({ onReady, onBack, vocabType, endpoint, accept, label, hint }) {
  const [dragging, setDragging] = useState(false);
  const [file, setFile]         = useState(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [pendingDropPath, setPendingDropPath] = useState(null);
  const inputRef = useRef();

  // Process dropped file path from React context, not Tauri event callback
  useEffect(() => {
    if (!pendingDropPath) return;
    const filePath = pendingDropPath;
    setPendingDropPath(null);
    const fileName = filePath.split(/[\\/]/).pop();
    setLoading(true);
    setError(null);
    fetch(`${API_URL}/mb/upload_path`.replace('localhost', '127.0.0.1'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_path: filePath }),
    })
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e)))
      .then(data => {
        setFile({ name: fileName, size: 0 });
        onReady({
          type:            vocabType,
          source_type:     data.source_type || vocabType,
          format:          vocabType,
          columns:         data.columns,
          source_token:    data.upload_token,
          row_count:       data.row_count,
          label:           fileName,
          source_label:    fileName,
          local_path:      filePath,
          nucleus_hints:   data.nucleus_hints   || {},
          lens_candidates: data.lens_candidates || {},
          osi_meta:        data.osi_meta        || null,
          dbt_meta:        data.dbt_meta        || null,
          model_count:     data.model_count     || null,
          parse_warnings:  data.parse_warnings  || [],
        });
      })
      .catch(e => setError(`Drop failed: ${e?.detail || e?.message || String(e)}`))
      .finally(() => setLoading(false));
  }, [pendingDropPath, onReady, vocabType]);

  const handleFile = useCallback(async (f) => {
    if (!f) return;
    setFile(f);
    setError(null);
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const r = await fetch(`${API_URL}${endpoint}`, { method: 'POST', body: fd });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.detail || `Upload failed: ${r.status}`);
      }
      const data = await r.json();

      // Build sourceData shape — vocab sources pass source_type so
      // the wizard can skip step 3 and pre-fill nucleus / lens.
      onReady({
        type:            vocabType,
        source_type:     data.source_type || vocabType,
        file,
        format:          vocabType,
        columns:         data.columns,
        source_token:    data.upload_token,
        label:           f.name,
        // vocabulary-specific extras (used by step 4 / 5 pre-fill)
        nucleus_hints:   data.nucleus_hints   || {},
        lens_candidates: data.lens_candidates || {},
        osi_meta:        data.osi_meta        || null,
        dbt_meta:        data.dbt_meta        || null,
        model_count:     data.model_count     || null,
        parse_warnings:  data.parse_warnings  || [],
      });
    } catch (e) {
      setError(`Couldn't read the file: ${e.message}`);
      setFile(null);
    } finally {
      setLoading(false);
    }
  }, [onReady, vocabType, endpoint]);

  // Native drop handler — used in dev (Firefox). WebView2 silently empties
  // dataTransfer.files, so in the Tauri bundle we use the Tauri event instead.
  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  }, [handleFile]);

  // Tauri drag-drop — uses onDragDropEvent (Tauri v2 proper API).
  // Passes the native path directly to the backend; no blob round-trip.
  // Falls back to native DOM drop in dev (Firefox, no window.__TAURI__).
  const dropZoneRef = useRef();
  useEffect(() => {
    let unlisten;
    import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          console.log('[MB vocab drop] payload', event.payload);
          const { type, paths } = event.payload || {};
          if (type === 'enter' || type === 'over') { setDragging(true);  return; }
          if (type === 'leave' || type === 'cancel') { setDragging(false); return; }
          if (type !== 'drop' || !paths?.length) return;
          setDragging(false);
          // Store path in state — fetch happens in useEffect (Tauri event
          // callbacks cannot make fetch requests in WebView2 context)
          setPendingDropPath(paths[0]);
        })
      )
      .then(fn => {
        unlisten = fn;
        console.log('[MB vocab drop] listener registered');
      })
      .catch(err => console.log('[MB vocab drop] not in Tauri context', err));
    return () => { if (unlisten) unlisten(); };
  }, [onReady]);

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 mb-4">
        <ChevronLeft size={13} /> Back
      </button>

      <div
        ref={dropZoneRef}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => !loading && inputRef.current?.click()}
        className={`relative border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-all
          ${dragging           ? 'border-purple-400 bg-purple-50 scale-[1.01]'         : ''}
          ${file && !loading   ? 'border-emerald-300 bg-emerald-50'                    : ''}
          ${!file && !dragging ? 'border-gray-200 hover:border-purple-300 hover:bg-purple-50/30' : ''}
        `}
      >
        <input ref={inputRef} type="file" accept={accept} className="hidden"
          onChange={e => handleFile(e.target.files[0])} />
        {loading ? (
          <div className="flex flex-col items-center gap-3">
            <Loader2 size={40} className="text-purple-400 animate-spin" />
            <p className="text-sm text-gray-500">Parsing your {label}…</p>
          </div>
        ) : file ? (
          <div className="flex flex-col items-center gap-3">
            <CheckCircle2 size={40} className="text-emerald-500" />
            <div>
              <p className="font-semibold text-gray-900">{file.name}</p>
              <p className="text-xs text-gray-500 mt-0.5">{(file.size / 1024).toFixed(0)} KB</p>
            </div>
            <button onClick={e => { e.stopPropagation(); setFile(null); setError(null); }}
              className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1">
              <X size={12} /> Choose a different file
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <Upload size={40} className="text-gray-300" />
            <div>
              <p className="font-semibold text-gray-700">Drop your {label} here</p>
              <p className="text-sm text-gray-400 mt-1">{hint}</p>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="mt-3 flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertTriangle size={14} /> {error}
        </div>
      )}
    </div>
  );
}

// ── SQL connection sub-panel ─────────────────────────────────────────────────

function Step1_SqlConnect({ onReady, onBack }) {
  const [connStr,    setConnStr]    = useState('');
  const [tableName,  setTableName]  = useState('');
  const [schemaName, setSchemaName] = useState('public');
  const [showConn,   setShowConn]   = useState(false);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState(null);

  const canConnect = connStr.trim().length > 0 && tableName.trim().length > 0;

  const handleConnect = async () => {
    setLoading(true);
    setError(null);
    try {
      // TODO: backend endpoint POST /api/mb/introspect
      // Python uses SQLAlchemy read-only — never writes, never exports to CSV.
      // Returns columns from information_schema + LIMIT 10 sample rows.
      const r = await fetch(`${API_URL}/mb/introspect`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connection_string: connStr,
          table_name:        tableName,
          schema_name:       schemaName || 'public',
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.detail || `Connection failed: ${r.status}`);
      }
      const data = await r.json();
      onReady({
        type:         'sql',
        table_name:   tableName,
        schema_name:  schemaName || 'public',
        columns:      data.columns,
        row_count:    data.row_count,
        source_token: data.introspect_token,
        label:        `${schemaName || 'public'}.${tableName}`,
        // connection_string intentionally NOT forwarded to build spec —
        // Python holds the live connection via the introspect_token session.
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 mb-4">
        <ChevronLeft size={13} /> Back
      </button>

      {/* Security callout — prominent, not buried */}
      <div className="flex items-start gap-3 p-3 rounded-lg bg-emerald-50 border border-emerald-200 mb-5">
        <CheckCircle2 size={15} className="text-emerald-500 mt-0.5 flex-shrink-0" />
        <p className="text-xs text-emerald-800">
          <strong>Your data stays in your database.</strong> We connect read-only, look at the column
          names and a small sample, then disconnect. Nothing is exported. The output is a SQL script
          your DBA runs — your data never moves.
        </p>
      </div>

      <div className="space-y-4">
        {/* Connection string */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Connection string
          </label>
          <div className="relative">
            <input
              type={showConn ? 'text' : 'password'}
              value={connStr}
              onChange={e => setConnStr(e.target.value)}
              placeholder="postgresql://user:password@host:5432/dbname"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 pr-10 text-sm font-mono
                focus:outline-none focus:ring-2 focus:ring-blue-300"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              onClick={() => setShowConn(v => !v)}
              className="absolute right-2.5 top-2.5 text-gray-400 hover:text-gray-600"
              type="button"
            >
              {showConn ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-1">
            Standard libpq format. Sent to your local Python server — never to the cloud.
          </p>
        </div>

        {/* Schema + table */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Schema</label>
            <input
              type="text"
              value={schemaName}
              onChange={e => setSchemaName(e.target.value)}
              placeholder="public"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono
                focus:outline-none focus:ring-2 focus:ring-blue-300"
            />
          </div>
          <div className="col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Table name</label>
            <div className="relative">
              <Table2 size={14} className="absolute left-3 top-2.5 text-gray-400" />
              <input
                type="text"
                value={tableName}
                onChange={e => setTableName(e.target.value)}
                placeholder="your_table"
                className="w-full border border-gray-200 rounded-lg pl-8 pr-3 py-2 text-sm font-mono
                  focus:outline-none focus:ring-2 focus:ring-blue-300"
              />
            </div>
          </div>
        </div>

        {/* Connect button */}
        <button
          onClick={handleConnect}
          disabled={!canConnect || loading}
          className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold transition-all
            ${canConnect && !loading
              ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm'
              : 'bg-gray-100 text-gray-400 cursor-not-allowed'}`}
        >
          {loading
            ? <><Loader2 size={15} className="animate-spin" /> Connecting…</>
            : <><Server size={15} /> Read schema (read-only)</>}
        </button>
      </div>

      {error && (
        <div className="mt-3 flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — Map Columns
// ─────────────────────────────────────────────────────────────────────────────

function Step2_MapColumns({ columns, onNext, onBack }) {
  // mapping[i] = { column, dimension, semantic_key }
  const [mapping, setMapping] = useState(() =>
    columns.map(col => ({
      column:        col.name,
      dimension:     col.suggested_dim  || 'skip',
      semantic_key:  col.suggested_key  || col.name.toLowerCase().replace(/\s+/g, '_'),
      samples:       col.samples || [],
    }))
  );

  const updateRow = (i, field, value) => {
    setMapping(prev => prev.map((r, idx) => idx === i ? { ...r, [field]: value } : r));
  };

  const mapped = mapping.filter(r => r.dimension !== 'skip');
  const canContinue = mapped.length > 0;

  return (
    <div>
      <h2 className="text-xl font-bold text-gray-900 mb-1">What does each column mean?</h2>
      <p className="text-sm text-gray-500 mb-6">
        Tell us which dimension each column belongs to. We've made guesses — correct anything that looks wrong.
        Columns set to <span className="font-mono text-xs bg-gray-100 px-1 rounded">skip</span> won't be imported.
      </p>

      {/* Dimension reference */}
      <div className="grid grid-cols-3 gap-2 mb-5">
        {DIMENSIONS.map(dim => {
          const c = DIM_COLORS[dim];
          return (
            <div key={dim} className={`rounded-lg border px-3 py-2 ${c.bg} ${c.border}`}>
              <span className={`text-xs font-bold ${c.text}`}>{dim}</span>
              <p className="text-xs text-gray-500 mt-0.5">{DIM_DESCRIPTIONS[dim]}</p>
            </div>
          );
        })}
      </div>

      {/* Column mapping table */}
      <div className="rounded-xl border border-gray-200 overflow-hidden">
        {/* Header */}
        <div className="grid grid-cols-12 gap-0 bg-gray-50 border-b border-gray-200 px-4 py-2">
          <div className="col-span-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Column</div>
          <div className="col-span-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Sample values</div>
          <div className="col-span-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">Dimension</div>
          <div className="col-span-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Field name</div>
        </div>

        {mapping.map((row, i) => (
          <div key={row.column}
            className={`grid grid-cols-12 gap-0 px-4 py-3 items-start border-b border-gray-100 last:border-b-0 transition-colors
              ${row.dimension === 'skip' ? 'opacity-40' : ''}`}>

            {/* Column name */}
            <div className="col-span-3 pr-3">
              <span className="text-sm font-mono font-medium text-gray-800">{row.column}</span>
            </div>

            {/* Sample values */}
            <div className="col-span-4 pr-3">
              <div className="flex flex-wrap gap-1">
                {row.samples.slice(0, 3).map((s, si) => (
                  <span key={si} className="text-xs bg-gray-100 text-gray-600 rounded px-1.5 py-0.5 max-w-[100px] truncate">
                    {clamp(s, 20)}
                  </span>
                ))}
              </div>
            </div>

            {/* Dimension picker */}
            <div className="col-span-2 pr-3">
              <select
                value={row.dimension}
                onChange={e => updateRow(i, 'dimension', e.target.value)}
                className="w-full text-xs rounded border border-gray-200 bg-white px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-300"
              >
                <option value="skip">skip</option>
                {DIMENSIONS.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>

            {/* Semantic key */}
            <div className="col-span-3">
              <input
                type="text"
                value={row.semantic_key}
                disabled={row.dimension === 'skip'}
                onChange={e => updateRow(i, 'semantic_key', e.target.value.toLowerCase().replace(/\s+/g, '_'))}
                className="w-full text-xs rounded border border-gray-200 px-2 py-1.5 font-mono
                  focus:outline-none focus:ring-2 focus:ring-blue-300
                  disabled:bg-gray-50 disabled:text-gray-400"
                placeholder="field_name"
              />
            </div>
          </div>
        ))}
      </div>

      {/* Summary */}
      <div className="mt-3 flex items-center gap-2 flex-wrap">
        {mapped.length > 0 ? (
          <>
            <span className="text-xs text-gray-500">{mapped.length} column{mapped.length !== 1 ? 's' : ''} mapped:</span>
            {DIMENSIONS.filter(d => mapped.some(r => r.dimension === d)).map(d => (
              <DimPill key={d} dim={d} />
            ))}
          </>
        ) : (
          <span className="text-xs text-amber-600">Map at least one column to continue.</span>
        )}
      </div>

      <NavButtons step={2} onBack={onBack}
        onNext={() => onNext(mapping.filter(r => r.dimension !== 'skip'))}
        nextDisabled={!canContinue} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — Pre-Ingest Review
// ─────────────────────────────────────────────────────────────────────────────

function Step3_Review({ mapping, uploadToken, onNext, onBack }) {
  const [flags, setFlags]           = useState(null);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState(null);
  const [acked, setAcked]           = useState(new Set());

  const loadFlags = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // TODO: backend endpoint POST /api/mb/review
      const r = await fetch(`${API_URL}/mb/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_token: uploadToken, columns_mapped: mapping }),
      });
      if (!r.ok) throw new Error(`Review failed: ${r.status}`);
      const data = await r.json();
      setFlags(data.flags || []);
    } catch(e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [mapping, uploadToken]);

  // Auto-load flags when step mounts
  React.useEffect(() => { loadFlags(); }, [loadFlags]);

  const warnings = (flags || []).filter(f => f.severity === 'warning');
  const infos    = (flags || []).filter(f => f.severity === 'info');
  const allAcked = flags && flags.length > 0 && flags.every(f => acked.has(f.id));
  const noFlags  = flags && flags.length === 0;

  const toggleAck = (id) => setAcked(prev => {
    const n = new Set(prev);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  const ackAll = () => setAcked(new Set((flags || []).map(f => f.id)));

  return (
    <div>
      <h2 className="text-xl font-bold text-gray-900 mb-1">Review before importing</h2>
      <p className="text-sm text-gray-500 mb-6">
        We've looked at your data. Here's what you should know before it goes in.
        These are heads-up notices, not errors — you decide what matters.
      </p>

      {loading && (
        <div className="flex items-center gap-3 py-12 justify-center text-gray-400">
          <Loader2 size={20} className="animate-spin" />
          <span className="text-sm">Analyzing your data…</span>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-3 p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          <AlertTriangle size={16} />
          <span>{error}</span>
          <button onClick={loadFlags} className="ml-auto flex items-center gap-1 text-red-600 hover:text-red-800">
            <RefreshCw size={13} /> Retry
          </button>
        </div>
      )}

      {flags && flags.length > 0 && (
        <>
          {/* Ack all button if multiple flags */}
          {flags.length > 1 && !allAcked && (
            <button onClick={ackAll}
              className="mb-3 text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1">
              <CheckCircle2 size={12} /> Acknowledge all
            </button>
          )}

          {warnings.length > 0 && (
            <div className="mb-4">
              <div className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-2">
                ⚠ Heads up ({warnings.length})
              </div>
              <div className="space-y-2">
                {warnings.map(f => (
                  <FlagCard key={f.id} flag={f} acknowledged={acked.has(f.id)} onAcknowledge={toggleAck} />
                ))}
              </div>
            </div>
          )}

          {infos.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-blue-600 uppercase tracking-wide mb-2">
                ℹ Just so you know ({infos.length})
              </div>
              <div className="space-y-2">
                {infos.map(f => (
                  <FlagCard key={f.id} flag={f} acknowledged={acked.has(f.id)} onAcknowledge={toggleAck} />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {noFlags && (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <CheckCircle2 size={40} className="text-emerald-400" />
          <div>
            <p className="font-semibold text-gray-700">Looks clean</p>
            <p className="text-sm text-gray-400 mt-1">No issues found. You're good to continue.</p>
          </div>
        </div>
      )}

      <NavButtons step={3} onBack={onBack} onNext={onNext}
        nextDisabled={loading || !!error || (flags && flags.length > 0 && !allAcked)}
        nextLabel={noFlags ? 'Continue' : allAcked ? 'Continue' : `Acknowledge all to continue`} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4 — Nucleus Declaration
// ─────────────────────────────────────────────────────────────────────────────

function Step4_Nucleus({ columns, nucleusHint, onNext, onBack }) {
  const [nucleusType, setNucleusType] = useState('single');

  // Pre-select from hint if available, otherwise fall back to first column
  const hintCol = nucleusHint && columns.find(c => c.column === nucleusHint)
    ? nucleusHint
    : columns[0]?.column || '';

  const [singleCol,    setSingleCol]    = useState(hintCol);
  const [compoundCols, setCompoundCols] = useState(
    columns.length >= 2 ? [columns[0].column, columns[1].column] : [columns[0]?.column || '']
  );
  const [separator, setSeparator] = useState('-');
  const [prefix, setPrefix]       = useState('');
  const [usePrefix, setUsePrefix] = useState(false);

  const colNames = columns.map(c => c.column);

  // Preview: show a couple of example IDs using sample values
  const previewIds = (() => {
    const sampleRows = columns[0]?.samples || [];
    return sampleRows.slice(0, 3).map((_, i) => {
      let base;
      if (nucleusType === 'single') {
        const col = columns.find(c => c.column === singleCol);
        base = col?.samples[i] ?? `row_${i+1}`;
      } else {
        base = compoundCols
          .map(cn => columns.find(c => c.column === cn)?.samples[i] ?? '')
          .join(separator);
      }
      return usePrefix && prefix ? `${prefix}:${base}` : base;
    });
  })();

  const nucleusSpec = nucleusType === 'single'
    ? { type: 'single', columns: [singleCol], separator: '', prefix: usePrefix ? prefix : '' }
    : { type: 'compound', columns: compoundCols, separator, prefix: usePrefix ? prefix : '' };

  const canContinue = nucleusType === 'single'
    ? !!singleCol
    : compoundCols.length >= 2 && compoundCols.every(c => !!c);

  return (
    <div>
      <h2 className="text-xl font-bold text-gray-900 mb-1">What makes each row unique?</h2>
      <p className="text-sm text-gray-500 mb-6">
        Pick the column (or combination of columns) that gives each record a stable identity.
        This becomes the entity ID — once set, it doesn't change.
      </p>

      {/* Type selector */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        {[
          { val: 'single',   icon: '1️⃣', label: 'Single column',    desc: 'One column is the unique ID (e.g. release_id, docket_number)' },
          { val: 'compound', icon: '2️⃣', label: 'Combined columns', desc: 'Two columns together make it unique (e.g. client + matter number)' },
        ].map(opt => (
          <button key={opt.val} onClick={() => setNucleusType(opt.val)}
            className={`text-left p-4 rounded-xl border-2 transition-all
              ${nucleusType === opt.val ? 'border-blue-400 bg-blue-50' : 'border-gray-200 hover:border-gray-300'}`}>
            <div className="text-lg mb-1">{opt.icon}</div>
            <div className="text-sm font-semibold text-gray-800">{opt.label}</div>
            <div className="text-xs text-gray-500 mt-0.5">{opt.desc}</div>
          </button>
        ))}
      </div>

      {/* Single column picker */}
      {nucleusType === 'single' && (
        <div className="mb-5">
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Identity column</label>
          <select value={singleCol} onChange={e => setSingleCol(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300">
            {colNames.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      )}

      {/* Compound column picker */}
      {nucleusType === 'compound' && (
        <div className="mb-5">
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Columns to combine
          </label>
          <div className="space-y-2 mb-3">
            {compoundCols.map((col, i) => (
              <div key={i} className="flex items-center gap-2">
                {i > 0 && (
                  <span className="text-xs text-gray-400 font-mono w-6 text-center">{separator}</span>
                )}
                <select value={col}
                  onChange={e => setCompoundCols(prev => prev.map((c, j) => j === i ? e.target.value : c))}
                  className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300">
                  {colNames.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                {compoundCols.length > 2 && (
                  <button onClick={() => setCompoundCols(prev => prev.filter((_, j) => j !== i))}
                    className="text-gray-400 hover:text-red-500"><X size={14} /></button>
                )}
              </div>
            ))}
          </div>
          {compoundCols.length < 4 && (
            <button onClick={() => setCompoundCols(prev => [...prev, colNames[0]])}
              className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1">
              <Plus size={12} /> Add another column
            </button>
          )}
          <div className="mt-3">
            <label className="block text-xs font-medium text-gray-600 mb-1">Separator</label>
            <div className="flex gap-2">
              {['-', '/', ':', '_', '|'].map(s => (
                <button key={s} onClick={() => setSeparator(s)}
                  className={`px-3 py-1.5 rounded border text-sm font-mono transition-colors
                    ${separator === s ? 'bg-blue-600 text-white border-blue-600' : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Optional prefix */}
      <div className="mb-6">
        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
          <input type="checkbox" checked={usePrefix} onChange={e => setUsePrefix(e.target.checked)}
            className="rounded border-gray-300 text-blue-600 accent-blue-600" />
          Add a namespace prefix (optional)
        </label>
        {usePrefix && (
          <div className="mt-2">
            <input type="text" value={prefix} onChange={e => setPrefix(e.target.value.toLowerCase().replace(/\s+/g, ''))}
              placeholder="e.g. discogs, marc, matter"
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono w-48 focus:outline-none focus:ring-2 focus:ring-blue-300" />
            <p className="text-xs text-gray-400 mt-1">Makes IDs globally unique across datasets. E.g. <code>discogs:13988431</code></p>
          </div>
        )}
      </div>

      {/* ID preview */}
      {previewIds.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Preview — first few entity IDs
          </div>
          <div className="space-y-1">
            {previewIds.map((id, i) => (
              <div key={i} className="text-sm font-mono text-gray-700 bg-white rounded border border-gray-200 px-3 py-1.5">
                {id || <span className="text-red-400 italic">empty — try a different column</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      <NavButtons step={4} onBack={onBack} onNext={() => onNext(nucleusSpec)} nextDisabled={!canContinue} />
    </div>
  );
}

// ── WS-4 patch for Step5_NameAndTarget ──────────────────────────────────────
// Adds "Compare with existing dataset" lens chip section.
// Fetches /api/schemas on mount, extracts unique lens_ids, surfaces as chips.
// Selecting a chip locks lens_id and auto-suggests a unique output_name.
// Locking is reversible — × clears the lock and restores free-text input.
//
// Changes from current Step5_NameAndTarget:
//   + useEffect import (if not already present above)
//   + existingLenses state   — string[] from /api/schemas
//   + lensLocked state       — bool, true when user selected an existing lens
//   + "Compare with existing dataset" chip section (always rendered)
//   + lens name input: readonly + lock indicator when lensLocked
//   + unlock (×) button clears lensLocked
//   No changes to output name input, target picker, or NavButtons.

function Step5_NameAndTarget({ sourceData, onNext, onBack }) {
  const isSql = sourceData?.type === 'sql';
  const isDbt = sourceData?.type === 'dbt';

  const dbtModelName = isDbt && sourceData.dbt_meta
    ? Object.keys(sourceData.dbt_meta)[0]
    : null;

  const defaultName = (dbtModelName || sourceData?.label || 'dataset')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9_]/gi, '_')
    .toLowerCase();

  // Lens candidates from dbt metrics block
  const lensCandidates = isDbt && sourceData.lens_candidates
    ? Object.values(sourceData.lens_candidates).flat().map(c => c.lens_id)
    : [];

  const [lensName,      setLensName]      = useState(defaultName);
  const [outputName,    setOutputName]    = useState(defaultName);
  const [backend,       setBackend]       = useState(isSql ? 'postgres-views' : 'duckdb');

  // WS-4 — existing lens state
  const [existingLenses, setExistingLenses] = useState([]);   // lens_ids from loaded substrates
  const [lensLocked,     setLensLocked]     = useState(false); // true when user picked existing

  // Fetch existing lens_ids from Reckoner on mount
  useEffect(() => {
    fetch('/api/schemas')
      .then(r => r.ok ? r.json() : { schemas: [] })
      .then(data => {
        const ids = [...new Set(
          (data.schemas || [])
            .map(s => s.lens_id)
            .filter(Boolean)
        )].sort();
        setExistingLenses(ids);
      })
      .catch(() => {}); // non-fatal — chips just won't appear
  }, []);

  // When user picks an existing lens:
  // - lock lens_id to that value
  // - auto-suggest output_name = sourceFileStem + "_" + existing lens name
  //   (keeps files distinct; user can edit freely)
  const selectExistingLens = (id) => {
    setLensName(id);
    setLensLocked(true);
    const sourceStem = defaultName;
    // Avoid suggesting a name identical to the lens (would collide with first substrate)
    const suggested = sourceStem === id ? `${id}_2` : `${sourceStem}_${id}`;
    setOutputName(suggested.replace(/[^a-z0-9_]/g, '_').slice(0, 64));
  };

  const unlockLens = () => {
    setLensLocked(false);
    setLensName(defaultName);
    setOutputName(defaultName);
  };

  const fileTargets = [
    { id: 'duckdb',           icon: '🦆', label: 'DuckDB',     desc: 'Single file — personal and workstation use. Ready for Reckoner immediately.',  available: true  },
    { id: 'postgres-import',  icon: '🐘', label: 'PostgreSQL', desc: 'Import package — DDL + CSV + load.sh. Shared and production use.',              available: false },
    { id: 'sqlserver-import', icon: '🗄',  label: 'SQL Server', desc: 'Import package for enterprise deployments.',                                    available: false },
  ];

  const sqlTargets = [
    { id: 'postgres-views',  icon: '🐘', label: 'Materialized views (recommended)',
      desc: 'Data stays exactly where it is. We generate a SQL script your DBA runs. Nothing moves.',  available: true  },
    { id: 'postgres-import', icon: '📦', label: 'Import package',
      desc: 'Extracts data into a separate SNF schema. Use when you want a clean copy.',               available: false },
  ];

  const targets = isSql ? sqlTargets : fileTargets;

  return (
    <div>
      <h2 className="text-xl font-bold text-gray-900 mb-1">Name your dataset</h2>
      <p className="text-sm text-gray-500 mb-6">
        Give it a name you'll recognize in Reckoner.
        {isSql
          ? " We'll generate a SQL script your DBA reviews and runs."
          : " We'll create a .duckdb file you can drop right in."}
      </p>

      <div className="space-y-5">
        {/* Dataset name */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Dataset name
            <span className="text-gray-400 font-normal ml-1">(shown in Reckoner)</span>
          </label>

          {/* Locked state — lens_id matched to existing substrate */}
          {lensLocked ? (
            <div className="flex items-center gap-2">
              <div className="flex-1 flex items-center gap-2 border border-teal-300 bg-teal-50
                rounded-lg px-3 py-2">
                <span className="text-xs font-medium text-teal-600 shrink-0">matched</span>
                <span className="text-sm font-mono text-teal-800 flex-1">{lensName}</span>
              </div>
              <button onClick={unlockLens}
                className="text-xs text-gray-400 hover:text-gray-600 px-2 py-2
                  rounded-lg hover:bg-gray-100 transition-colors"
                title="Use a different name">
                ×
              </button>
            </div>
          ) : (
            <input type="text" value={lensName}
              onChange={e => {
                const v = e.target.value.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
                setLensName(v);
                setOutputName(v);
              }}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono
                focus:outline-none focus:ring-2 focus:ring-blue-300"
              placeholder="my_dataset" />
          )}
          <p className="text-xs text-gray-400 mt-1">Lowercase letters, numbers, and underscores only.</p>

          {/* dbt lens candidate chips */}
          {lensCandidates.length > 0 && (
            <div className="mt-2">
              <p className="text-xs text-gray-400 mb-1.5">Suggestions from your dbt metrics:</p>
              <div className="flex flex-wrap gap-1.5">
                {lensCandidates.map(name => (
                  <button key={name}
                    onClick={() => { setLensName(name); setOutputName(name); setLensLocked(false); }}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-all
                      ${lensName === name
                        ? 'bg-purple-100 border-purple-300 text-purple-700 font-medium'
                        : 'bg-gray-50 border-gray-200 text-gray-500 hover:border-purple-300 hover:text-purple-600'
                      }`}>
                    {name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* WS-4 — Compare with existing dataset */}
          <div className="mt-3 pt-3 border-t border-gray-100">
            <p className="text-xs font-medium text-gray-500 mb-1.5">
              Compare with existing dataset
              <span className="font-normal text-gray-400 ml-1">
                — use the same lens to enable diff and set operations
              </span>
            </p>
            {existingLenses.length === 0 ? (
              <p className="text-xs text-gray-400 italic">
                No substrates loaded yet — ingest your first dataset to enable comparison.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {existingLenses.map(id => (
                  <button key={id}
                    onClick={() => selectExistingLens(id)}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-all
                      ${lensLocked && lensName === id
                        ? 'bg-teal-100 border-teal-400 text-teal-700 font-medium'
                        : 'bg-gray-50 border-gray-200 text-gray-500 hover:border-teal-300 hover:text-teal-600'
                      }`}>
                    {id}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Output name */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            {isSql ? 'Output script name' : 'Output file'}
          </label>
          <div className="flex items-center gap-2">
            <input type="text" value={outputName}
              onChange={e => setOutputName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
              className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono
                focus:outline-none focus:ring-2 focus:ring-blue-300"
              placeholder="my_dataset" />
            <span className="text-sm text-gray-400 font-mono">
              {isSql ? '_snf_views.sql' : '.duckdb'}
            </span>
          </div>
          <p className="text-xs text-gray-400 mt-1">
            {isSql
              ? 'Your DBA reviews this script and runs it. No data moves.'
              : 'Drop this file in your Reckoner substrate folder — it appears automatically.'}
          </p>
        </div>

        {/* Target picker */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Output format</label>
          <div className="grid grid-cols-1 gap-2">
            {targets.map(t => (
              <button key={t.id} onClick={() => t.available && setBackend(t.id)} disabled={!t.available}
                className={`flex items-center gap-4 p-4 rounded-xl border-2 text-left transition-all
                  ${!t.available ? 'border-gray-100 bg-gray-50 opacity-50 cursor-not-allowed' : ''}
                  ${t.available && backend === t.id ? 'border-blue-400 bg-blue-50' : ''}
                  ${t.available && backend !== t.id ? 'border-gray-200 hover:border-gray-300' : ''}
                `}>
                <span className="text-2xl">{t.icon}</span>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-gray-800">{t.label}</span>
                    {!t.available && (
                      <span className="text-xs bg-gray-200 text-gray-500 px-1.5 py-0.5 rounded">Coming soon</span>
                    )}
                    {t.available && backend === t.id && (
                      <span className="text-xs bg-blue-600 text-white px-1.5 py-0.5 rounded">Selected</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">{t.desc}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>

      <NavButtons step={5} onBack={onBack}
        onNext={() => onNext({ lens_id: lensName, output_name: outputName, backend })}
        nextDisabled={!lensName || !outputName} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 6 — Compile & Download
// ─────────────────────────────────────────────────────────────────────────────

function Step6_Compile({ buildSpec, onBack, onStartOver }) {
  const [status,    setStatus]    = useState('idle');
  const [result,    setResult]    = useState(null);
  const [error,     setError]     = useState(null);
  const [saving,    setSaving]    = useState(false);
  const [saved,     setSaved]     = useState(false);
  const [saveError, setSaveError] = useState(null);

  const compile = useCallback(async () => {
    setStatus('compiling');
    setError(null);
    try {
      const r = await fetch(`${API_URL}/mb/compile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildSpec),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.detail || `Compile failed: ${r.status}`);
      }
      const data = await r.json();
      setResult(data);
      setStatus('done');
    } catch(e) {
      setError(e.message);
      setStatus('error');
    }
  }, [buildSpec]);

  // Auto-start compile when step mounts
  React.useEffect(() => { compile(); }, [compile]);

  const saveToReckoner = async () => {
    if (!result?.download_url) return;
    const filename = result.download_url.split('/').pop();
    setSaving(true);
    setSaveError(null);
    try {
      const r = await fetch(`${API_URL}/mb/save-to-substrates/${filename}`, {
        method: 'POST',
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.detail || `Save failed: ${r.status}`);
      }
      setSaved(true);
    } catch(e) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h2 className="text-xl font-bold text-gray-900 mb-1">
        {status === 'done' ? 'Your dataset is ready.' : status === 'error' ? 'Something went wrong.' : 'Building your dataset…'}
      </h2>
      <p className="text-sm text-gray-500 mb-8">
        {status === 'done'
          ? saved
            ? 'Your substrate has been added to Reckoner. Switch to Reckoner and start querying.'
            : buildSpec.target.backend === 'postgres-views'
              ? 'Download the SQL script and give it to your DBA.'
              : 'Click below to add this substrate directly to Reckoner.'
          : status === 'error'
          ? 'See the error below. You can go back and fix the issue.'
          : 'Translating your data into SNF shape. This usually takes a few seconds.'}
      </p>

      {/* Compiling */}
      {status === 'compiling' && (
        <div className="flex flex-col items-center gap-4 py-16">
          <Loader2 size={48} className="text-blue-400 animate-spin" />
          <div className="text-center">
            <p className="font-medium text-gray-700">Compiling…</p>
            <p className="text-xs text-gray-400 mt-1">Reading, mapping, assigning entity IDs, writing substrate</p>
          </div>
        </div>
      )}

      {/* Error */}
      {status === 'error' && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="text-red-500 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-red-800 mb-1">Compile error</p>
              <p className="text-sm text-red-700 font-mono">{error}</p>
            </div>
          </div>
          <button onClick={compile}
            className="mt-4 flex items-center gap-1.5 text-sm text-red-600 hover:text-red-800">
            <RefreshCw size={13} /> Try again
          </button>
        </div>
      )}

      {/* Done */}
      {status === 'done' && result && (
        <div className="space-y-4">
          {/* Stats */}
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: 'Entities', value: result.entity_count?.toLocaleString() ?? '—' },
              { label: 'Facts',    value: result.fact_count?.toLocaleString()   ?? '—' },
              { label: 'Warnings', value: result.warnings?.length ?? 0           },
            ].map(s => (
              <div key={s.label} className="rounded-xl border border-gray-200 bg-gray-50 p-4 text-center">
                <div className="text-2xl font-bold text-gray-900">{s.value}</div>
                <div className="text-xs text-gray-500 mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>

          {/* Dimension breakdown */}
          {result.facts_by_dim && (
            <div className="rounded-xl border border-gray-200 p-4">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Facts by dimension</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(result.facts_by_dim).map(([dim, count]) => {
                  const c = DIM_COLORS[dim];
                  return (
                    <div key={dim} className={`rounded-lg border px-3 py-2 ${c?.bg} ${c?.border}`}>
                      <span className={`text-xs font-bold ${c?.text}`}>{dim}</span>
                      <span className="text-xs text-gray-600 ml-2">{count?.toLocaleString()}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Warnings */}
          {result.warnings?.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <div className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-2">
                ⚠ {result.warnings.length} warning{result.warnings.length !== 1 ? 's' : ''}
              </div>
              <ul className="space-y-1">
                {result.warnings.map((w, i) => (
                  <li key={i} className="text-xs text-amber-800">{w}</li>
                ))}
              </ul>
            </div>
          )}

          {/* SQL download (postgres-views path — browser download still works here) */}
          {buildSpec.target.backend === 'postgres-views' && (
            <button onClick={() => {
              const a = document.createElement('a');
              a.href = result.download_url;
              a.download = `${buildSpec.target.output_name}_snf_views.sql`;
              a.click();
            }}
              className="w-full flex items-center justify-center gap-3 py-4 px-6 rounded-xl
                bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-base
                shadow-lg hover:shadow-xl transition-all">
              <Download size={20} />
              {`Download ${buildSpec.target.output_name}_snf_views.sql`}
            </button>
          )}

          {/* DuckDB — save directly to Reckoner substrates folder */}
          {buildSpec.target.backend !== 'postgres-views' && (
            <div className="space-y-2">
              {!saved ? (
                <>
                  <button onClick={saveToReckoner} disabled={saving}
                    className={`w-full flex items-center justify-center gap-3 py-4 px-6 rounded-xl
                      font-semibold text-base shadow-lg transition-all
                      ${saving
                        ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                        : 'bg-emerald-600 hover:bg-emerald-700 text-white hover:shadow-xl'}`}>
                    {saving
                      ? <><Loader2 size={20} className="animate-spin" /> Saving…</>
                      : <><Download size={20} /> Add to Reckoner</>}
                  </button>
                  {saveError && (
                    <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                      <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
                      <span>{saveError}</span>
                    </div>
                  )}
                </>
              ) : (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                  <div className="flex items-start gap-3">
                    <CheckCircle2 size={16} className="text-emerald-500 mt-0.5 flex-shrink-0" />
                    <div className="text-sm text-emerald-800">
                      <strong>Added to Reckoner.</strong> Switch to Reckoner, click LOAD, and your new substrate will appear automatically.
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Next step hint */}
          {buildSpec.target.backend === 'postgres-views' && (
            <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
              <div className="flex items-start gap-3">
                <Database size={16} className="text-blue-400 mt-0.5 flex-shrink-0" />
                <div className="text-sm text-blue-800">
                  <strong>Next:</strong> Give the <code className="text-xs bg-blue-100 px-1 rounded">.sql</code> file
                  to your DBA. They review and run it against your database — no data moves.
                  Then open Reckoner, point it at your Postgres instance, and start querying.
                </div>
              </div>
            </div>
          )}

          {/* Start over */}
          <div className="text-center">
            <button onClick={onStartOver}
              className="text-sm text-gray-400 hover:text-gray-600 flex items-center gap-1.5 mx-auto">
              <RefreshCw size={13} /> Import another dataset
            </button>
          </div>
        </div>
      )}

      {/* Back button on error */}
      {status === 'error' && (
        <div className="mt-6 pt-4 border-t border-gray-100">
          <button onClick={onBack}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700">
            <ChevronLeft size={15} /> Back
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main App
// ─────────────────────────────────────────────────────────────────────────────

export default function ModelBuilderApp() {
  const [step, setStep] = useState(1);

  // Accumulated state across steps
  const [sourceData,    setSourceData]    = useState(null);  // { type, columns, source_token, label, ... }
  const [mapping,       setMapping]       = useState(null);   // [{ column, dimension, semantic_key }]
  const [nucleus,       setNucleus]       = useState(null);   // { type, columns, separator, prefix }
  const [lensConfig,    setLensConfig]    = useState(null);   // { lens_id, output_name, backend }
  const [dataConnected, setDataConnected] = useState(false);  // true after Step5a values loaded
  const [structuralGroups, setStructuralGroups] = useState(null);  // List[StructuralGroup] | null

  const startOver = () => {
    setStep(1);
    setSourceData(null);
    setMapping(null);
    setNucleus(null);
    setLensConfig(null);
    setDataConnected(false);
    setStructuralGroups(null);
  };

  // BuildSpec assembled from accumulated state — source shape varies by type
  const isVocabSource = ['osi', 'dbt', 'json', 'yaml'].includes(sourceData?.type);

  const buildSpec = sourceData && mapping && nucleus && lensConfig ? {
    source: sourceData.type === 'sql' ? {
      type:             'sql',
      introspect_token: sourceData.source_token,
      table_name:       sourceData.table_name,
      schema_name:      sourceData.schema_name,
    } : isVocabSource ? {
      type:         sourceData.type,       // 'osi' | 'dbt' | 'json' | 'yaml'
      upload_token: sourceData.source_token,
      filename:     sourceData.file?.name,
      format:       sourceData.format,
    } : {
      type:         'file',
      upload_token: sourceData.source_token,
      filename:     sourceData.file?.name,
      format:       sourceData.format,
    },
    mapping,
    nucleus,
    lens:       { lens_id: lensConfig.lens_id, version: '1.0.0' },
    target:     { backend: lensConfig.backend, output_name: lensConfig.output_name },
    provenance: { created_at: new Date().toISOString() },
    options:    { overwrite: true },
    structural_groups: structuralGroups ?? [],
  } : null;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col" style={{ fontFamily: "'Instrument Sans', sans-serif" }}>
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded bg-blue-600 flex items-center justify-center">
              <Database size={14} className="text-white" />
            </div>
            <div>
              <span className="font-bold text-gray-900 text-sm">Reckoner</span>
              <span className="text-gray-300 mx-2">·</span>
              <span className="text-sm text-gray-500">Model Builder</span>
            </div>
          </div>
          <div className="text-xs text-gray-400">
            {sourceData?.label && (
              <span className="flex items-center gap-1.5">
                {sourceData.type === 'sql' ? <Server size={12} /> : <FileText size={12} />}
                {sourceData.label}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 py-10 px-6">
        <div className="max-w-2xl mx-auto">
          <StepBar currentStep={step} />

          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
            {step === 1 && (
              <Step1_ChooseSource
                onSourceReady={data => {
                  setSourceData(data);
                  setStep(2);
                }}
              />
            )}
            {step === 2 && sourceData && (
              <Step2_MapColumns
                columns={sourceData.columns}
                onBack={() => setStep(1)}
                onNext={m => { setMapping(m); isVocabSource ? setStep(4) : setStep(3); }}
              />
            )}
            {step === 3 && mapping && (
              <Step3_Review
                mapping={mapping}
                uploadToken={sourceData?.source_token}
                onBack={() => setStep(2)}
                onNext={() => setStep(4)}
              />
            )}
            {step === 4 && mapping && (
              <Step4_Nucleus
                columns={mapping}
                nucleusHint={sourceData?.nucleus_hints ? Object.values(sourceData.nucleus_hints)[0] : null}
                onBack={() => isVocabSource ? setStep(2) : setStep(3)}
                onNext={n => {
                  setNucleus(n);
                  setStep('4b');   // always go through structural groups step
                }}
              />
            )}
            {step === '4b' && mapping && (
              <Step4b_StructuralGroups
                mappedColumns={mapping}
                onBack={() => setStep(4)}
                onNext={groups => {
                  setStructuralGroups(groups);
                  const isDbVocab = ['dbt', 'osi'].includes(sourceData?.type);
                  setStep(isDbVocab ? '5a' : 5);
                }}
              />
            )}
            {step === '5a' && (
              <Step5a_DataConnect
                sourceData={sourceData}
                uploadToken={sourceData?.source_token}
                onBack={() => setStep(4)}
                onSkipToDuckDB={() => setStep(5)}
                onDone={startOver}
                onValuesLoaded={() => {
                  setDataConnected(true);
                  setStep(5);
                }}
              />
            )}
            {step === 5 && (
              <Step5_NameAndTarget
                sourceData={sourceData}
                onBack={() => setStep(4)}
                onNext={cfg => { setLensConfig(cfg); setStep(6); }}
              />
            )}
            {step === 6 && buildSpec && (
              <Step6_Compile
                buildSpec={buildSpec}
                onBack={() => setStep(5)}
                onStartOver={startOver}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
