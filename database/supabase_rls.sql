-- Run ONCE in the Supabase SQL editor AFTER the API has started (it creates the tables) and postgis is enabled.
-- Blocks access through Supabase's public REST API; the backend connects as the postgres role, which bypasses RLS.
ALTER TABLE recorded_parcels, candidate_versions, review_state, review_decisions,
  validation_results, verified_geometries, audit_events ENABLE ROW LEVEL SECURITY;
