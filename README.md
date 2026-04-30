# SNF Model Builder

Browser wizard for preparing data for Reckoner.

Drop a CSV, Excel file, or connect to a live Postgres table. Map your columns
to semantic dimensions. Declare a nucleus. Download the import artifact.
Open Reckoner and start querying.

Part of the [peirce-lang](https://github.com/peirce-lang) ecosystem.
Companion to [Reckoner](https://github.com/peirce-lang/reckoner).

---

## Folder layout

```
snf-toolkit/
├── reckoner/                    ← Reckoner frontend + Python backend
│   ├── src/
│   │   ├── ReckonerSNF.jsx
│   │   ├── TrieValuePanel.jsx
│   │   ├── ResultCard.jsx
│   │   └── main.tsx
│   ├── reckoner_api.py          ← Python API server (shared — runs both tools)
│   ├── model_builder_api.py     ← Model Builder router (mounted into reckoner_api.py)
│   ├── postgres_adapter.py
│   └── .env
│
└── snf-model-builder/           ← this repo
    ├── src/
    │   ├── ModelBuilderApp.jsx  ← wizard frontend
    │   ├── main.tsx
    │   └── style.css
    ├── index.html
    ├── package.json
    ├── vite.config.js
    └── README.md
```

**One Python server runs both tools.**
`model_builder_api.py` mounts as a router inside `reckoner_api.py`.
Reckoner and Model Builder share the same FastAPI process on port 8000.

---

## Setup

### 1. Python backend (in the `reckoner/` folder)

```bash
pip install fastapi uvicorn snf-peirce duckdb pandas openpyxl sqlalchemy psycopg2-binary
pip install tantivy        # recommended — variant detection
```

Make sure `model_builder_api.py` is in the same folder as `reckoner_api.py`, then start the server:

```bash
cd snf-toolkit/reckoner
python reckoner_api.py
```

You should see:
```
============================================================
  Reckoner API — Python backend
  Model Builder endpoints: /api/mb/*
============================================================
[api] Model Builder endpoints loaded at /api/mb
```

### 2. Model Builder frontend (this folder)

```bash
cd snf-toolkit/snf-model-builder
npm install
npm run dev
```

You should see:
```
VITE v5.x.x  ready in ~200ms

  Local:   http://localhost:5174/
```

### 3. Open Model Builder

```
http://localhost:5174
```

Reckoner runs at `http://localhost:5173` as normal.
Both can run simultaneously — they share the same Python backend.

---

## API contract

The wizard talks to the Python backend at `http://localhost:8000/api/mb/`:

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/mb/upload` | POST | Upload CSV or Excel. Returns columns + samples. |
| `/api/mb/introspect` | POST | Read-only Postgres introspection via SQLAlchemy. |
| `/api/mb/review` | POST | Pre-ingest review — variant detection, null coverage, singletons. |
| `/api/mb/compile` | POST | Compile BuildSpec → artifact. |
| `/api/mb/download/{filename}` | GET | Download compiled artifact. |

Full BuildSpec / BuildResult contract: see `model_builder_api.py` docstring and the
[SNF Model Builder spec](https://github.com/peirce-lang/snf-model-builder/docs).

This contract is **stable as of v1.0**. Third-party clients are welcome.

---

## License

AGPL-3.0. See [LICENSE](LICENSE).

Third-party clients that talk to the local API are not subject to AGPL —
only modifications to the server itself that are distributed or run as a
network service require source publication.
