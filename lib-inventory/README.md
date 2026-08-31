# Library Inventory

Records which libraries every deployed asset actually uses, as one
`dependency-inventory` **catalog entity** per NP asset, by reading the
application's repository at the exact commit its build was made from.
(Earlier revisions of this suite wrote asset *metadata* instead; the catalog
is now the only write target — upsert semantics, first-class in the catalog
UI/search, and queryable in the lake via `catalog_entities`.)

The point is to answer, per scope / application / asset: *who is on which
version of which internal library, and who is behind*. Detection of "obsolete"
and the action items that follow are deliberately **not** in this first
increment — the inventory has to exist and be trustworthy first.

Design doc:
[`docs/design.md`](./docs/design.md).
Querying it once it is populated: [`docs/queries.md`](./docs/queries.md).
What an organization has to have in place — and what to ask them for to get
deeper coverage: [`docs/prerequisites.md`](./docs/prerequisites.md).

Rollout: **the reference organization** (org `<ORG_ID>`), whole organization; **kwik-e-mart** and
**null** for testing.

### Why a build is its own execution

The pipeline used to run every build of a batch in one execution. It does not
scale: repository trees and manifest bodies travel through execution state and
the **sandbox input boundary is 1 MB**, which at ~103 KB per build capped a run
at about six builds (`input exceeds sandbox boundary limit of 1048576 bytes`,
and `GrpcMessageTooLarge` from Temporal before that). Handing each build to a
sub-execution makes the limit per build instead of per run, and the same
`wf-l0` then serves the backfill and the per-release path without either of
them owning a copy of the scanner.

## Before rolling this out to a new organization

**Run the analysis first.** Every default here was measured on one org and none
of them are portable by assumption — the ladder, the ecosystems, the internal
patterns and the thresholds all came from the reference organization.

```bash
NP_API_KEY=… GITHUB_TOKEN=… node workflows/lib-inventory/analysis/analyze-org.mjs
```

It is read-only and tells you what to set, what to expect, and whether the
asset→repository mapping holds there at all. See
[`analysis/README.md`](./analysis/README.md), which carries the the reference organization baseline to
compare against.

## Pieces

| File | What it is |
|---|---|
| `wf-l0-scan-build.yaml` | **The scanner.** One build per execution: plan → fetch trees (`http-request`) → plan → fetch manifests (`http-request`) → resolve → parse → build documents → upsert catalog entities. Every caller goes through this; nothing else knows about GitHub. |
| `wf-l1-backfill.yaml` | Four steps: ONE lake query for the in-scope assets (active + recently deployed) that still have no entity → a `wf-l0` sub-execution per build → coverage summary that FAILS the run below a threshold. `dry_run: true` scans and summarises without writing. |
| `scanner/lib/*.mjs` | The scanning logic, one module per concern, unit-tested. **Source of truth** for the generated step bodies. |
| `scanner/steps/*.mjs` | The five `code-exec` bodies, each a few lines wiring `inputs` to `lib/`. Not modules — function bodies, which is why Biome ignores them. |
| `scripts/build-workflow.mjs` | Inlines, per step, only the `lib/` modules that step uses (`code-exec` has no include mechanism) and refuses to emit a body that does not compile. `--check` fails if the YAML is stale. |
| `analysis/analyze-org.mjs` | **Run this first on a new org.** Read-only pre-rollout analysis: backfill size, language census, ladder health, proposed internal patterns, expected outcome. |
| `setup/*` | Configuration runbook (below). |
| `__tests__/scanner.test.ts` | Ladder rungs, parser rules and every non-`ok` status. |

## The entity document

One `dependency-inventory` catalog entity per asset (`setup/01-entity-spec.sh`
declares the spec). The document's `id` IS the asset id — the upsert key —
and wf-l0 writes it with
`PATCH /catalog/instances/dependency-inventory/{asset_id}?upsert=true`, so
create and refresh are the same request. In the lake it lands in
`catalog_entities` (join `catalog_entity_specifications` on
`slug = 'dependency-inventory'`; the document is in `data`).

