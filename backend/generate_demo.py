"""Deterministic DEMO / POC dataset generator (synthetic, NOT real cadastral data)."""
import json, random, pathlib
import geopandas as gpd
from shapely.geometry import Polygon
from shapely import affinity

ROOT = pathlib.Path(__file__).resolve().parents[1]
METRIC, GEO = "EPSG:32644", "EPSG:4326"
COLS, ROWS, W, D, X0, Y0 = 6, 4, 16.0, 20.0, 330000.0, 2969000.0
rnd = random.Random(42)
pts = {(i, j): (X0 + i * W + rnd.uniform(-1.2, 1.2) * (0 < i < COLS),
                Y0 + j * D + rnd.uniform(-1.5, 1.5) * (0 < j < ROWS))
       for i in range(COLS + 1) for j in range(ROWS + 1)}
parcels = []
for j in range(ROWS):
    for i in range(COLS):
        parcels.append((f"DEMO-{len(parcels)+1:03d}",
                        Polygon([pts[i, j], pts[i+1, j], pts[i+1, j+1], pts[i, j+1]])))

inject = {"DEMO-004": ("shift", (7, 5)), "DEMO-009": ("oversize", 2.7), "DEMO-011": ("rotate", 35),
          "DEMO-016": ("shift", (-6, 6)), "DEMO-018": ("shift", (5, -6)), "DEMO-022": ("oversize", 2.5)}
obs = []
for pid, p in parcels:
    b, kind = affinity.scale(p, 0.5, 0.5), "building"
    if pid in inject:
        k, v = inject[pid]
        b = (affinity.translate(b, *v) if k == "shift"
             else affinity.scale(b, v, v) if k == "oversize" else affinity.rotate(affinity.scale(b, 1.8, 1.8), v))
        kind = f"building ({k})"
    obs.append((pid, kind, b, p))
    if int(pid[-3:]) % 4 == 0 and pid not in inject:
        o = affinity.translate(affinity.scale(p, 0.14, 0.14), -W * 0.3, -D * 0.32)
        obs.append((pid, "outbuilding", o, p))

rec = gpd.GeoDataFrame(
    [{"parcel_id": pid, "status": "RECORDED", "source": "Demo cadastral dataset (synthetic)",
      "geometry_type": "Polygon", "area_m2": round(g.area, 1), "dataset": "DEMO / POC DATA"}
     for pid, g in parcels], geometry=[g for _, g in parcels], crs=METRIC)
rows = []
for n, (pid, kind, g, p) in enumerate(obs, 1):
    outside = g.difference(p).area / g.area
    rows.append({"feature_id": f"OBS-{n:03d}", "parcel_id": pid, "kind": kind, "area_m2": round(g.area, 1),
                 "outside_ratio": round(outside, 3), "flagged": bool(outside > 0.05),
                 "source": "Synthetic observed footprint (not AI output)", "status": "OBSERVED",
                 "dataset": "DEMO / POC DATA"})
ob = gpd.GeoDataFrame(rows, geometry=[o[2] for o in obs], crs=METRIC)

CRS = {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::4326"}}

def emit(d, sub, name):
    d["crs"], d["name"] = CRS, "DEMO / POC DATA"
    for dst in (ROOT / "data/demo" / sub / name, ROOT / "frontend/public/data" / name):
        dst.write_text(json.dumps(d))

def write(gdf, sub, name):
    assert gdf.crs is not None and gdf.geometry.is_valid.all() and not gdf.geometry.is_empty.any()
    emit(json.loads(gdf.to_crs(GEO).to_json(drop_id=True)), sub, name)

write(rec, "recorded", "recorded.geojson")
write(ob, "observed", "observed.geojson")
emit({"type": "FeatureCollection", "features": []}, "candidates", "candidates.geojson")
print(len(rec), "recorded;", len(ob), "observed;", int(ob.flagged.sum()), "flagged")

# ---- Phase 2: observed parcel-extent delineations (synthetic stand-in for imagery-derived boundaries) ----
r2 = random.Random(7)
minor = {"DEMO-003": ((0.9, 0.5), 1.03), "DEMO-007": ((-0.8, 0.6), 1.025), "DEMO-013": ((0.5, -0.9), 0.97), "DEMO-020": ((0.7, 0.7), 1.03)}
major = {"DEMO-004": ((3.2, 2.4), 1.10), "DEMO-009": ((-2.6, 2.0), 1.18), "DEMO-011": ((1.5, -2.8), 1.06),
         "DEMO-016": ((-3.0, -1.5), 0.85), "DEMO-018": ((2.4, 3.0), 1.12), "DEMO-022": ((-2.2, -2.6), 1.15)}
geoms, ext = [], []
for pid, p in parcels:
    (dx, dy), sc = minor.get(pid) or major.get(pid) or ((r2.uniform(-.12, .12), r2.uniform(-.12, .12)), 1 + r2.uniform(-.004, .004))
    geoms.append(affinity.translate(affinity.scale(p, sc, sc), dx, dy))
    ext.append({"parcel_id": pid, "kind": "parcel extent", "status": "OBSERVED", "dataset": "DEMO / POC DATA",
                "source": "Synthetic observed extent (not AI output)"})
write(gpd.GeoDataFrame(ext, geometry=geoms, crs=METRIC), "observed", "observed_extent.geojson")
