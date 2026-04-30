# Model Builder API Specification — v1.0

This document defines the Model Builder API contract.

**Stability commitment:** This contract is stable as of Reckoner v1.0.
Third-party clients built against this spec will continue to work across
minor versions. Breaking changes will increment the major version and be
announced with a migration guide.

Third-party clients that talk to the local API are not subject to AGPL.
The server is AGPL. Your client is your own code.

---

## Overview

The Model Builder API is a set of HTTP endpoints served by `reckoner_api.py`
at `http://localhost:8000/api/mb/`. It powers the six-step wizard UI and is
fully usable by any third-party client — native apps, CLI tools, scripts.

**Base URL:** `http://localhost:8000/api/mb`

**Format:** JSON request/response bodies. File upload uses `multipart/form-data`.

**State model:** Wizard state is held server-side in a session keyed by a token.
The token threads through upload → review → compile. Sessions expire after 2 hours.
No authentication required — local server only.

---

## Endpoints

### POST /upload

Upload a CSV or Excel file. Returns column metadata and sample values.

**Request:** `multipart/form-data`

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | file | yes | CSV (`.csv`) or Excel (`.xlsx`, `.xls`) |

**Response:**

```json
{
  "upload_token": "uuid-string",
  "columns": [
    {
      "name":          "artist",
      "samples":       ["Miles Davis", "John Coltrane", "Bill Evans"],
      "suggested_dim": "WHO",
      "suggested_key": "artist"
    }
  ],
  "row_count": 833
}
```

| Field | Description |
|---|---|
| `upload_token` | Session token — pass to `/review` and `/compile` |
| `columns[].name` | Original column name from the file |
| `columns[].samples` | Up to 10 non-null sample values |
| `columns[].suggested_dim` | Inferred dimension (`WHO`/`WHAT`/`WHEN`/`WHERE`/`WHY`/`HOW`/`skip`) |
| `columns[].suggested_key` | Inferred semantic key (snake_case) |
| `row_count` | Total rows in the file |

---

### POST /introspect

Read-only introspection of a live Postgres table via SQLAlchemy.
Data never leaves the database. No writes. No CSV exports.

**Request:** `application/json`

```json
{
  "connection_string": "postgresql://user:password@host:5432/dbname",
  "table_name":        "matters",
  "schema_name":       "public"
}
```

**Response:**

```json
{
  "introspect_token": "uuid-string",
  "columns": [ ... ],
  "row_count": 152000
}
```

Same `columns` shape as `/upload`. Use `introspect_token` as the session token for subsequent calls.

**Security note:** The connection string is used once and never stored. The session holds
only the sampled DataFrame (10 rows) and column metadata. The connection string must
not be included in the BuildSpec — the server holds the session by token only.

---

### POST /review

Run pre-ingest review on mapped columns. Returns flags the user should
acknowledge before compiling.

**Request:** `application/json`

```json
{
  "source_token":   "uuid-from-upload-or-introspect",
  "columns_mapped": [
    {
      "column":       "Artist",
      "dimension":    "WHO",
      "semantic_key": "artist"
    },
    {
      "column":       "Title",
      "dimension":    "WHAT",
      "semantic_key": "title"
    }
  ]
}
```

**Response:**

```json
{
  "flags": [
    {
      "id":       "flag_1",
      "type":     "variant_candidates",
      "severity": "warning",
      "message":  "Possible duplicates in WHO|artist",
      "details":  "\"Miles Davis\" and \"Miles davis\" share significant tokens (similarity 89%). Detection engine: tantivy"
    }
  ]
}
```

**Flag types:**

| Type | Severity | Description |
|---|---|---|
| `variant_candidates` | warning | Two values in the same semantic_key share significant tokens — possible duplicates |
| `null_coordinates` | info | More than 20% of rows are null for a mapped field |
| `singleton_values` | info | Many values appear only once — possible data entry errors |
| `no_stable_id` | warning | No column is a clear stable unique identifier — consider a compound nucleus |

Flags are informational — not blocking. The human decides what matters.
All flags must be acknowledged before the UI advances to compile.

---

### POST /compile

Compile a BuildSpec into a substrate artifact.

**Request:** `application/json` — BuildSpec

```json
{
  "source": {
    "type":         "file",
    "upload_token": "uuid-string",
    "filename":     "collection.csv",
    "format":       "csv"
  },
  "mapping": [
    { "column": "Artist",    "dimension": "WHO",  "semantic_key": "artist"  },
    { "column": "Title",     "dimension": "WHAT", "semantic_key": "title"   },
    { "column": "Released",  "dimension": "WHEN", "semantic_key": "released"},
    { "column": "Label",     "dimension": "WHERE","semantic_key": "label"   }
  ],
  "nucleus": {
    "type":      "single",
    "columns":   ["release_id"],
    "separator": "-",
    "prefix":    "discogs"
  },
  "lens": {
    "lens_id": "my_collection",
    "version": "1.0.0"
  },
  "target": {
    "backend":     "duckdb",
    "output_name": "my_collection"
  },
  "provenance": {
    "created_at":         "2026-04-29T00:00:00Z",
    "translator_version": "1.0.0"
  },
  "options": {
    "overwrite": true
  }
}
```

