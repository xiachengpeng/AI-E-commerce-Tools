# Project Notes

## Overview

AI E-commerce Tools is a local FastAPI plus vanilla frontend application for cross-border e-commerce workflows:

- Competitor analysis from product URLs.
- Listing generation.
- Image translation and rendering.
- Batch text localization.
- History persistence through SQLite.

## Entry Points

- App launcher: `run.py`
- Backend app: `backend/main.py`
- Frontend page: `frontend/index.html`
- Main frontend bootstrap: `frontend/js/app.js`
- Competitor analysis frontend: `frontend/js/analysis.js`
- Competitor analysis styling: `frontend/css/analysis.css`

## Run Commands

- Install backend dependencies: `pip install -r backend/requirements.txt`
- Start full local app: `python run.py`
- Backend URL: `http://localhost:8000`
- Frontend URL: `http://localhost:8080/index.html`
- Frontend CSS build: `cd frontend && npm run build:css`
- Frontend CSS watch: `cd frontend && npm run watch:css`

## Tests And Checks

- Backend tests: `python -m pytest backend/tests`
- Frontend syntax check example: `node --check frontend/js/analysis.js`

## Important Directories

- `backend/models/`: API request and response models.
- `backend/services/`: AI calls, Firecrawl scraping, parsing, scoring, and cleanup logic.
- `backend/tests/`: backend unit tests.
- `frontend/js/`: UI modules and API calls.
- `frontend/css/`: app CSS and Tailwind input.
- `backend/static/`: generated local assets; ignored by Git.
- `debug/`: local test scripts and secrets; ignored by Git and must not be uploaded.
- `.claude/`: local tool state; leave it alone unless explicitly requested.

## Secrets And Local State

Do not commit or upload:

- `debug/`
- `.env`, `backend/.env`, `.env.local`
- `backend/history.db`
- generated files under `backend/static/`
- local tool folders such as `.claude/` and `.codex-run-logs/`

## Implementation Notes

- AI calls should go through the backend proxy/service layer, not directly from the browser.
- The current Gemini/Vertex integration is in `backend/services/ai_service.py`.
- Competitor analysis scoring is deterministic in backend code; frontend display should stay consistent with backend scores.
- For URL analysis refreshes, do not clear existing rendered data until the new response succeeds.
- Preserve existing user changes in the working tree. Avoid reverting unrelated files.

