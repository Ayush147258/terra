import json, pathlib
from typing import Any, Literal, Optional
import geopandas as gpd
from pydantic import BaseModel
from shapely import make_valid
from shapely.geometry import shape, mapping, Polygon, MultiPolygon
from shapely.ops import snap
from config import THRESHOLDS as T

DATA = pathlib.Path(__file__).resolve().parents[1] / "data" / "demo"

class ReconError(Exception):
    def __init__(self, status: int, message: str): self.status, self.message = status, message

class ReconciliationResult(BaseModel):
    parcel_id: str
    recorded_area: float
    observed_area: float
    area_difference: float
    area_difference_percent: float
    intersection_area: float
    overlap_percent: float
    symmetric_difference_area: float
    boundary_deviation: float
    discrepancy_status: Literal["MATCH", "MINOR_DISCREPANCY", "MAJOR_DISCREPANCY"]
    discrepancy_reasons: list[str]
    recorded_geometry: dict[str, Any]
    observed_geometry: dict[str, Any]
    candidate_geometry: dict[str, Any]
    discrepancy_geometry: Optional[dict[str, Any]]
    candidate_status: str = "CANDIDATE — pending HUMAN REVIEW (not verified)"

def _poly(g):
    if isinstance(g, MultiPolygon): g = max(g.geoms, key=lambda x: x.area)
    if isinstance(g, Polygon): return g
    raise ReconError(422, "Geometry could not be reduced to a polygon")

def _check(g, name):
    if g is None or g.is_empty or not g.is_valid or g.geom_type not in ("Polygon", "MultiPolygon"):
        raise ReconError(422, f"{name} geometry is invalid")
    return g

def reconcile_geometries(parcel_id: str, recorded, observed, crs: Optional[str]) -> ReconciliationResult:
    """Pure function; inputs are never mutated. All metrics computed in a projected metric CRS."""
    if not crs: raise ReconError(422, "Geometry CRS is not defined")
    try:
        rs, os_ = gpd.GeoSeries([_check(recorded, "Recorded")], crs=crs), gpd.GeoSeries([_check(observed, "Observed")], crs=crs)
        mcrs = rs.estimate_utm_crs() if rs.crs.is_geographic else rs.crs
        r, o = rs.to_crs(mcrs).iloc[0], os_.to_crs(mcrs).iloc[0]
        inter, sym = r.intersection(o), r.symmetric_difference(o)
        ra, oa = r.area, o.area
        dpct = (oa - ra) / ra * 100
        ovl = inter.area / ra * 100
        dev = r.boundary.hausdorff_distance(o.boundary)
        cand = _poly(make_valid(snap(o.simplify(T["candidate_simplify_m"]), r, T["candidate_snap_m"])))
        reasons = []
        if abs(dpct) >= T["match_area_pct"]: reasons.append(f"Area differs by {dpct:+.1f}%")
        if dev >= T["match_deviation_m"]: reasons.append(f"Boundary deviation detected ({dev:.1f} m)")
        if ovl < T["major_overlap_pct"]: reasons.append(f"Low spatial overlap ({ovl:.1f}%)")
        if sym.area / ra * 100 >= T["symdiff_pct"]: reasons.append(f"Significant symmetric difference ({sym.area:.1f} m²)")
        if abs(dpct) >= T["major_area_pct"] or ovl < T["major_overlap_pct"] or dev >= T["major_deviation_m"]: st = "MAJOR_DISCREPANCY"
        elif abs(dpct) < T["match_area_pct"] and ovl >= T["match_overlap_pct"] and dev < T["match_deviation_m"]: st = "MATCH"
        else: st = "MINOR_DISCREPANCY"
        out = lambda g: None if g.is_empty else mapping(gpd.GeoSeries([g], crs=mcrs).to_crs("EPSG:4326").iloc[0])
        return ReconciliationResult(parcel_id=parcel_id, recorded_area=round(ra, 2), observed_area=round(oa, 2),
            area_difference=round(oa - ra, 2), area_difference_percent=round(dpct, 2), intersection_area=round(inter.area, 2),
            overlap_percent=round(ovl, 2), symmetric_difference_area=round(sym.area, 2), boundary_deviation=round(dev, 2),
            discrepancy_status=st, discrepancy_reasons=reasons, recorded_geometry=out(r), observed_geometry=out(o),
            candidate_geometry=out(cand), discrepancy_geometry=out(sym))
    except ReconError: raise
    except Exception: raise ReconError(500, "Reconciliation failed due to an unexpected geometry error")

def _find(sub, name, parcel_id):
    d = json.loads((DATA / sub / name).read_text())
    crs = (d.get("crs") or {}).get("properties", {}).get("name")
    crs = "EPSG:4326" if crs and crs.endswith("4326") else None
    for f in d["features"]:
        if f["properties"].get("parcel_id") == parcel_id: return shape(f["geometry"]), crs
    return None, crs

def reconcile_parcel(parcel_id: str) -> ReconciliationResult:
    rec, crs = _find("recorded", "recorded.geojson", parcel_id)
    if rec is None: raise ReconError(404, f"Parcel {parcel_id} not found")
    obs, _ = _find("observed", "observed_extent.geojson", parcel_id)
    if obs is None: raise ReconError(404, f"No observed geometry for {parcel_id}")
    return reconcile_geometries(parcel_id, rec, obs, crs)
