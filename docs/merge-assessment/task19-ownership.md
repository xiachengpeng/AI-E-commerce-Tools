# Research ownership handoff

<!-- project-doc-status:start -->
> **文档状态同步：2026-10-26 · 历史融合评估与交接**
> 保留各阶段的远端、旧入口、进程和测试记录；这些描述仅适用于原记录时点，不作为当前启动说明。
> 当前入口与验证范围：[项目当前状态](<../项目当前状态.md>)；[2026-10-26流程修复与边界](<../ux-audit/2026-10-26-sop-flow-repair/验收记录.md>)。
<!-- project-doc-status:end -->


Task 19 supplies the handoff mechanism; it does not freeze the source or activate this installation.

Preparation is explicit: verified backup, `prepare_schema(..., target_revision=4)`, then `prepare_ownership` for the imported snapshot. Revision 4 adds nullable dataset ID, owner generation and activation digest to the existing ledger. Older revisions remain readable; they cannot activate. Rehearsal plans optionally select revision 4; existing revision 3 rehearsal receipts remain valid.

The operator's private report must identify the final snapshot, dataset and owner generation, certify source workers **and** write entry points are frozen, include freeze/snapshot timestamps, and completely enumerate unresolved non-idempotent resources in a signed quarantine. The first claim requires every such resource to remain blocked/manual with the original attempt and payload digest; missing coverage, eligible unknowns or changed payloads reject activation. Being unreachable is not proof of stopping. `issue_activation` signs with a separate local 32-byte `activation.key`; original evidence material is never replaced or reused. Save the returned report privately as `keys/activation.json` with mode 0600. No real activation has been issued by this task.

`candidate_hash` hashes schema and typed row multisets in one SQLite transaction, including committed WAL. Before reopening the main application for normal writes, `claim_activation` uses `BEGIN IMMEDIATE` to validate that hash and consume the credential atomically. No SQLite backup runs within this transaction. After consumption, validation checks signed snapshot/dataset/generation and the durable ledger digest/state, rather than a changing database hash. The first-use deadline expires unused credentials; it does not expire an already consumed owner. Revocation requires an explicit ledger generation/state transition and stopping the old owner. Removing a signed quarantine item requires a new generation and a private verified resolution file bound to its kind, ID, attempt and payload hash, plus a hash-checked evidence file. Proofs do not rewrite queue rows; terminal durable state must also be established before the new credential can be consumed. The existing exclusive worker lock still prevents two local workers; it is not the cross-machine handoff proof.

Production local startup without a valid handoff exposes native reads using a read-only connection and rejects research commands. Production paused CLI opens read-only and does not claim work or write heartbeats. A deliberately named `offline_commands` internal seam exists only for disposable temporary tests, forbids external execution, and is not exposed through HTTP, environment, or CLI flags.

Reconciliation never submits, queues or cancels. Existing bound cloud jobs are polled by their saved run/dataset and checked against response identity. Unknown submission, sync/outbox receipts, or expired ambiguous jobs remain manual-check. Recovery preserves original budgets and uses the existing attempt/lease fences. Explicit stop validates optional project version and mandatory attempt atomically, persists the action/run/dataset abort claim, then makes at most one bounded abort request outside the SQLite transaction. The claim blocks retry while cloud termination is unconfirmed, including after a crash.

Media downloads reuse the original safe reader with public-address resolution, redirect checks, MIME and size limits. Routes select saved project/keyword/ad/product media; they do not accept arbitrary proxy URLs. External services and the main AIRouter adapter are assembled only after activation, using existing typed business and integration configuration.

The original rehearsal snapshot has 3 completed actions, no sync runs, 154 successful and 3 needs-human outbox entries, and 2 successful and 3 needs-human legacy jobs. Six unknown resource records remain blocked; they are not proven to be six independent transactions. Detailed identifiers and original budgets are in the private operator report; no source state was changed. Final source freeze, refreshed final snapshot, disposition of unknown receipts, production cutover, external capability validation and retirement remain operational gates for subsequent tasks.


On ownership revision 4, research write transactions require the verified runtime context even when a caller constructs the original legacy repository directly. Transactions verify the signed owner and that quarantined rows remain immutable before committing. Workbench re-enqueue and Feishu replay also check the specific resource before network work. A properly signed quarantine permits unrelated new actions/jobs/outbox work; it never converts the quarantined records to ready. Original source databases without an ownership marker retain their existing behavior.

The legacy executor construction remains `cli.DefaultOperatorRuntime.build_worker` → `runtime.legacy.build_worker` → `Worker`, using `JobRepository` and `FeishuWorkflowAdapter`. Task 19 does not start it or insert it alongside the native worker. Task 21 must provide the same validated ownership context and a single-owner scheduling decision before enabling this compatibility executor; direct legacy constructors against the merged ownership database fail closed without that context.
