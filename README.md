# Crednode Terra — Prototype (offline-first)
**All data is synthetic (DEMO / POC DATA), not real cadastral data.** Thresholds are demo values, not survey standards.
Lifecycle: RECORDED (immutable) → OBSERVED → RECONCILIATION → CANDIDATE → HUMAN REVIEW → APPROVED → **POSTGIS VALIDATION** → VERIFIED.

## A. Local offline development (no internet needed at runtime)
1. **PostgreSQL/PostGIS:** `docker compose up -d db` (or any local Postgres 14+ with PostGIS; create DB/role from `.env.example`, `CREATE EXTENSION postgis`).
2. **FastAPI:** `pip install -r backend/requirements.txt && python backend/generate_demo.py && cd backend && uvicorn main:app --port 8000`
   (creates tables on startup; fails with a clear error if PostgreSQL/PostGIS is unavailable). Check http://localhost:8000/health.
3. **Vite:** `cd frontend && npm install && npm run dev`
4. Open http://localhost:5173. Tests: `cd backend && pytest` (uses DB `terra_test`, set `TEST_DATABASE_URL`), `cd frontend && npm test`.

## B. Vercel frontend deployment (frontend ONLY)
Vercel hosts **only the static React/Vite app**. It does **not** host the FastAPI backend or PostgreSQL/PostGIS.
```
 VERCEL (static SPA)  --HTTPS-->  FASTAPI (deployed separately)  -->  POSTGRES + POSTGIS (external, persistent)
```
1. Import the repo in Vercel, **Root Directory = `frontend`**, Framework **Vite**, Build command `npm run build`, Output directory `dist`.
2. Environment variable: `VITE_API_BASE_URL=https://<deployed-backend-domain>` (public value; no secrets).
   `frontend/vercel.json` rewrites all routes to `index.html` (SPA refresh); static files in `dist` (incl. `/data/*.geojson`) are served first.
3. Deploy FastAPI on any container/VM host (`uvicorn main:app --host 0.0.0.0 --port $PORT`), with `DATABASE_URL` pointing to a managed PostgreSQL that has PostGIS enabled.
4. Set backend `CORS_ALLOWED_ORIGINS=https://<vercel-project>.vercel.app` (comma-separated; `*` is ignored).
5. Verify: open the Vercel URL → pick a parcel → Run reconciliation (frontend → FastAPI → PostGIS); `GET <backend>/health` → `{"status":"ok"}`.
Do not use Vercel serverless functions for the geospatial backend.

## C. Production recipe: Vercel + Render + Supabase
```
VERCEL (frontend)  --HTTPS-->  RENDER (FastAPI, Dockerfile)  -->  SUPABASE (PostgreSQL + PostGIS)
```
1. **Supabase:** new project -> Database -> Extensions -> enable `postgis`. Connect -> copy the **Session pooler** connection string (IPv4; not the Transaction pooler on 6543). This is `DATABASE_URL`.
2. **Render:** push this repo to GitHub -> New -> Blueprint (uses `render.yaml`) or New Web Service (Runtime Docker). Set `DATABASE_URL` and `CORS_ALLOWED_ORIGINS` (placeholder for now). Health check path `/health`. Open `https://<render-domain>/health` and `/api/summary` (expect 24 / 28 / 6 / 0).
3. **Supabase, once tables exist:** run `database/supabase_rls.sql` in the SQL editor.
4. **Vercel:** Root Directory `frontend`, Framework Vite, env `VITE_API_BASE_URL=https://<render-domain>`; deploy.
5. **Render:** set `CORS_ALLOWED_ORIGINS=https://<project>.vercel.app` (plus any custom domain), redeploy. Preview URLs need adding too.
Notes: free Render sleeps when idle (first request can take 30 s+); the app has no authentication; reset demo state with the TRUNCATE in PROJECT_STATE.md. Not tested here: Docker build, Render, Supabase, live Vercel.