```json
{
  "id": "1375758981",
  "nrn": "organization=…:account=…:namespace=…:application=…:build=…:asset=1375758981",
  "status": "ok | no_manifest | unresolved | repo_unreachable | repo_missing | lang_unsupported",
  "status_detail": "why, when it is not ok",
  "build_id": "1517184658", "release_id": "…| null", "commit": "05e71c05…",
  "repository_path": "lambdas/go/get-toggles-aws-lambda", "match_level": "L1",
  "primary_language": "go", "languages": ["go"],
  "manifests": [{ "path": "…/go.mod", "language": "go" }],
  "libraries": [
    { "name": "github.com/acme/goala/ulog", "version": "v1.1.3",
      "direct": true, "internal": true, "local": false, "ecosystem": "go" }
  ],
  "total_count": 4, "direct_count": 2, "internal_count": 4, "local_count": 1,
  "transitive_external_dropped": 59,
  "manifest_config": { "go.go": "1.22.3" },
  "scanned_at": "…", "scanner_version": "lib-inventory/1.0.0"
}
```

Deliberately NOT here: anything the platform already knows about the asset's
application or namespace (`application_name`, `repository_url`, …). The `nrn`
encodes the hierarchy for prefix filtering and the lake joins the rest.
`release_id` is provenance of the scan that wrote the document (the listener
passes it, the backfill leaves it null) — a build can be released more than
once, so the lake's release→build join remains the complete answer. The spec
declares `additionalProperties: false`: a parser that emits a new field
without declaring it in `01-entity-spec.sh` gets the WHOLE document rejected.

**Every in-scope asset gets an entity, including the ones that could not be
scanned.** An asset with no entity was never visited. That distinction is the
whole design: coverage is a lake query, not an assumption.

## What is stored, and what is not

