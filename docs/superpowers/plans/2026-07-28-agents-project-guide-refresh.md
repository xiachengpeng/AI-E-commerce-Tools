# AGENTS Project Guide Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the outdated root `AGENTS.md` with a concise, accurate guide to the current application architecture, workflows, commands, local state, and implementation constraints.

**Architecture:** Keep one root guide because the project remains a single FastAPI application with a static vanilla frontend. Organize stable facts by responsibility rather than copying volatile route or function inventories.

**Tech Stack:** Markdown, FastAPI, SQLAlchemy/SQLite, vanilla JavaScript, Tailwind CSS, pytest, Node.js built-in test runner.

## Global Constraints

- Preserve the instruction that root `AGENTS.md` replaces earlier AGENTS instructions.
- Do not include secrets, local credential values, fixed test counts, or exhaustive route lists.
- Document only paths and commands verified against the current worktree.
- Keep AI calls behind the backend capability router.
- Preserve current detail-page, settings/logging, history, square-redraw, and competitor-analysis invariants.

---

### Task 1: Rewrite and Verify the Root Project Guide

**Files:**
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: current repository structure, `frontend/package.json`, `run.py`, backend services, and frontend modules.
- Produces: the authoritative root development guide for future agents.

- [ ] **Step 1: Rewrite `AGENTS.md`**

Use these sections:

1. `Project Overview`
2. `Runtime Architecture`
3. `Feature And Frontend Map`
4. `Backend Service Map`
5. `AI Routing And Settings`
6. `Setup, Run, Build, And Test`
7. `Local State And Secrets`
8. `Implementation Invariants`
9. `Working Tree Hygiene`

Document stable commands:

```bash
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
.venv/bin/python run.py
cd frontend && npm install
cd frontend && npm run build:css
node --test frontend/tests/*.test.js
.venv/bin/python -m pytest backend/tests
node --check frontend/js/<changed-file>.js
```

Document the AI chain:

```text
frontend callAI(capability, payload)
  -> POST /api/ai/generate
  -> AIRouter
  -> SQLite capability binding/provider snapshot
  -> Gemini, Vertex, or OpenAI Compatible adapter
  -> normalized frontend response
```

- [ ] **Step 2: Validate referenced paths**

Run:

```bash
for path in \
  run.py backend/main.py backend/db.py backend/config.py \
  backend/services/ai_router.py backend/services/ai_adapters.py \
  backend/services/ai_config_service.py backend/services/app_log_service.py \
  backend/services/square_redraw_service.py \
  frontend/index.html frontend/js/app.js frontend/js/settings.js \
  frontend/js/details.js frontend/js/square_redraw.js \
  frontend/js/text_translate.js frontend/js/translate.js \
  frontend/js/listing.js frontend/js/ads.js frontend/js/analysis.js \
  frontend/css/input.css frontend/tailwind.config.js frontend/package.json; do
  test -e "$path" || exit 1
done
```

Expected: exit 0.

- [ ] **Step 3: Validate documented commands and content**

Run:

```bash
node -e 'const p=require("./frontend/package.json"); if (!p.scripts["build:css"] || !p.scripts["watch:css"]) process.exit(1)'
rg -n 'TBD|TODO|PLACEHOLDER|nvapi-|sk-[A-Za-z0-9]' AGENTS.md
git diff --check
```

Expected: package-script check exits 0, sensitive/placeholder scan returns no matches, and diff check exits 0.

- [ ] **Step 4: Run regression tests**

Run:

```bash
node --test frontend/tests/*.test.js
".venv/bin/python" -m pytest backend/tests
```

Expected: both suites exit 0.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md
git commit -m "docs: refresh project agent guide"
```
