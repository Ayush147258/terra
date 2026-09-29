import json, pathlib
from fastapi import FastAPI, HTTPException
import candidates as C
from reconciliation import ReconError, ReconciliationResult, reconcile_parcel
from fastapi.middleware.cors import CORSMiddleware
D = pathlib.Path(__file__).resolve().parents[1] / "data" / "demo"
app = FastAPI(title="Crednode Terra Offline Prototype")
import os
from db import init_schema, DatabaseUnavailable, postgis_version
_origins = [o.strip() for o in os.environ.get("CORS_ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",") if o.strip() and o.strip() != "*"]
app.add_middleware(CORSMiddleware, allow_origins=_origins, allow_methods=["GET", "POST", "PUT", "OPTIONS"], allow_headers=["Content-Type"])
@app.on_event("startup")
def _startup(): init_schema()  # raises a clear error if PostgreSQL/PostGIS is unavailable
@app.get("/health")
def health_root(): return {"status": "ok"}
def load(sub, name): return json.loads((D / sub / name).read_text())
@app.get("/api/health")
def health(): return {"ok": True, "dataset": "DEMO / POC DATA"}
@app.get("/api/layers/{name}")
def layer(name: str):
    m = {"recorded": "recorded", "observed": "observed", "candidates": "candidates"}
    return load(m[name], f"{name}.geojson")
@app.get("/api/summary")
def summary():
    o = load("observed", "observed.geojson")["features"]
    return {"recorded": len(load("recorded", "recorded.geojson")["features"]), "observed": len(o),
            "flagged": sum(f["properties"]["flagged"] for f in o), "verified": 0}

_cache: dict = {}
@app.post("/api/reconciliation/{parcel_id}", response_model=ReconciliationResult)
def reconciliation(parcel_id: str):
    """Compute RECONCILIATION for one parcel. Read-only w.r.t. source data; result cached in memory."""
    if parcel_id not in _cache:
        try: _cache[parcel_id] = reconcile_parcel(parcel_id)
        except ReconError as e: raise HTTPException(e.status, e.message)
    _guard(C.ensure_engine_candidate, parcel_id, _cache[parcel_id].candidate_geometry)
    return _cache[parcel_id]

def _guard(fn, *a):
    try: return fn(*a)
    except ReconError as e: raise HTTPException(e.status, e.message)
    except HTTPException: raise
    except DatabaseUnavailable as e: raise HTTPException(503, str(e))
    except Exception: raise HTTPException(500, "Unexpected server error")

@app.put("/api/candidates/{parcel_id}", response_model=C.SaveResponse)
def save_candidate(parcel_id: str, body: C.SaveRequest):
    """Validate (again, server-side) and store a new CANDIDATE version. RECORDED data is never written."""
    return _guard(C.save, parcel_id, body.geometry)

@app.get("/api/candidates/{parcel_id}", response_model=C.SaveResponse)
def get_candidate(parcel_id: str):
    r = _guard(C.latest, parcel_id)
    if r is None: raise HTTPException(404, "No saved candidate")
    return r

@app.post("/api/candidates/{parcel_id}/evaluate", response_model=C.Metrics)
def evaluate_candidate(parcel_id: str, body: C.SaveRequest):
    return _guard(C.evaluate, parcel_id, body.geometry)

@app.get("/api/audit", response_model=list[C.AuditEvent])
def get_audit(): return _guard(C.audit)

@app.get("/api/review/{parcel_id}", response_model=C.ReviewStatus)
def review_get(parcel_id: str): return _guard(C.review_status, parcel_id)
@app.post("/api/review/{parcel_id}/submit", response_model=C.ReviewStatus)
def review_submit(parcel_id: str, b: C.VersionRequest): return _guard(C.submit, parcel_id, b.version)
@app.post("/api/review/{parcel_id}/approve", response_model=C.ReviewStatus)
def review_approve(parcel_id: str, b: C.ApproveRequest): return _guard(C.approve, parcel_id, b.version, b.note)
@app.post("/api/review/{parcel_id}/reject", response_model=C.ReviewStatus)
def review_reject(parcel_id: str, b: C.RejectRequest): return _guard(C.reject, parcel_id, b.version, b.reason)
@app.get("/api/verified")
def verified(): return _guard(C.verified_collection)

@app.post("/api/validation/{parcel_id}", response_model=C.ValidationResponse)
def validation(parcel_id: str, b: C.ValidationRequest):
    """PostGIS validation of the human-APPROVED candidate; promotes to VERIFIED only if no check FAILs (single transaction)."""
    return _guard(C.validate, parcel_id, b.candidate_version)
