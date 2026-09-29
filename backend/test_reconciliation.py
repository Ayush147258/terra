import hashlib, pathlib, pytest
from shapely.geometry import Polygon, box
from shapely import affinity
import geopandas as gpd
from fastapi.testclient import TestClient
from main import app
from reconciliation import reconcile_geometries, ReconError, DATA

def to4326(g):  # metric square near Lucknow (UTM 44N) -> lon/lat
    return gpd.GeoSeries([g], crs="EPSG:32644").to_crs("EPSG:4326").iloc[0]
BASE = box(330000, 2969000, 330010, 2969020)  # 10 x 20 m = 200 m2
run = lambda o: reconcile_geometries("T", to4326(BASE), to4326(o), "EPSG:4326")

def test_identical_is_match():
    r = run(BASE)
    assert r.area_difference == 0 and r.overlap_percent == 100 and r.discrepancy_status == "MATCH" and r.discrepancy_reasons == []

def test_slight_difference():
    r = run(affinity.translate(affinity.scale(BASE, 1.03, 1.03), 0.9, 0.5))
    assert r.area_difference_percent > 2 and r.discrepancy_status == "MINOR_DISCREPANCY" and r.discrepancy_reasons

def test_clear_difference_is_major_and_larger():
    small = run(affinity.translate(BASE, 0.9, 0.5))
    big = run(affinity.translate(affinity.scale(BASE, 1.2, 1.2), 4, 4))
    assert big.discrepancy_status == "MAJOR_DISCREPANCY"
    assert big.symmetric_difference_area > small.symmetric_difference_area
    assert big.boundary_deviation > small.boundary_deviation

def test_metric_correctness_from_geographic():
    r = run(BASE)
    assert r.recorded_area == pytest.approx(200, rel=0.01)  # UTM scale factor; NOT ~1e-9 deg2
    r2 = run(affinity.translate(BASE, 3, 0))
    assert r2.boundary_deviation == pytest.approx(3, abs=0.1)

def test_invalid_geometry_and_missing_crs():
    bow = Polygon([(0, 0), (1, 1), (1, 0), (0, 1)])
    with pytest.raises(ReconError) as e: reconcile_geometries("T", to4326(BASE), bow, "EPSG:4326")
    assert e.value.status == 422
    with pytest.raises(ReconError): reconcile_geometries("T", to4326(BASE), to4326(BASE), None)

def test_candidate_separate_and_valid():
    r = run(affinity.translate(BASE, 1, 1))
    assert r.candidate_geometry["type"] == "Polygon" and "not verified" in r.candidate_status
    assert r.recorded_geometry != r.candidate_geometry

def test_api_missing_and_success_and_immutability():
    c = TestClient(app)
    files = list(DATA.rglob("*.geojson")); before = [hashlib.md5(f.read_bytes()).hexdigest() for f in files]
    assert c.post("/api/reconciliation/DEMO-999").status_code == 404
    j = c.post("/api/reconciliation/DEMO-018").json()
    assert j["discrepancy_status"] == "MAJOR_DISCREPANCY" and j["discrepancy_geometry"]
    assert before == [hashlib.md5(f.read_bytes()).hexdigest() for f in files]
