import hashlib, json, pytest
from fastapi.testclient import TestClient
import candidates as C, reconciliation as R
from main import app

@pytest.fixture
def client(): return TestClient(app)
def rec_geom(): return R._find("recorded", "recorded.geojson", "DEMO-018")[0]
def cand(dx=0.0):
    from shapely.geometry import mapping
    from shapely import affinity
    return json.loads(json.dumps(mapping(affinity.translate(rec_geom(), dx, 0))))
def recorded_hash(): return hashlib.md5((R.DATA / "recorded/recorded.geojson").read_bytes()).hexdigest()

def test_valid_save_and_versions_and_recorded_untouched(client):
    h = recorded_hash()
    a = client.put("/api/candidates/DEMO-018", json={"geometry": cand()}).json()
    b = client.put("/api/candidates/DEMO-018", json={"geometry": cand(1e-6)}).json()
    assert (a["candidate_version"], b["candidate_version"]) == (1, 2) and a["is_valid"]
    assert client.get("/api/candidates/DEMO-018").json()["candidate_version"] == 2   # persisted
    assert recorded_hash() == h
    assert [e["version"] for e in client.get("/api/audit").json()] == [1, 2]

def test_invalid_rejected_and_not_stored(client):
    bow = {"type": "Polygon", "coordinates": [[[80.0, 26.0], [80.0001, 26.0001], [80.0001, 26.0], [80.0, 26.0001], [80.0, 26.0]]]}
    r = client.put("/api/candidates/DEMO-018", json={"geometry": bow}); assert r.status_code == 422
    c = cand(); c["coordinates"][0][1] = [200, 95]
    assert client.put("/api/candidates/DEMO-018", json={"geometry": c}).status_code == 422
    assert client.put("/api/candidates/DEMO-018", json={"geometry": {"type": "Point", "coordinates": [80, 26]}}).status_code == 422
    assert client.get("/api/candidates/DEMO-018").status_code == 404 and client.get("/api/audit").json() == []

def test_selfintersection_message_explains(client):
    r = client.put("/api/candidates/DEMO-018", json={"geometry": {"type": "Polygon", "coordinates": [[[80, 26], [80.1, 26.1], [80.1, 26], [80, 26.1], [80, 26]]]}})
    assert r.status_code == 422 and "INVALID" in r.json()["detail"]

def test_malformed_and_missing(client):
    assert client.put("/api/candidates/DEMO-018", json={"geometry": {"type": "Polygon"}}).status_code == 422
    assert client.put("/api/candidates/DEMO-018", json={"nope": 1}).status_code == 422
    assert client.put("/api/candidates/DEMO-999", json={"geometry": cand()}).status_code == 404

def test_evaluate_exact_metrics(client):
    m = client.post("/api/candidates/DEMO-018/evaluate", json={"geometry": cand()}).json()
    assert m["overlap_percent"] == 100 and m["area_difference"] == 0
