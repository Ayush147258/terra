import hashlib, json, pytest
from fastapi.testclient import TestClient
from shapely import affinity
from shapely.geometry import mapping
import reconciliation as R
from main import app
P = "DEMO-018"
@pytest.fixture
def c(): return TestClient(app)
def rhash(): return hashlib.md5((R.DATA / "recorded/recorded.geojson").read_bytes()).hexdigest()
def moved(dx): return json.loads(json.dumps(mapping(affinity.translate(R._find("recorded", "recorded.geojson", P)[0], dx, 0))))
def review(c): return c.get(f"/api/review/{P}").json()
def act(c, a, **b): return c.post(f"/api/review/{P}/{a}", json=b)

def test_full_approve_flow_and_integrity(c):
    h = rhash(); c.post(f"/api/reconciliation/{P}")
    assert review(c)["state"] == "CANDIDATE_READY" and review(c)["verified"] is None       # no automatic verification
    c.put(f"/api/candidates/{P}", json={"geometry": moved(2e-6)})                              # v2
    cand_before = c.get(f"/api/candidates/{P}").json()["geometry"]
    assert act(c, "submit", version=2).json()["state"] == "IN_REVIEW"
    r = act(c, "approve", version=2, note="looks right").json()
    assert r["state"] == "APPROVED_PENDING_VALIDATION" and r["verified"] is None            # approval alone never verifies
    r = c.post(f"/api/validation/{P}", json={"candidate_version": 2}).json(); assert r["verified"]
    r = review(c); v = r["verified"]; assert r["state"] == "VERIFIED" and v["source_candidate_version"] == 2 and v["review_decision_id"] == r["decisions"][0]["id"]
    assert v["verified_geometry"] == cand_before and c.get(f"/api/candidates/{P}").json()["geometry"] == cand_before   # candidate unchanged
    assert rhash() == h                                                                        # recorded unchanged
    assert [e["event"] for e in r["history"]] == ["Candidate created", "Candidate geometry edited", "Candidate submitted for review", "CANDIDATE_APPROVED", "VALIDATION_STARTED", "VALIDATION_COMPLETED", "VERIFIED_GEOMETRY_CREATED"]
    assert c.get("/api/verified").json()["features"][0]["properties"]["parcel_id"] == P

def test_reject_reason_stored_reedit_then_approve(c):
    c.post(f"/api/reconciliation/{P}"); act(c, "submit", version=1)
    assert act(c, "reject", version=1, reason="  ").status_code == 422                        # reason required
    r = act(c, "reject", version=1, reason="Boundary inconsistent").json()
    assert r["state"] == "REJECTED" and r["verified"] is None and r["decisions"][0]["reason"] == "Boundary inconsistent"
    assert act(c, "approve", version=1).status_code == 409                                     # rejected cannot be approved
    assert c.put(f"/api/candidates/{P}", json={"geometry": moved(3e-6)}).json()["candidate_version"] == 2
    assert review(c)["state"] == "CANDIDATE_READY" and len(review(c)["decisions"]) == 1        # decision history kept
    act(c, "submit", version=2); act(c, "approve", version=2); c.post(f"/api/validation/{P}", json={"candidate_version": 2}); r = review(c)
    assert r["state"] == "VERIFIED" and r["verified"]["source_candidate_version"] == 2 and [d["decision"] for d in r["decisions"]] == ["REJECTED", "APPROVED"]

def test_invalid_transitions(c):
    assert act(c, "submit", version=1).status_code == 409                                      # no candidate
    assert act(c, "approve", version=1).status_code == 409 and act(c, "reject", version=1, reason="xxx").status_code == 409
    c.post(f"/api/reconciliation/{P}")
    assert act(c, "approve", version=1).status_code == 409                                     # not yet in review: no skipping
    assert act(c, "submit", version=9).status_code == 409                                      # wrong version
    act(c, "submit", version=1); assert act(c, "submit", version=1).status_code == 409
    c.put(f"/api/candidates/{P}", json={"geometry": moved(1e-6)})                              # edit during review -> pending again
    assert review(c)["state"] == "CANDIDATE_READY" and act(c, "approve", version=2).status_code == 409
    act(c, "submit", version=2); act(c, "approve", version=2); c.post(f"/api/validation/{P}", json={"candidate_version": 2})
    assert act(c, "reject", version=2, reason="late").status_code == 409                       # verified cannot be rejected
    assert c.get("/api/review/DEMO-999").status_code == 404 and act(c, "submit", version=1).status_code == 409

def test_review_status_unreviewed(c):
    assert review(c)["state"] == "UNREVIEWED" and review(c)["history"] == []
