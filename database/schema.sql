-- Reference copy of the schema applied automatically by backend/db.py:init_schema() at API startup.
-- Requires PostgreSQL 14+ with PostGIS (CREATE EXTENSION postgis must be permitted or pre-created by a superuser).
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS recorded_parcels(parcel_id text PRIMARY KEY, geom geometry(Polygon,4326) NOT NULL);
CREATE INDEX IF NOT EXISTS recorded_gix ON recorded_parcels USING GIST(geom);
CREATE OR REPLACE FUNCTION forbid_recorded_change() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'recorded_parcels is immutable'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS recorded_immutable ON recorded_parcels;
CREATE TRIGGER recorded_immutable BEFORE UPDATE OR DELETE ON recorded_parcels FOR EACH ROW EXECUTE FUNCTION forbid_recorded_change();
CREATE TABLE IF NOT EXISTS candidate_versions(parcel_id text NOT NULL, version int NOT NULL, geom geometry NOT NULL, source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(parcel_id, version));
CREATE TABLE IF NOT EXISTS review_state(parcel_id text PRIMARY KEY, state text NOT NULL);
CREATE TABLE IF NOT EXISTS review_decisions(id serial PRIMARY KEY, parcel_id text NOT NULL, candidate_version int NOT NULL,
  decision text NOT NULL CHECK (decision IN ('APPROVED','REJECTED')), reason text NOT NULL DEFAULT '', reviewer text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS validation_results(id serial PRIMARY KEY, parcel_id text NOT NULL, candidate_version int NOT NULL, decision_id int,
  status text NOT NULL CHECK (status IN ('VALID','WARNING','INVALID')), checks jsonb NOT NULL, errors jsonb NOT NULL, warnings jsonb NOT NULL,
  overlap_geojson jsonb, validated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id, status));
CREATE TABLE IF NOT EXISTS verified_geometries(parcel_id text PRIMARY KEY, geom geometry(Polygon,4326) NOT NULL, source_candidate_version int NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(), review_decision_id int NOT NULL, validation_result_id int NOT NULL,
  validation_status text NOT NULL CHECK (validation_status IN ('VALID','WARNING')),
  FOREIGN KEY (validation_result_id, validation_status) REFERENCES validation_results(id, status));  -- DB-level: no VERIFIED without a passing validation
CREATE TABLE IF NOT EXISTS audit_events(id serial PRIMARY KEY, parcel_id text NOT NULL, event text NOT NULL, version int NOT NULL DEFAULT 0,
  detail text, status text, created_at timestamptz NOT NULL DEFAULT now());
