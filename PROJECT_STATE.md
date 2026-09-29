# PROJECT_STATE — Crednode Terra Offline Prototype
**Purpose:** judge-facing offline POC of interactive parcel reconciliation. Independent of the production Terra repo.
**Phase:** 5 — PostGIS topology validation + Vercel frontend readiness (complete). Phases 0-3 preserved. Sections below marked (Phase 0) are historical.

## Architecture
React + TS + Vite + MapLibre GL (no basemap, no network) reads local GeoJSON. FastAPI serves the same data (/api/health, /api/layers/{name}, /api/summary). GeoPandas/Shapely generate and validate data. PostGIS/Docker Compose declared but not yet used.

## Structure
`backend/` generate_demo.py, main.py, test_data.py · `frontend/` Vite app (`public/data` = copy of demo data) · `data/demo/{recorded,observed,candidates,imagery}` · `docs/` · docker-compose.yml, start.bat, .env.example

## Demo dataset (DEMO / POC DATA, seed 42, generated in EPSG:32644, stored EPSG:4326)
24 recorded parcels (6x4 shared-edge irregular grid, DEMO-001..024); 28 observed footprints (24 buildings + 4 outbuildings); 6 flagged (>5% outside parcel): DEMO-004 shift, 009 oversize, 011 rotate+enlarge, 016 shift, 018 shift, 022 oversize. Candidates: empty. Imagery: none (flat synthetic backdrop colour).

## Implemented
Layer panel with working toggles, offline map (zoom/pan), parcel click → inspection (ID, area, status, source, geometry type, linked observed features), status bar counts computed from data, geometry validity + CRS checks, API.

## Not implemented (Phase 0 snapshot; superseded by later sections)
Raster imagery, SAM2/AI, reconciliation, candidate generation, editing, approve/reject, PostGIS load/topology, audit trail, export, auth.

## Next step (Phase 0 snapshot; superseded)
Implement reconciliation in backend: `POST /api/reconcile/{parcel_id}` using Shapely to compute observed-vs-recorded difference/overlap metrics and a candidate geometry, write to the Candidate layer, and render discrepancy geometry (difference polygons) on the map.

## Phase 2 — Reconciliation
- **Data:** added `data/demo/observed/observed_extent.geojson` (one synthetic observed parcel extent per parcel: 14 near-identical, 4 minor, 6 major perturbations). Phase 1 building footprints are unchanged; they are not comparable to parcel extents, so reconciliation uses the extent layer.
- **Engine:** `backend/reconciliation.py` (`reconcile_geometries`, pure; inputs never mutated). Ops: intersection, symmetric_difference, area, boundary Hausdorff distance, simplify + snap (candidate), make_valid.
- **CRS:** stored EPSG:4326; all areas/distances computed after reprojection to the local UTM CRS (`estimate_utm_crs`); outputs returned in 4326. Missing CRS -> 422.
- **Thresholds:** `backend/config.py` only. DEMO/POC values, NOT legal surveying standards.
- **API:** `POST /api/reconciliation/{parcel_id}` -> typed `ReconciliationResult` (404 / 422 / generic 500, no stack traces).
- **Limitation:** DEMO-013 is MAJOR by overlap (89.6% < 90%) although designed as minor.

## Phase 3 — Human editing of CANDIDATE geometry
- **Architecture:** `backend/candidates.py` (validate, version, persist, audit) + `frontend/src/edit.ts` (pure reducer), `geo.ts` (local metrics/validation). Candidates live in `data/demo/candidates/saved_candidates.json` (created on first save), never in recorded data.
- **Interaction:** Edit candidate -> purple vertices appear -> mousedown on a vertex, drag (map dragPan disabled), release. The reducer changes the real GeoJSON ring; the MapLibre source is re-set on every move. Undo = multi-step; Cancel edit restores the exact pre-edit candidate; moves are ignored outside edit mode. Recorded/observed layers have no edit path.
- **Live metrics:** local, approximate (tangent-plane metres, convex clip vs recorded, sampled Hausdorff) while dragging; exact backend values (`POST /api/candidates/{id}/evaluate`, same engine as Phase 2) replace them on release.
- **Validation:** frontend blocks save on non-Polygon, <3 vertices, bad coordinates, zero area, self-intersection. Backend re-validates: malformed GeoJSON, type, empty, non-finite / out-of-range lon-lat, `explain_validity`, >~50 m from recorded (CRS/axis-order guard). Invalid => 422, nothing stored.
- **Versioning:** `PUT /api/candidates/{parcel_id}` appends v1, v2... (version, geometry, source "human-edited candidate", created_at). `GET /api/candidates/{id}` = latest (reloaded on reconciliation). Status text: CANDIDATE UPDATED — PENDING VERIFICATION.
- **Audit:** `GET /api/audit`; events appended on save ("Candidate geometry edited", parcel, version, local timestamp). Minimal, not the final audit system.
- **CRS:** all GeoJSON is EPSG:4326 [lon, lat]; metric work only after projection.
- **Tests:** backend 14 pytest; frontend 14 vitest (reducer: activate, vertices, drag changes geometry, cancel, undo, invalid blocks save, save state; local metrics).
- **Limitations:** vertex drag verified at reducer + API level only, NOT in a real browser (no headless browser available here); no touch dragging; no add/delete vertex; local metrics assume convex recorded parcel; before/after shown as grey dotted original + MODIFIED tag + metrics only; single-user JSON store.
- **Next:** Phase 4 — approve/reject workflow producing VERIFIED geometry, with reviewer identity/notes in the audit trail.

