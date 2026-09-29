import os
os.environ["DATABASE_URL"] = os.environ.get("TEST_DATABASE_URL", "postgresql://terra:terra_local_only@localhost:5432/terra_test")
import pytest, db
@pytest.fixture(scope="session", autouse=True)
def _schema(): db.init_schema()   # fails loudly if PostGIS is unavailable
@pytest.fixture(autouse=True)
def _clean():
    with db.connect() as c:
        c.execute("TRUNCATE audit_events, verified_geometries, validation_results, review_decisions, review_state, candidate_versions RESTART IDENTITY CASCADE")