This is an **inventory, not an SBOM**. Transitive *external* dependencies are
87% of the volume and nobody configured them — they are whatever the module
graph resolved. Dropping them takes a payload from ~12 KB to ~2 KB per asset
(78 MB → 13 MB across the reference organization's 6,733 live assets). They are still counted, in
`transitive_external_dropped`, so the omission is visible rather than silent.

Transitive **internal** dependencies are kept regardless of depth:
`goala/uenv` reaches 292 assets indirectly and `goala/utel` v1 reaches 58, and
those are exactly the migrations this exists to surface. The `direct` flag
survives on every row, because only a direct dependency is a bump the owning
team can make on its own.

Set `keepTransitiveExternal: true` in the scan step's inputs to store the full
SBOM instead.

`local: true` marks a module a `replace` redirects to a filesystem path — code
the asset ships, not a library it consumes. Excluded from the counts.

## How an asset is matched to code

A ladder. L1–L4 were measured over 479 real assets of the reference
organization; A1–A3 and ROOT exist because other organizations name assets
after the BRANCH (`main`, `develop`), which broke both assumptions the
original ladder made (measured live 2026-08-31: 30/30 assets of a maven pilot
L1-matched `src/main`):

| Rung | Rule |
|---|---|
| L1 | asset name == a directory basename anywhere in the tree |
| L2 | the name declared *inside* a manifest (Maven `<artifactId>`, `package.json` `name`, `go.mod` `module`) |
| L3 | normalized basename (strips `-aws-lambda`, `-aws-uks`, `-service`, …) |
| A1–A3 | the same three rungs over the APPLICATION name — monorepos whose assets are branch-named |
| L4 | the repo has exactly one manifest, at the root |
| ROOT | a manifest lives at the repository root — the multi-module maven case L4 can never satisfy |
| L5 | unresolved → `status: unresolved` |

A hit only settles if its subtree contains a manifest; otherwise the later
rungs keep trying. The one exception: when nothing else fires, a manifestless
asset-name hit survives as the last resort so a Dockerfile-only directory
still reads `no_manifest` at its real path instead of `unresolved`.

Two rules carry it from 98.5% to 100%:

- **Ambiguity tie-break** — when several directories share a basename, the one
  containing a manifest wins, then the shallowest. Without it the `migrations`
  asset of `acme-exchange` binds to
  `migrations/src/main/resources/db/migrations`.
- **The whole subtree** — all manifests below the matched directory, not just
  the top one. `acme-scoreboard` has one container asset holding
  `frontend/`, `scanner/` and `social_scrapers/`: three manifests, two
  languages, one asset. Hence `languages` is an array.

**No AI is involved.** It was not needed once in 479 assets. L5 is where it
would go, and the dashboard would show exactly how many assets needed it.

## Ecosystems

**go, node, maven and python** are parsed today. A manifest in any other
language is recorded with `status: lang_unsupported` and its `languages`, so
the cost of enabling each parser is a query away.

Go is also the only ecosystem that gives the direct/transitive split for free:
`go.mod` carries the `// indirect` marker written by `go mod tidy`, so it is
read, never inferred. `package.json` and `pom.xml` declare only direct
dependencies — for those, transitive resolution means reading the lockfile
(node) or the POM hierarchy (maven). Nothing here ever runs a build.

Caveat worth knowing: `// indirect` is only as accurate as the last
`go mod tidy`.

## Config entries

| Path | Name | Secret | Purpose |
|---|---|---|---|
| `/lib-inventory` | `LIB_SCAN_NRN_PREFIX` | no | Detection scope: prefix-matched against the application NRN. `organization=<org>` = whole org; a deeper NRN stages the rollout |
| `/lib-inventory` | `LIB_INTERNAL_PATTERNS` | no | JSON array of regex sources marking a dependency internal, e.g. `["^github\\.com/acme/"]`. **Required** — without it everything looks external |
| `/lib-inventory` | `LIB_MAX_BUILDS` | no | Builds per run — the fan-out width. Not a state guard any more: each build is its own sub-execution |
| `/lib-inventory` | `LIB_MIN_COVERAGE_PCT` | no | The run FAILS below this % of assets written |
| `/lib-inventory` | `LIB_BACKFILL_LOOKBACK_DAYS` | no | Besides what is ACTIVE, the backfill also scans anything deployed within this many days (default 15) |
| `/lib-inventory` | `GITHUB_TOKEN` | **yes** | Read access to the repositories in scope |
| `/` | `NP_API_KEY` | **yes** | Shared org credential — written once, never overwritten |

Config entries are referenced as `${{ vars.X }}` **directly in step configs**.
Routing them through a workflow `variable` used to seed the raw `${{ … }}`
string (it reached the lake as a ClickHouse `SYNTAX_ERROR` on the reference organization,
2026-07-26); `initialValue` now resolves `vars.*`, but this suite keeps the
direct form so it also runs against an engine that predates that fix. Secrets
are a different matter and must never go through a variable — variables are
persisted to the execution state and served by `GET /executions/:id/state`, so
the runner rejects a `secrets.*` reference in an `initialValue` outright.

## Setup

```bash
cd workflows/lib-inventory/setup
NP_SESSION_TOKEN=… ./01-entity-spec.sh --env-file ../../../.env.<org> \
  --admin-user <your np user id>
./02-config-entries.sh --env-file ../../../.env.<org> \
  --github-token ghp_… \
  --scope-nrn 'organization=<ORG_ID>:account=646905903:namespace=1424491255:application=1412378069' \
  --internal-patterns '["^github\\.com/acme/"]'
cd ../../.. && NP_API_KEY=… pnpm tsx workflows/lib-inventory/setup/03-upload-workflows.mjs
```

Both scripts are idempotent. `01` needs a USER SESSION bearer (catalog
specifications cannot be managed with an org API key; instances can, which is
all the workflows need). `02` verifies up front that the GitHub token can
actually list repositories — a fine-grained PAT that sees none fails every scan
with `repo_unreachable` and looks exactly like an NP permissions bug.

Then create and activate the alias (activation stays a deliberate step):

```bash
curl -X POST .../workflows/definitions/<id>/aliases      -d '{"name":"prod","revision":N}'
curl -X POST .../workflows/definitions/<id>/aliases/prod/activate
```

After any later change: `build-workflow.mjs` → upload (PUT, new revision) →
**repoint the SAME alias** (`PUT .../aliases/prod` with the new revision) →
re-activate. Skipping the repoint leaves workers serving the old revision.

Live state on the reference organization (2026-07-26): definition `wf_cObsaIM0_ftF`, spec
`78fae036-ddf2-4060-9f0c-23e1a515686f`, scope pinned to application
`1412378069` (feature-flagging).

## Development loop

```bash
node workflows/lib-inventory/scripts/build-workflow.mjs          # regenerate the YAML
node workflows/lib-inventory/scripts/build-workflow.mjs --check  # CI: fail if stale
npx vitest run lib-inventory/__tests__/scanner.test.ts           # from workflows/
pnpm lint:workflows
```

Always run the generator before uploading — the YAML holds a copy of the
scanner, and uploading a stale one ships stale scanner code.

## Known gaps

- **Ecosystems**: dotnet and gradle are detected but not parsed.
- **Whole-org runs are cron-shaped, not a loop**: `LIB_MAX_BUILDS` bounds one
  run and the lake query only ever returns work that is still outstanding, so
  repeated runs converge with no cursor and no `split-in-batches`.
- **Applications with no repository**: 9 sampled the reference organization apps have an empty
  `repository_url`; they are recorded as `repo_missing` and are unscannable
  until the repo is configured in NP.