**BuildSpec fields:**

`source` — one of two shapes:

| Field | File source | SQL source |
|---|---|---|
| `type` | `"file"` | `"sql"` |
| `upload_token` | required | — |
| `filename` | optional | — |
| `format` | `"csv"` or `"excel"` | — |
| `introspect_token` | — | required |
| `table_name` | — | required |
| `schema_name` | — | optional (default `"public"`) |

`mapping` — array of column → dimension assignments:

| Field | Description |
|---|---|
| `column` | Original column name (must match source) |
| `dimension` | `WHO` / `WHAT` / `WHEN` / `WHERE` / `WHY` / `HOW` |
| `semantic_key` | Snake_case field name in the substrate |

`nucleus` — entity identity declaration:

| Field | Description |
|---|---|
| `type` | `"single"` or `"compound"` |
| `columns` | Array of column names that form the nucleus |
| `separator` | Separator for compound nuclei (default `"-"`) |
| `prefix` | Optional namespace prefix (e.g. `"discogs"` → `"discogs:13988431"`) |

`target.backend` — output format:

| Value | Output | Description |
|---|---|---|
| `"duckdb"` | `.duckdb` file | Local use. Drop in Reckoner's `substrates/` folder. |
| `"postgres-views"` | `.sql` script | Materialized views over existing Postgres table. Data stays in place. |

**Response — BuildResult:**

```json
{
  "success":      true,
  "download_url": "/api/mb/download/my_collection.duckdb",
  "entity_count": 833,
  "fact_count":   4981,
  "facts_by_dim": {
    "WHO":   846,
    "WHAT":  2494,
    "WHEN":  1664,
    "WHERE": 0,
    "WHY":   0,
    "HOW":   0
  },
  "errors":   [],
  "warnings": [],
  "verification_report": {
    "facts_by_dim": { ... },
    "entity_count": 833,
    "lens_id":      "my_collection",
    "backend":      "duckdb",
    "generated_at": "2026-04-29T00:00:00Z"
  }
}
```

---

### GET /download/{filename}

Download a compiled artifact.

`filename` is the last path segment of `download_url` from BuildResult.

Returns the file as `application/octet-stream` (`.duckdb`) or `text/plain` (`.sql`).

Only files produced by `/compile` in the current server session are available.
Path traversal is not possible — only filenames in the artifacts temp directory are served.

---

## Substrate schema — DuckDB output

The `.duckdb` file produced by `/compile` contains two tables:

### `snf_spoke`

The coordinate table. One row per fact.

| Column | Type | Description |
|---|---|---|
| `entity_id` | VARCHAR | Stable entity identifier (nucleus value) |
| `dimension` | VARCHAR | Lowercase dimension: `who`, `what`, `when`, `where`, `why`, `how` |
| `semantic_key` | VARCHAR | Snake_case field name |
| `value` | VARCHAR | The fact value |
| `coordinate` | VARCHAR | Pipe-format: `dim\|semantic_key\|value` |
| `lens_id` | VARCHAR | Dataset identifier |

### `snf_meta`

Display table. One row per entity.

| Column | Type | Description |
|---|---|---|
| `entity_id` | VARCHAR | Stable entity identifier |
| `nucleus` | VARCHAR | Raw nucleus value |
| `label` | VARCHAR | Primary display label (first WHAT field) |
| `sublabel` | VARCHAR | Secondary label (first WHO field) |
| `lens_id` | VARCHAR | Dataset identifier |
| `translator_version` | VARCHAR | Model Builder version that produced this file |

Indexes are created on `snf_spoke(coordinate)`, `snf_spoke(entity_id)`,
and `snf_spoke(dimension, semantic_key)`.

---

## Error responses

All errors follow FastAPI's standard error shape:

```json
{
  "detail": "Human-readable error message"
}
```

| Status | Meaning |
|---|---|
| 400 | Bad request — missing or invalid field |
| 404 | Session token not found |
| 410 | Session expired (2 hour TTL) — re-upload the file |
| 422 | Validation error — request shape doesn't match spec |
| 500 | Compilation failed — detail contains the error |
| 501 | Dependency not installed (e.g. SQLAlchemy for `/introspect`) |

---

## Building a third-party client

The minimal flow:

```
1. POST /upload          (or /introspect for SQL)
   → get source_token, columns

2. Present columns to user for dimension mapping

3. POST /review          with source_token + columns_mapped
   → show flags, wait for acknowledgement

4. Collect nucleus declaration from user

5. Collect lens_id, output_name, backend from user

6. POST /compile         with BuildSpec
   → get download_url

7. GET /download/{filename}
   → save artifact to disk
```

The session token from step 1 threads through steps 3 and 6.
Steps 2, 4, and 5 are pure UI — no API calls.

---

## Versioning

This spec is versioned independently of Reckoner.
Current version: **1.0**.

The `/api/mb/` prefix is stable. New endpoints will be additive.
Existing fields will not be removed or renamed in minor versions.