## Phase 4 — Human review -> VERIFIED
- **State machine (backend-enforced; illegal transitions return 409):** UNREVIEWED -> CANDIDATE_READY -> IN_REVIEW -> APPROVED -> VERIFIED, or IN_REVIEW -> REJECTED -> (any new candidate version) CANDIDATE_READY. APPROVED is recorded as a decision and moves atomically to VERIFIED. Saving any new version (including during review or after verification) returns the parcel to CANDIDATE_READY, so approval must be given again. No automatic approval or verification exists anywhere.
- **Candidate lifecycle:** the first RUN RECONCILIATION stores the engine proposal as candidate v1 ("Candidate created"); human saves add v2, v3...
- **Review workflow (UI):** controls depend on state (`review.ts: controlsFor`): CANDIDATE_READY -> Edit / Review candidate; IN_REVIEW -> Approve / Reject (+Edit) with a decision textbox (reason required to reject); REJECTED -> Edit; VERIFIED -> View verified. The candidate line thickens in review mode.
- **Persistence:** `data/demo/candidates/saved_candidates.json` holds candidates, review state, decisions (RD-nnnn: parcel, candidate_version, APPROVED/REJECTED, reason, reviewer "Human Reviewer", created_at), verified records and audit events. Recorded GeoJSON is never written.
- **Verified geometry:** separate record {parcel_id, verified_geometry (deep copy of the approved candidate), source_candidate_version, verified_at, review_decision_id}. Candidate and recorded stay untouched. Map layer "Verified Geometry" = thick solid green + light fill; status-bar Verified count comes from stored records.
- **API:** `GET /api/review/{id}`, `POST /api/review/{id}/submit|approve|reject` (body: version; approve note; reject reason), `GET /api/verified`, plus Phase 3 endpoints. Audit events: Candidate created / edited / submitted for review / approved / rejected / Verified geometry created, each with parcel, version, timestamp, detail. The panel's review history renders stored events.
- **Tests:** backend 18 pytest (approve flow, recorded + candidate integrity, reject reason, reject -> re-edit -> approve, invalid transitions, history, verified provenance; conftest isolates the store); frontend 21 vitest (controls per state, approve/reject API calls, reason gating, error surfacing, status text, history lines, verified layer toggle).
- **Verified live (API via Vite proxy):** reject -> v3 -> approve on DEMO-018, straight approve on DEMO-004; recorded file unchanged.
- **Limitations:** the map UI (buttons, textarea, drag, layer rendering) was NOT exercised in a real browser; frontend tests cover logic and the API client, not rendered components; reviewer identity is a fixed label; no export yet; JSON-file store (single user, no PostGIS); one textbox serves both approve note and reject reason.
- **Next:** Phase 5 — export of verified geometry (GeoJSON + provenance/audit bundle) and PostGIS topology validation, then browser end-to-end tests.

