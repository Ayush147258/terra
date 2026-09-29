"""Candidate persistence, review state machine and PostGIS validation (all state in PostgreSQL).
RECORDED data is never written (table trigger enforces it)."""
import json, math
from datetime import datetime
from typing import Any, Literal, Optional
from pydantic import BaseModel
from shapely.geometry import shape, mapping
from shapely.validation import explain_validity
import reconciliation as R
from db import connect
from config import VALIDATION as V

class SaveRequest(BaseModel): geometry: dict[str, Any]
class SaveResponse(BaseModel):
    parcel_id: str; candidate_version: int; geometry: dict[str, Any]; is_valid: bool
    validation_messages: list[str]; status: str; source: str; created_at: str; updated_at: str
class Metrics(BaseModel):
    parcel_id: str; candidate_area: float; recorded_area: float; area_difference: float; area_difference_percent: float
    overlap_percent: float; symmetric_difference_area: float; boundary_deviation: float
class AuditEvent(BaseModel): event: str; parcel_id: str; version: int; timestamp: str; detail: Optional[str] = None

def parse_candidate(parcel_id: str, geom: dict):
    """Validate a candidate GeoJSON geometry (EPSG:4326 [lon, lat]). Raises ReconError."""
    rec, crs = R._find("recorded", "recorded.geojson", parcel_id)
    if rec is None: raise R.ReconError(404, f"Parcel {parcel_id} not found")
    if crs is None: raise R.ReconError(422, "CRS problem: recorded data has no EPSG:4326 declaration")
    try: g = shape(geom)
    except Exception: raise R.ReconError(422, "CANDIDATE GEOMETRY INVALID: malformed GeoJSON geometry")
    if g.geom_type != "Polygon": raise R.ReconError(422, f"CANDIDATE GEOMETRY INVALID: expected Polygon, got {g.geom_type}")
    if g.is_empty: raise R.ReconError(422, "CANDIDATE GEOMETRY INVALID: empty geometry")
    if any(not math.isfinite(v) for c in g.exterior.coords for v in c) or any(abs(x) > 180 or abs(y) > 90 for x, y, *_ in g.exterior.coords):
        raise R.ReconError(422, "CANDIDATE GEOMETRY INVALID: coordinates are not valid EPSG:4326 [lon, lat]")
    if not g.is_valid: raise R.ReconError(422, f"CANDIDATE GEOMETRY INVALID: {explain_validity(g)}")
    if g.distance(rec) > 5e-4:  # ~50 m
        raise R.ReconError(422, "CANDIDATE GEOMETRY INVALID: geometry is far from the recorded parcel (check CRS / axis order)")
    return g, rec, crs

def evaluate(parcel_id: str, geom: dict) -> Metrics:
    g, rec, crs = parse_candidate(parcel_id, geom)
    r = R.reconcile_geometries(parcel_id, rec, g, crs)
    return Metrics(parcel_id=parcel_id, candidate_area=r.observed_area, recorded_area=r.recorded_area, area_difference=r.area_difference,
        area_difference_percent=r.area_difference_percent, overlap_percent=r.overlap_percent,
        symmetric_difference_area=r.symmetric_difference_area, boundary_deviation=r.boundary_deviation)


# ---------------- models ----------------
REVIEWER = "Human Reviewer"  # fixed local POC label, NOT an authenticated user
class VersionRequest(BaseModel): version: int
class ApproveRequest(BaseModel): version: int; note: str = ""
class RejectRequest(BaseModel): version: int; reason: str
class Decision(BaseModel):
    id: str; parcel_id: str; candidate_version: int; decision: Literal["APPROVED", "REJECTED"]; reason: str; reviewer: str; created_at: str
class Check(BaseModel): check: str; status: Literal["PASS", "WARN", "FAIL", "SKIP"]; message: str
class ValidationRequest(BaseModel): candidate_version: int
class ValidationRecord(BaseModel):
    id: int; parcel_id: str; candidate_version: int; status: Literal["VALID", "WARNING", "INVALID"]; checks: list[Check]
    errors: list[str]; warnings: list[str]; overlap_geometry: Optional[dict[str, Any]]; validated_at: str
class ValidationResponse(ValidationRecord):
    verified: bool; state: str; diagnostic_geometry: Optional[dict[str, Any]] = None  # ST_MakeValid output, diagnostic only, never promoted
