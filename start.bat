@echo off
REM Offline start. Requires PostgreSQL+PostGIS on localhost:5432 (e.g. `docker compose up -d db`).
pip install -r backend\requirements.txt
python backend\generate_demo.py
start "Terra API" cmd /k "cd backend && uvicorn main:app --port 8000"
cd frontend && (if not exist node_modules npm install) && npm run dev