## Phase 5 — PostGIS validation (state now lives in PostgreSQL)
- **Architecture:** all Phase 3/4 state moved from the JSON file to PostgreSQL/PostGIS 3.x (`backend/db.py` schema): `recorded_parcels` (loaded from GeoJSON; row trigger forbids UPDATE/DELETE), `candidate_versions`, `review_state`, `review_decisions`, `validation_results`, `verified_geometries`, `audit_events`. `init_schema()` fails with a clear error if PostgreSQL/PostGIS is unavailable — no Python-only fallback.
- **CRS/SRID:** everything stored as EPSG:4326 (SRID 4326). GeoJSON API contract = [lon, lat]; SRID is assigned explicitly at candidate insert after Python range checks; metric areas use `::geography` (no degree maths). Validation compares `ST_SRID(candidate)` with `ST_SRID(recorded)`.
- **Checks (PostGIS):** EMPTY_GEOMETRY (ST_IsEmpty), GEOMETRY_TYPE (ST_GeometryType = ST_Polygon), SRID (ST_SRID), GEOMETRY_VALIDITY (ST_IsValid/ST_IsValidReason), DUPLICATE_GEOMETRY (ST_Equals vs other parcels), NEIGHBOUR_OVERLAP (ST_Intersects to find candidates, ST_Touches = expected adjacency, ST_Area(ST_Intersection(..)::geography) for real overlap; >5 m2 FAIL, >0.5 m2 WARN, thresholds in `config.py`, demo values). ST_MakeValid is used only to return a diagnostic geometry (never stored or promoted). Overlap polygons returned to the map come from ST_Intersection.
- **State machine:** CANDIDATE_READY -> IN_REVIEW -> APPROVED_PENDING_VALIDATION -> VERIFIED (validation VALID/WARNING) | CANDIDATE_REVIEW_REQUIRED (INVALID). VALIDATING/VALIDATED are transient inside one DB transaction (audit events VALIDATION_STARTED / VALIDATION_COMPLETED). Approval alone never creates verified geometry. Human approval and validation are separate records; a failed validation keeps the APPROVED decision. New candidate version -> CANDIDATE_READY. VERIFIED with WARNING is allowed and shown as "passed with warnings".
- **Transactionality:** `validate()` runs check -> insert validation_results -> (if not INVALID) insert verified_geometries + state + audit in one transaction with the review row locked; any exception rolls everything back. DB-level guard: `verified_geometries` has a composite FK to `validation_results(id,status)` with `validation_status IN ('VALID','WARNING')`, so an INVALID result cannot back a verified row.
- **API:** `POST /api/validation/{parcel_id}` body `{candidate_version}` -> `ValidationResponse` {id, parcel_id, candidate_version, status, verified, state, checks[{check,status,message}], errors, warnings, overlap_geometry, diagnostic_geometry, validated_at}; `GET /api/review/{id}` now includes `validations`; approve returns state APPROVED_PENDING_VALIDATION; `GET /health` -> {"status":"ok"}. Audit codes: CANDIDATE_APPROVED, VALIDATION_STARTED, VALIDATION_COMPLETED, VALIDATION_FAILED, VERIFIED_GEOMETRY_CREATED (+ earlier events).
- **Frontend:** approve then automatic validation call (spinner "VALIDATING…"); "Run PostGIS validation" button if it did not complete; POSTGIS VALIDATION section with per-check list, headline (PASSED / PASSED WITH WARNINGS / FAILED), "VERIFIED GEOMETRY: AVAILABLE / NOT CREATED", expandable details, overlap layer under the Discrepancy toggle.
- **Demo scenarios (engine candidate, computed by PostGIS, no dataset changes):** DEMO-001 (also 002, 005, 006, 008, 010, 012, 014, 015, 017, 019, 021, 023, 024) reaches VERIFIED with all checks PASS. DEMO-018 (also 003, 004, 007, 009, 011, 013, 016, 020, 022) fails NEIGHBOUR_OVERLAP (DEMO-018 overlaps DEMO-024 by ~67 m2) and gets NO verified geometry. Shared-boundary case (candidate == its own recorded parcel) passes; covered by tests.
- **Tests:** backend 27 pytest incl. 9 real-PostGIS validation tests (DB `terra_test`); frontend 27 vitest. Live run against the `terra` DB via Vite proxy: DEMO-001 -> VERIFIED, DEMO-018 -> INVALID/CANDIDATE_REVIEW_REQUIRED, verified layer lists only DEMO-001.
- **Vercel readiness:** `src/api.ts` is the only place using `VITE_API_BASE_URL` (public; empty => Vite proxy); `safeFetch` maps network errors to "Backend unavailable ..."; `frontend/vercel.json` rewrites all routes to `index.html`; backend CORS from `CORS_ALLOWED_ORIGINS` (default localhost:5173; `*` ignored); `.env.example` files added; README has separate local and Vercel workflows. Vercel = static frontend only; FastAPI and PostgreSQL/PostGIS deploy separately. NOT tested: live Vercel deployment.
- **Limitations:** UI not exercised in a real browser (map rendering/drag/buttons); frontend tests are logic-level; after a failed re-cycle an older verified geometry (from an earlier passing cycle) stays until replaced; no auth; demo thresholds are not survey standards; the in-memory reconciliation cache is per process; Docker Compose file written but not run here (PostgreSQL was installed directly via apt).
- **Next:** Phase 6 — export bundle (verified GeoJSON + validation + audit provenance), browser end-to-end tests (Playwright), then production hardening (auth, migrations tool, lifespan startup).

## Deployment recipe (added after Phase 5)
Vercel (frontend only) -> Render (Docker web service, `Dockerfile` + `render.yaml`, health `/health`, listens on $PORT) -> Supabase (PostgreSQL + PostGIS via Session pooler). Files: `Dockerfile`, `.dockerignore`, `render.yaml`, `database/supabase_rls.sql`. Reset demo DB: `TRUNCATE audit_events, verified_geometries, validation_results, review_decisions, review_state, candidate_versions RESTART IDENTITY CASCADE;`. NOT tested in this environment: Docker build, Render, Supabase (PostGIS `extensions` schema search_path unconfirmed), live Vercel.
