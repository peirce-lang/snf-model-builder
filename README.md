# SNF Model Builder

Browser wizard for preparing data for Reckoner.

Drop a CSV, Excel file, or connect to a live Postgres table. Map your columns
to semantic dimensions. Declare a nucleus. Download the import artifact.
Open Reckoner and start querying.

Part of the [peirce-lang](https://github.com/peirce-lang) ecosystem.
Companion to [Reckoner](https://github.com/peirce-lang/reckoner).

---

## Important — this repo is one half of a pair

Model Builder is the **wizard frontend**. The Python backend it talks to lives
inside [Reckoner](https://github.com/peirce-lang/reckoner) (specifically,
`model_builder_api.py` mounts as a router inside `reckoner_api.py`).

**One Python server runs both tools.** Reckoner's UI runs at
`http://localhost:5173`; Model Builder's UI runs at `http://localhost:5174`;
both share the FastAPI backend on `http://localhost:8000`.

You need **both repos cloned** to use Model Builder. Clone them next to each
other:

```
your-projects/
├── reckoner/                ← Python backend + Reckoner UI
└── snf-model-builder/       ← this repo (wizard UI only)
```

If you haven't set up Reckoner yet, do that first — its README walks through
the Python backend setup. Then come back here for the wizard frontend.

---

## Setup

This assumes you've already cloned and started Reckoner per its README.
The Python backend at `localhost:8000` must be running.

### 1. Clone this repo next to your `reckoner/` folder

```bash
# from wherever your reckoner folder lives — go up one level and clone
cd ..
git clone https://github.com/peirce-lang/snf-model-builder
cd snf-model-builder
```

### 2. Install frontend dependencies

```bash
npm install
```

### 3. Start the wizard

```bash
npm run dev
```

You should see:

```
VITE v5.x.x  ready in ~200ms

  Local:   http://localhost:5174/
```

### 4. Open Model Builder

```
http://localhost:5174
```

Reckoner runs at `http://localhost:5173` as normal. Both can run
simultaneously — they share the same Python backend.

---

## Six steps to load your data

1. **Upload** — drop a CSV or Excel file, or connect to a live Postgres table
2. **Map** — assign each column to a semantic dimension (WHO / WHAT / WHEN / WHERE / WHY / HOW)
3. **Review** — pre-ingest flags surface variant candidates, null coverage, singletons
4. **Nucleus** — declare the column (or combination) that uniquely identifies each row
5. **Compile** — name your dataset and pick a target (DuckDB for local use)
6. **Load into Reckoner** — drop the compiled `.duckdb` file in `reckoner/substrates/` and restart `reckoner_api.py`

---

## API contract

The wizard talks to the Python backend at `http://localhost:8000/api/mb/`:

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/mb/upload` | POST | Upload CSV or Excel. Returns columns + samples. |
| `/api/mb/introspect` | POST | Read-only Postgres introspection via SQLAlchemy. |
| `/api/mb/review` | POST | Pre-ingest review — variant detection, null coverage, singletons. |
| `/api/mb/compile` | POST | Compile BuildSpec → artifact. |
| `/api/mb/download/{filename}` | GET | Download compiled artifact. |

Full BuildSpec / BuildResult contract: see `model_builder_api.py` docstring
in the [Reckoner repo](https://github.com/peirce-lang/reckoner) and the
[Model Builder API spec](https://github.com/peirce-lang/snf-model-builder/blob/main/MODEL_BUILDER_API.md).

This contract is **stable as of v1.0**. Third-party clients are welcome.

---

## Repository layout

```
snf-model-builder/
├── src/
│   ├── ModelBuilderApp.jsx    ← wizard frontend
│   ├── main.tsx
│   └── style.css
├── index.html
├── package.json
├── vite.config.js
├── MODEL_BUILDER_API.md       ← full API contract for third-party clients
└── README.md                  ← this file
```

The Python backend (`model_builder_api.py`) lives in the
[Reckoner repo](https://github.com/peirce-lang/reckoner) and is mounted into
`reckoner_api.py` automatically. You don't run it separately.

---

## License

AGPL-3.0. See [LICENSE](https://github.com/peirce-lang/snf-model-builder/blob/main/LICENSE).

Third-party clients that talk to the local API are not subject to AGPL —
only modifications to the server itself that are distributed or run as a
network service require source publication.