class Verified(BaseModel):
    parcel_id: str; verified_geometry: dict[str, Any]; source_candidate_version: int; verified_at: str; review_decision_id: str
    validation_result_id: int; validation_status: str
class ReviewStatus(BaseModel):
    parcel_id: str; state: str; latest_version: int; reviewer: str; decisions: list[Decision]; verified: Optional[Verified]
    history: list[AuditEvent]; validations: list[ValidationRecord]

# ---------------- helpers ----------------
def _iso(t): return t.isoformat(timespec="seconds")
def _event(c, pid, event, version=0, detail=None, status=None):
    c.execute("INSERT INTO audit_events(parcel_id,event,version,detail,status) VALUES (%s,%s,%s,%s,%s)", (pid, event, version, detail, status))
def _state(c, pid, lock=False):
    r = c.execute("SELECT state FROM review_state WHERE parcel_id=%s" + (" FOR UPDATE" if lock else ""), (pid,)).fetchone()
    return r["state"] if r else None
def _set_state(c, pid, st): c.execute("INSERT INTO review_state VALUES (%s,%s) ON CONFLICT (parcel_id) DO UPDATE SET state=EXCLUDED.state", (pid, st))
def _need_parcel(pid):
    if R._find("recorded", "recorded.geojson", pid)[0] is None: raise R.ReconError(404, f"Parcel {pid} not found")
def _latest_row(c, pid):
    return c.execute("SELECT version, ST_AsGeoJSON(geom,15)::jsonb g, source, created_at FROM candidate_versions WHERE parcel_id=%s ORDER BY version DESC LIMIT 1", (pid,)).fetchone()
def _resp(pid, r) -> SaveResponse:
    t = _iso(r["created_at"])
    return SaveResponse(parcel_id=pid, candidate_version=r["version"], geometry=r["g"], is_valid=True, validation_messages=["Valid Polygon"],
        status="CANDIDATE UPDATED — PENDING VERIFICATION", source=r["source"], created_at=t, updated_at=t)
def _insert_candidate(c, pid, geom: dict, source):
    c.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (pid,))
    n = c.execute("SELECT COALESCE(MAX(version),0)+1 n FROM candidate_versions WHERE parcel_id=%s", (pid,)).fetchone()["n"]
    # GeoJSON contract = EPSG:4326 [lon,lat] (range-checked in parse_candidate); SRID assigned explicitly and documented.
    c.execute("INSERT INTO candidate_versions(parcel_id,version,geom,source) VALUES (%s,%s,ST_SetSRID(ST_GeomFromGeoJSON(%s),4326),%s)", (pid, n, json.dumps(geom), source))
    return n

# ---------------- candidates ----------------
def save(parcel_id: str, geom: dict) -> SaveResponse:
    g, _, _ = parse_candidate(parcel_id, geom)
    with connect() as c:
        n = _insert_candidate(c, parcel_id, mapping(g), "human-edited candidate")
        _set_state(c, parcel_id, "CANDIDATE_READY")  # any new version needs review + validation again
        _event(c, parcel_id, "Candidate geometry edited", n)
        return _resp(parcel_id, _latest_row(c, parcel_id))
def latest(parcel_id: str):
    with connect() as c: r = _latest_row(c, parcel_id)
    return _resp(parcel_id, r) if r else None
def ensure_engine_candidate(parcel_id: str, geom: dict):
    try: parse_candidate(parcel_id, geom)
    except R.ReconError: return
    with connect() as c:
        if c.execute("SELECT 1 FROM candidate_versions WHERE parcel_id=%s LIMIT 1", (parcel_id,)).fetchone(): return
        n = _insert_candidate(c, parcel_id, geom, "reconciliation engine")
        _set_state(c, parcel_id, "CANDIDATE_READY"); _event(c, parcel_id, "Candidate created", n, "reconciliation engine proposal")
def _audit_rows(rows): return [dict(event=r["event"], parcel_id=r["parcel_id"], version=r["version"], timestamp=_iso(r["created_at"]), detail=r["detail"]) for r in rows]
def audit() -> list[dict]:
    with connect() as c: return _audit_rows(c.execute("SELECT * FROM audit_events ORDER BY id").fetchall())

