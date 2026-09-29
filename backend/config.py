"""Reconciliation thresholds. DEMO / POC values ONLY — NOT legal surveying standards.
Terra does not determine legal boundary correctness; results are inputs to HUMAN REVIEW."""
THRESHOLDS = {
    "match_area_pct": 2.0,    # |area diff| below this (%) is within MATCH tolerance
    "match_overlap_pct": 97.0,
    "match_deviation_m": 0.6,  # Hausdorff boundary deviation (m)
    "major_area_pct": 8.0,     # at/above any "major_*" value -> MAJOR_DISCREPANCY
    "major_overlap_pct": 90.0,
    "major_deviation_m": 2.0,
    "symdiff_pct": 10.0,       # symmetric difference as % of recorded area -> reason shown
    "candidate_simplify_m": 0.25,
    "candidate_snap_m": 0.5,
}

# Topology thresholds (DEMO / POC values, NOT legal survey standards). Overlap = AREA of interior intersection with a
# neighbouring RECORDED parcel, computed by PostGIS on geography (m2). Boundary-only contact (ST_Touches) is expected adjacency.
VALIDATION = {"overlap_fail_m2": 5.0, "overlap_warn_m2": 0.5}
