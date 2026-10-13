# Candidate data rehearsal

Task 18 adds explicit offline import, immutable object copying and independently
anchored backup rehearsal. None of these tools replaces a live database, starts
an application, freezes writers or authorizes cutover.

`rehearse(research_snapshot, main_snapshot, destination)` requires private sibling
`<snapshot>.anchor` files holding the independently recorded creation-time
manifest digests, and a private `<research_snapshot>.plan.json`. Anchors must be
retained independently when the backup is created, not reconstructed later from
an untrusted manifest. The plan explicitly names source/main database entries,
evidence root, original evidence path, namespace and business-settings files,
and configuration mappings. Optional `auxiliary_databases` maps each additional
anchored database to its active table; currently the original `translations`
table is preserved verbatim and copied to `research_translation_cache`. Unknown
or omitted auxiliary databases fail closed.

Destinations are restricted to private disposable directories under the system
temporary root or `~/.local/share/ai-ecommerce-merge`. Import requires an owned
candidate marker and explicit revision 3 schema. The canonical Task 4 backup
report is verified before schema preparation; interruption after DDL can resume
only if an independently restored/prepared reference matches. A single SQLite
transaction copies raw values, checks foreign keys, preserves main rows and
records source identity, plan identity and candidate content. Repeat imports
reject changed input or candidate content.

Object copying checks the complete file roster, every VersionId/body hash,
original key bytes, path confinement and free space. Existing conflicting files
are refused. Handled copy interruptions remove the partially written file and
can resume. Abrupt process or machine termination that leaves a partial final
file fails closed; the candidate must then be discarded or independently
recovered. No historical signed payload is rewritten; a private read-only path
mapping resolves original evidence paths.

Source configuration and key material belong only in private backups, plans,
provenance and candidate stores. Existing main providers and bindings take
priority. A research provider may be archived disabled and unbound; target-only
schema defaults must be explicitly distinguished from source configuration.
Empty-main defaults must be supplied from the real effective main configuration.
No credentials, data, snapshots or private plan examples belong in Git.

## Verification on 2026-10-13

The fresh real rehearsal restored 14 research tables (340 rows), the auxiliary
translation cache (9 rows), and 147 object files containing 87 immutable versions.
Native reads verified every non-deleted version by its original VersionId/hash.
The earlier Task 1 phrase “147 version files” described the file roster; 147 files
and 87 actual VersionIds are distinct counts, with no omitted evidence.
All original rows in 18 main tables were preserved, including ten providers and
two bindings. One source AI connection was archived disabled and unbound; its
key/base/model came from the source, while timeout 60 seconds and maximum retries
2 came from existing target defaults. These defaults do not claim equivalence
to the old SDK's implicit behavior. Raw source configurations remain private.

Authenticated native candidate reads returned one project, rejected missing
authentication and left the database unchanged. Repeating the rehearsal returned
the same result. A current `/config` in-process ASGI comparison used 200 alternating
samples after 20 warmups, identical constants and read-only copies: main p95
0.6010 ms, candidate 0.6027 ms, +0.2842%, with equal response hashes. This satisfies
the endpoint's 20% comparison gate, not a whole-application or network SLA.

Focused tests: 23 passed. Related schema/inventory/runtime/route tests: 110 passed.
The isolated main runner passed 968 backend and 609 frontend tests. Three existing
backend warnings remain. One earlier direct full run lacked the synthetic
Firecrawl key assumed by an existing mocked test (967 passed, one failed); the
established isolated runner provides that fixture. Python was externally upgraded
from 3.12.14 to 3.12.15 during work; only the owned ignored virtual-environment
interpreter link was repaired, without dependency or primary-environment changes.

Source writers remained running throughout. SQLite backup consistency and file
roster checks do not provide an atomic cross-database/object freeze. These are
rehearsal snapshots. Final freeze, a fresh final snapshot, activation, external
capabilities, retirement and observation remain separate gates. Both
`source_freeze_attested` and `cutover_allowed` remain false.
