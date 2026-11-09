# Original Image Canvas Restoration Implementation Plan

**Goal:** Restore the upstream image canvas interaction, model picker, settings and image tools, excluding video, audio and Agent as requested.

**Architecture:** Preserve the pinned upstream React components wherever possible, bridge their image model selection and settings to the existing local backend and provider configurations without exposing credentials. Preserve existing node projects and original canvas data; never auto-submit paid tasks during tests.

**Tech Stack:** React/Vite, FastAPI, SQLite, Node test runner, pytest.

**Spec:** User instruction on 2026-10-29 and `docs/superpowers/specs/2026-10-28-infinite-canvas-redesign.md`, superseded where the user requests original image behavior.

## Global Constraints

- Restore original image UI and interactions; omit video, audio, and Agent.
- Keep browser AI calls on the local backend; do not expose credentials.
- Preserve old canvases, provenance, confirmation, and uncertain task recovery.
- Do not submit real paid jobs while verifying.

## Tasks

- [ ] Map upstream image UI and implement original model picker and image settings with server-backed selection and parameter propagation; test source and backend payloads.
- [ ] Restore image assets, prompt library, and image editing controls without cross-project data loss or unsupported placeholders; verify with isolated data.
- [ ] Verify generation and editing using mock providers, saved canvas restore and other modules, obtain independent review, and update personal client with rollback.
