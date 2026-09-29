import json, pathlib, geopandas as gpd
from fastapi.testclient import TestClient
from main import app
D = pathlib.Path(__file__).resolve().parents[1] / "data/demo"
def test_valid_and_crs():
    for sub, n in (("recorded", "recorded"), ("observed", "observed")):
        raw = json.loads((D / sub / f"{n}.geojson").read_text())
        assert raw["crs"]["properties"]["name"].endswith("4326")
        g = gpd.read_file(D / sub / f"{n}.geojson")
        assert g.geometry.is_valid.all() and len(g) > 0
def test_counts_and_link():
    s = TestClient(app).get("/api/summary").json()
    assert s == {"recorded": 24, "observed": 28, "flagged": 6, "verified": 0}
    ids = {f["properties"]["parcel_id"] for f in json.loads((D/"recorded/recorded.geojson").read_text())["features"]}
    assert all(f["properties"]["parcel_id"] in ids for f in json.loads((D/"observed/observed.geojson").read_text())["features"])
