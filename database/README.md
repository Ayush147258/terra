Schema is applied idempotently by `backend/db.py` on API startup; `schema.sql` is a reference copy for manual/managed databases.
Local DB: `docker compose up -d db`, or create role/db `terra` and run `CREATE EXTENSION postgis;` as a superuser (tests also need DB `terra_test`).