# ---------------- review state machine ----------------
# UNREVIEWED -> CANDIDATE_READY -> IN_REVIEW -> APPROVED_PENDING_VALIDATION -> (PostGIS) VERIFIED | CANDIDATE_REVIEW_REQUIRED
# IN_REVIEW -> REJECTED; any new candidate version -> CANDIDATE_READY. VALIDATING/VALIDATED are transient inside one DB transaction
# (audit events VALIDATION_STARTED / VALIDATION_COMPLETED). Human approval never creates verified geometry by itself.
def _transition(c, pid, version, expected, action):
    _need_parcel(pid); st = _state(c, pid, lock=True); r = _latest_row(c, pid)
    if not r: raise R.ReconError(409, f"Cannot {action}: no candidate exists for {pid}")
    if st != expected: raise R.ReconError(409, f"Cannot {action}: state is {st}, expected {expected}")
    if version != r["version"]: raise R.ReconError(409, f"Cannot {action}: candidate v{version} is not the latest (v{r['version']})")
    parse_candidate(pid, r["g"]); return r
def _decide(c, pid, version, decision, reason):
    return c.execute("INSERT INTO review_decisions(parcel_id,candidate_version,decision,reason,reviewer) VALUES (%s,%s,%s,%s,%s) RETURNING id", (pid, version, decision, reason, REVIEWER)).fetchone()["id"]
def submit(pid, version):
    with connect() as c:
        _transition(c, pid, version, "CANDIDATE_READY", "submit for review"); _set_state(c, pid, "IN_REVIEW"); _event(c, pid, "Candidate submitted for review", version)
    return review_status(pid)
def approve(pid, version, note=""):
    with connect() as c:
        _transition(c, pid, version, "IN_REVIEW", "approve"); _decide(c, pid, version, "APPROVED", note.strip())
        _set_state(c, pid, "APPROVED_PENDING_VALIDATION"); _event(c, pid, "CANDIDATE_APPROVED", version, note.strip() or None, "APPROVED")
    return review_status(pid)
def reject(pid, version, reason):
    if len(reason.strip()) < 3: raise R.ReconError(422, "A rejection reason is required")
    with connect() as c:
        _transition(c, pid, version, "IN_REVIEW", "reject"); _decide(c, pid, version, "REJECTED", reason.strip())
        _set_state(c, pid, "REJECTED"); _event(c, pid, "Candidate rejected", version, reason.strip(), "REJECTED")
    return review_status(pid)

