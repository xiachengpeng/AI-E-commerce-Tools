# Task 21 local runtime acceptance

Accepted implementation: `9d91c9ff5c311259d119a7aaf2d446cfa7c518f3`.
The controller approved the offline code gate before the owned runtime was restarted on 2026-10-15.

## Actual runtime

The main API and frontend use ports 9503 and 9502. The launcher owns one worker process containing both native and legacy queue loops under the same exclusive owner lock. The canonical primary `backend/history.db`, primary Python/environment, permanent private research root, and primary static assets remain authoritative. The primary code checkout has not received the final Task 22 handoff; the accepted staged code is running with those primary resources.

Actual startup succeeded with SSH blocked by an explicit failing shim: no invocation occurred and port 19503 remained closed. The worker's heartbeat was fresh, a second exclusive-lock acquisition was refused, and only the owned API and worker held the canonical database. A 294-second observation found one Python worker entrypoint and no worker TCP connections. Local queue/usage/outbox/provider log tables remained unchanged; no collection, generation, sync, upload, cancellation, or provider test was submitted. The source-off assertion relies on accepted Task 20 freeze/autostart-disable evidence; Task 21 did not contact or revive the source.

The actual browser entered the native research workbench without an opt-in. Projects, integration settings, history, reports, exploration, keyword paths, action queue, triage, and product records rendered locally. All ten product workflow steps were navigable. No research iframe or external workbench control existed. Verification used read-only navigation; the temporary verification tab was closed and the existing user tab/drafts/profile were retained.

Authenticated native session/projects/provider-settings/AI-settings reads returned 200 with `no-store`; missing-token and cross-origin requests returned 401 and 403. The compatibility session exposed no remote or embed URL. The compatibility projects read returned 200 but has no explicit `no-store` header; this existing behavior is recorded rather than represented as native-header coverage.

## Preserved data

Fresh pre-restart incremental SQLite backup was independently verified. All current table hashes except the expected native heartbeat were identical after restart and browser/idle verification. This includes current provider and binding rows, ownership generation/signature, and the exact six quarantined resources with attempts and payload identities. All 147 evidence files, 87 version IDs, signing material, and 120 static asset byte/path identities were unchanged.

One provider's balance-display metadata had legitimately changed since the Task 20 anchor. Only `updated_at`, `last_balance_text`, and `last_balance_at` differed; credentials, models, routing, enabled state and bindings were unchanged. The controller explicitly adopted the current row as the restart baseline. No old provider row or database was restored. The other 17 original main tables and 13 source business tables matched their accepted anchors.

## Compatibility and limits

The original five implemented legacy pipeline kinds retain their actual behavior. Five enum-only direct-dispatch kinds retain explicit `needs_human` / `unsupported_job_kind` behavior; they are not ten successful legacy handlers. Historical completed writeback receipts remain readable without replay. Native equivalent workflows remain available.

The final offline verification suffix was 53 passing focused tests after the observer amendments. Earlier acceptance was 261 focused backend passes, 123 frontend passes, and 54 original-source passes with one pre-existing PostgreSQL-only skip. Baseline deprecation/schema warnings remain recorded in the private report.

The outer legacy AI manual-reconciliation assertion is proven at the tested injected pipeline seam. Original real extraction can catch an error, preserve a failed extraction checkpoint and continue under its existing evidence rules; the durable uncertain reservation still blocks another submission. Real-path coverage and extraction telemetry exception bookkeeping remain Task 22 follow-ups.

The old API initially waited on an existing browser settings SSE connection after normal launcher shutdown. A bounded second interrupt did not finish it. Navigating only that matching existing tab away from Settings invoked its existing log-disconnect function; the old API then exited naturally. All old database holders closed before the new launcher started. No browser kill, SIGKILL, unrelated-process control or draft clearing was used. Graceful SSE shutdown robustness remains a final triage item.

The browser installer had removed old cache binaries during implementation. Official exact revision/version 1234 was restored alongside required 1243, and all four binaries plus primary default resolution passed offline blank-page launches. No original pre-removal byte hashes exist, so original byte identity is unproven. Profiles were not modified. No further cache cleanup occurred.

Real external capability acceptance, final primary code handoff, broad Task 22 acceptance, and the seven-day observation are not established by this checkpoint. Recovery must preserve current local writes; never restore an old database or revive source writers after activation.
