import hashlib, json, psycopg, pytest
from fastapi.testclient import TestClient
from shapely import affinity
from shapely.geometry import mapping
import db, reconciliation as R
from candidates import check_geometry
from main import app

def gj(g): return json.loads(json.dumps(mapping(g)))
def rec(pid): return R._find("recorded", "recorded.geojson", pid)[0]
def hexg(c, g, srid=4326): return c.execute("SELECT ST_SetSRID(ST_GeomFromGeoJSON(%s),%s)::text h", (json.dumps(gj(g)), srid)).fetchone()["h"]
def run(g, pid="DEMO-001", srid=4326):
    with db.connect() as c: return check_geometry(c, pid, hexg(c, g, srid))
status = lambda r: {x.check: x.status for x in r["checks"]}
P = "DEMO-001"

def test_postgis_available_and_recorded_loaded():
    with db.connect() as c:
        assert c.execute("SELECT extname FROM pg_extension WHERE extname='postgis'").fetchone()
        assert c.execute("SELECT PostGIS_Version() v").fetchone()["v"].startswith("3")
        assert c.execute("SELECT count(*) n FROM recorded_parcels").fetchone()["n"] == 24
        assert c.execute("SELECT ST_SRID(geom) s FROM recorded_parcels LIMIT 1").fetchone()["s"] == 4326

def test_valid_geometry_and_shared_boundary_not_flagged():
    r = run(rec(P))   # identical to its own recorded parcel: touches neighbours along shared edges only
    assert set(status(r).values()) == {"PASS"} and not r["errors"]
    assert "expected adjacency" in next(x.message for x in r["checks"] if x.check == "NEIGHBOUR_OVERLAP")

def test_unexpected_overlap_detected_with_geometry():
    r = run(affinity.translate(rec("DEMO-018"), 0, 3e-5), "DEMO-018")   # ~3 m shift north into DEMO-024
    assert status(r)["NEIGHBOUR_OVERLAP"] == "FAIL" and r["errors"] and r["overlap"]["features"][0]["properties"]["overlap_m2"] > 5

def test_sliver_overlap_is_warning_not_failure():
    r = run(affinity.translate(rec(P), 1.2e-6, 0)); assert status(r)["NEIGHBOUR_OVERLAP"] == "WARN" and r["warnings"] and not r["errors"]

def test_invalid_empty_wrongtype_srid():
    bow = {"type": "Polygon", "coordinates": [[[80.9, 26.8], [80.9002, 26.8002], [80.9002, 26.8], [80.9, 26.8002], [80.9, 26.8]]]}
    with db.connect() as c:
        r = check_geometry(c, P, c.execute("SELECT ST_SetSRID(ST_GeomFromGeoJSON(%s),4326)::text h", (json.dumps(bow),)).fetchone()["h"])
        assert status(r)["GEOMETRY_VALIDITY"] == "FAIL" and status(r)["NEIGHBOUR_OVERLAP"] == "SKIP" and r["diagnostic"]   # MakeValid is diagnostic only
        assert status(check_geometry(c, P, c.execute("SELECT ST_GeomFromText('POLYGON EMPTY',4326)::text h").fetchone()["h"]))["EMPTY_GEOMETRY"] == "FAIL"
        assert status(check_geometry(c, P, c.execute("SELECT ST_SetSRID(ST_MakePoint(80.9,26.8),4326)::text h").fetchone()["h"]))["GEOMETRY_TYPE"] == "FAIL"
    assert status(run(rec(P), srid=3857))["SRID"] == "FAIL"

def test_db_guards_recorded_immutable_and_no_unvalidated_verified():
    with db.connect() as c:
        with pytest.raises(psycopg.errors.RaiseException): c.execute("UPDATE recorded_parcels SET parcel_id='X' WHERE parcel_id='DEMO-001'")
    with db.connect() as c:
        vid = c.execute("INSERT INTO validation_results(parcel_id,candidate_version,status,checks,errors,warnings) VALUES ('DEMO-001',1,'INVALID','[]','[]','[]') RETURNING id").fetchone()["id"]
        with pytest.raises(psycopg.errors.Error):   # CHECK/FK: an INVALID validation can never back a verified geometry
            c.execute("INSERT INTO verified_geometries(parcel_id,geom,source_candidate_version,review_decision_id,validation_result_id,validation_status) SELECT 'DEMO-001',geom,1,1,%s,'INVALID' FROM recorded_parcels WHERE parcel_id='DEMO-001'", (vid,))

def flow(c, pid, geometry=None):
    r = c.post(f"/api/reconciliation/{pid}").json()
    if geometry: c.put(f"/api/candidates/{pid}", json={"geometry": geometry})
    v = c.get(f"/api/candidates/{pid}").json()["candidate_version"]
    c.post(f"/api/review/{pid}/submit", json={"version": v}); c.post(f"/api/review/{pid}/approve", json={"version": v, "note": "ok"})
    return v, c.post(f"/api/validation/{pid}", json={"candidate_version": v})

def test_failed_validation_never_creates_verified():
    c = TestClient(app); h = hashlib.md5((R.DATA / "recorded/recorded.geojson").read_bytes()).hexdigest()
    v, r = flow(c, "DEMO-018"); j = r.json(); before = c.get("/api/candidates/DEMO-018").json()["geometry"]
    assert r.status_code == 200 and j["status"] == "INVALID" and j["verified"] is False and j["state"] == "CANDIDATE_REVIEW_REQUIRED" and j["overlap_geometry"]
    s = c.get("/api/review/DEMO-018").json()
    assert s["verified"] is None and c.get("/api/verified").json()["features"] == []
    assert s["decisions"][0]["decision"] == "APPROVED" and s["validations"][0]["status"] == "INVALID"      # approval and validation are separate records
    assert [e["event"] for e in s["history"]][-3:] == ["CANDIDATE_APPROVED", "VALIDATION_STARTED", "VALIDATION_FAILED"]
    assert c.post("/api/validation/DEMO-018", json={"candidate_version": v}).status_code == 409           # cannot re-run without a new cycle
    assert before == c.get("/api/candidates/DEMO-018").json()["geometry"] and h == hashlib.md5((R.DATA / "recorded/recorded.geojson").read_bytes()).hexdigest()

def test_successful_validation_creates_verified_with_provenance():
    c = TestClient(app); v, r = flow(c, "DEMO-001"); j = r.json(); cand = c.get("/api/candidates/DEMO-001").json()["geometry"]
    assert j["status"] == "VALID" and j["verified"] and all(x["status"] == "PASS" for x in j["checks"])
    s = c.get("/api/review/DEMO-001").json(); ver = s["verified"]
    assert s["state"] == "VERIFIED" and ver["source_candidate_version"] == v and ver["validation_result_id"] == j["id"] and ver["verified_geometry"] == cand
    assert [e["event"] for e in s["history"]][-4:] == ["CANDIDATE_APPROVED", "VALIDATION_STARTED", "VALIDATION_COMPLETED", "VERIFIED_GEOMETRY_CREATED"]

def test_validation_requires_approval():
    c = TestClient(app); c.post("/api/reconciliation/DEMO-001")
    assert c.post("/api/validation/DEMO-001", json={"candidate_version": 1}).status_code == 409
    assert c.post("/api/validation/DEMO-999", json={"candidate_version": 1}).status_code == 404