# ---------------- PostGIS validation ----------------
def check_geometry(c, pid: str, geom_hex: str) -> dict:
    """Run the POC validation suite in PostGIS on one geometry (EWKB hex). Returns checks/errors/warnings/overlap/diagnostic."""
    g = c.execute("""SELECT ST_IsEmpty(g) empty, ST_GeometryType(g) gtype, ST_SRID(g) srid, ST_IsValid(g) valid, ST_IsValidReason(g) reason,
        (SELECT ST_SRID(geom) FROM recorded_parcels WHERE parcel_id=%s) rsrid FROM (SELECT %s::geometry g) t""", (pid, geom_hex)).fetchone()
    ck, errors, warnings = [], [], []
    def add(name, status, msg):
        ck.append(Check(check=name, status=status, message=msg))
        (errors if status == "FAIL" else warnings if status == "WARN" else []).append(msg)
    add("EMPTY_GEOMETRY", "FAIL" if g["empty"] else "PASS", "Geometry is empty" if g["empty"] else "Geometry is not empty")
    ok_type = g["gtype"] == "ST_Polygon"
    add("GEOMETRY_TYPE", "PASS" if ok_type else "FAIL", "Geometry type is Polygon" if ok_type else f"Unexpected geometry type {g['gtype']} (expected ST_Polygon)")
    ok_srid = g["srid"] == g["rsrid"]
    add("SRID", "PASS" if ok_srid else "FAIL", f"SRID {g['srid']} is consistent with recorded parcels" if ok_srid else f"SRID mismatch: candidate {g['srid']} vs recorded {g['rsrid']}")
    add("GEOMETRY_VALIDITY", "PASS" if g["valid"] else "FAIL", "Geometry is valid" if g["valid"] else f"Invalid geometry: {g['reason']}")
    ready = ok_type and ok_srid and g["valid"] and not g["empty"]
    overlap = {"type": "FeatureCollection", "features": []}
    if not ready:
        add("DUPLICATE_GEOMETRY", "SKIP", "Skipped: geometry failed basic checks"); add("NEIGHBOUR_OVERLAP", "SKIP", "Skipped: geometry failed basic checks")
    else:
        dup = [r["parcel_id"] for r in c.execute("SELECT parcel_id FROM recorded_parcels WHERE parcel_id<>%s AND ST_Equals(geom, %s::geometry)", (pid, geom_hex))]
        add("DUPLICATE_GEOMETRY", "FAIL" if dup else "PASS", f"Identical to recorded parcel {dup[0]}" if dup else "Not a duplicate of another parcel")
        rows = c.execute("""SELECT r.parcel_id, ST_Touches(r.geom, g.g) touches, ST_Area(ST_Intersection(r.geom, g.g)::geography) m2,
            ST_AsGeoJSON(ST_Intersection(r.geom, g.g), 15)::jsonb gj FROM recorded_parcels r, (SELECT %s::geometry g) g
            WHERE r.parcel_id<>%s AND ST_Intersects(r.geom, g.g)""", (geom_hex, pid)).fetchall()
        bad = [r for r in rows if not r["touches"] and r["m2"] > V["overlap_fail_m2"]]
        slivers = [r for r in rows if not r["touches"] and V["overlap_warn_m2"] < r["m2"] <= V["overlap_fail_m2"]]
        touching = [r["parcel_id"] for r in rows if r["touches"]]
        for r in bad + slivers: overlap["features"].append({"type": "Feature", "geometry": r["gj"], "properties": {"neighbour": r["parcel_id"], "overlap_m2": round(r["m2"], 2)}})
        if bad: add("NEIGHBOUR_OVERLAP", "FAIL", "; ".join(f"Unexpected overlap with {r['parcel_id']} ({r['m2']:.1f} m²)" for r in bad))
        elif slivers: add("NEIGHBOUR_OVERLAP", "WARN", "; ".join(f"Minor overlap with {r['parcel_id']} ({r['m2']:.1f} m²)" for r in slivers))
        else: add("NEIGHBOUR_OVERLAP", "PASS", "No unexpected overlap" + (f" (shared boundary with {', '.join(touching)} is expected adjacency)" if touching else ""))
    diag = None
    if not g["empty"] and not g["valid"]:
        diag = c.execute("SELECT ST_AsGeoJSON(ST_MakeValid(%s::geometry), 15)::jsonb d", (geom_hex,)).fetchone()["d"]
    return {"checks": ck, "errors": errors, "warnings": warnings, "overlap": overlap, "diagnostic": diag}

def validate(pid: str, version: int) -> ValidationResponse:
    """One transaction: check -> persist result -> (only if not INVALID) promote to verified. Exception => full rollback."""
    _need_parcel(pid)
    with connect() as c:
        st = _state(c, pid, lock=True); r = _latest_row(c, pid)
        if not r or st != "APPROVED_PENDING_VALIDATION": raise R.ReconError(409, f"Cannot validate: state is {st}, expected APPROVED_PENDING_VALIDATION")
        if version != r["version"]: raise R.ReconError(409, f"Cannot validate: candidate v{version} is not the latest (v{r['version']})")
        d = c.execute("SELECT id FROM review_decisions WHERE parcel_id=%s AND candidate_version=%s AND decision='APPROVED' ORDER BY id DESC LIMIT 1", (pid, version)).fetchone()
        if not d: raise R.ReconError(409, "Cannot validate: no human approval recorded for this candidate")
        _event(c, pid, "VALIDATION_STARTED", version, "PostGIS validation")
        hexg = c.execute("SELECT geom::text h FROM candidate_versions WHERE parcel_id=%s AND version=%s", (pid, version)).fetchone()["h"]
        res = check_geometry(c, pid, hexg)
        status = "INVALID" if res["errors"] else "WARNING" if res["warnings"] else "VALID"
        vid = c.execute("""INSERT INTO validation_results(parcel_id,candidate_version,decision_id,status,checks,errors,warnings,overlap_geojson)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id, validated_at""", (pid, version, d["id"], status, json.dumps([x.model_dump() for x in res["checks"]]),
            json.dumps(res["errors"]), json.dumps(res["warnings"]), json.dumps(res["overlap"]) if res["overlap"]["features"] else None)).fetchone()
        if status != "INVALID":
            c.execute("""INSERT INTO verified_geometries(parcel_id,geom,source_candidate_version,review_decision_id,validation_result_id,validation_status)
                VALUES (%s, (SELECT geom FROM candidate_versions WHERE parcel_id=%s AND version=%s), %s,%s,%s,%s)
                ON CONFLICT (parcel_id) DO UPDATE SET geom=EXCLUDED.geom, source_candidate_version=EXCLUDED.source_candidate_version, verified_at=now(),
                review_decision_id=EXCLUDED.review_decision_id, validation_result_id=EXCLUDED.validation_result_id, validation_status=EXCLUDED.validation_status""",
                (pid, pid, version, version, d["id"], vid["id"], status))
            _set_state(c, pid, "VERIFIED")
            _event(c, pid, "VALIDATION_COMPLETED", version, "; ".join(res["warnings"]) or "All checks passed", status)
            _event(c, pid, "VERIFIED_GEOMETRY_CREATED", version, f"from candidate v{version}", status)
        else:
            _set_state(c, pid, "CANDIDATE_REVIEW_REQUIRED")
            _event(c, pid, "VALIDATION_FAILED", version, "; ".join(res["errors"]), status)
        return ValidationResponse(id=vid["id"], parcel_id=pid, candidate_version=version, status=status, checks=res["checks"], errors=res["errors"], warnings=res["warnings"],
            overlap_geometry=res["overlap"] if res["overlap"]["features"] else None, validated_at=_iso(vid["validated_at"]), verified=status != "INVALID",
            state="VERIFIED" if status != "INVALID" else "CANDIDATE_REVIEW_REQUIRED", diagnostic_geometry=res["diagnostic"])

def review_status(pid: str) -> ReviewStatus:
    _need_parcel(pid)
    with connect() as c:
        r = _latest_row(c, pid); st = _state(c, pid) if r else "UNREVIEWED"
        dec = [Decision(id=f"RD-{x['id']:04d}", parcel_id=pid, candidate_version=x["candidate_version"], decision=x["decision"], reason=x["reason"], reviewer=x["reviewer"], created_at=_iso(x["created_at"]))
               for x in c.execute("SELECT * FROM review_decisions WHERE parcel_id=%s ORDER BY id", (pid,))]
        v = c.execute("SELECT *, ST_AsGeoJSON(geom,15)::jsonb g FROM verified_geometries WHERE parcel_id=%s", (pid,)).fetchone()
        ver = Verified(parcel_id=pid, verified_geometry=v["g"], source_candidate_version=v["source_candidate_version"], verified_at=_iso(v["verified_at"]),
            review_decision_id=f"RD-{v['review_decision_id']:04d}", validation_result_id=v["validation_result_id"], validation_status=v["validation_status"]) if v else None
        vals = [ValidationRecord(id=x["id"], parcel_id=pid, candidate_version=x["candidate_version"], status=x["status"], checks=x["checks"], errors=x["errors"], warnings=x["warnings"],
                overlap_geometry=x["overlap_geojson"], validated_at=_iso(x["validated_at"])) for x in c.execute("SELECT * FROM validation_results WHERE parcel_id=%s ORDER BY id", (pid,))]
        hist = _audit_rows(c.execute("SELECT * FROM audit_events WHERE parcel_id=%s ORDER BY id", (pid,)).fetchall())
    return ReviewStatus(parcel_id=pid, state=st or "UNREVIEWED", latest_version=r["version"] if r else 0, reviewer=REVIEWER, decisions=dec, verified=ver, history=hist, validations=vals)

def verified_collection() -> dict:
    with connect() as c:
        rows = c.execute("SELECT parcel_id, source_candidate_version, validation_status, ST_AsGeoJSON(geom,15)::jsonb g FROM verified_geometries ORDER BY parcel_id").fetchall()
    return {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": r["g"], "properties": {"parcel_id": r["parcel_id"],
        "source_candidate_version": r["source_candidate_version"], "status": "VERIFIED", "validation": r["validation_status"]}} for r in rows]}
