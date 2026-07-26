# Library Inventory

Records which libraries every deployed asset actually uses, as `dependencies`
metadata on the NP **asset** entity, by reading the application's repository at
the exact commit its build was made from.

The point is to answer, per scope / application / asset: *who is on which
version of which internal library, and who is behind*. Detection of "obsolete"
and the action items that follow are deliberately **not** in this first
increment — the inventory has to exist and be trustworthy first.

Design doc: [`docs/design.md`](./docs/design.md) — the measurements behind every
choice here, and why the alternatives were rejected.

Carries no organization-specific ids: scope, internal-library patterns, batch
size and thresholds are all config entries. Start pinned to ONE application.

## Before rolling this out to a new organization

**Run the analysis first.** Every default here was measured on one org and none
of them are portable by assumption — the ladder, the ecosystems, the internal
patterns and the thresholds all came from a single organization.

```bash
NP_API_KEY=… GITHUB_TOKEN=… node lib-inventory/analysis/analyze-org.mjs
```

It is read-only and tells you what to set, what to expect, and whether the
asset→repository mapping holds there at all. See
[`analysis/README.md`](./analysis/README.md), which carries a reference baseline to
compare against.

## Pieces

| File | What it is |
|---|---|
| `wf-l1-backfill.yaml` | Manual run: ONE lake query finds every asset reachable from an ACTIVE deployment in scope → `code-exec` (egress locked to `api.github.com`) resolves each asset to a repository subtree and extracts its manifests → flat per-item `np-api-call` writes one metadata record per asset → coverage summary that FAILS the run below a threshold. `dry_run: true` scans and summarises without writing. |
| `scanner/scanner.mjs` | The scanning logic, as a testable module. **Source of truth** for the `scan` step's code. |
| `scanner/driver.mjs` | The `code-exec` body that wires `inputs` to the scanner and shapes the write requests. |
| `scripts/build-workflow.mjs` | Inlines the two above into the YAML (`code-exec` has no include mechanism) and refuses to emit a body that does not compile. `--check` fails if the YAML is stale. |
| `analysis/analyze-org.mjs` | **Run this first on a new org.** Read-only pre-rollout analysis: backfill size, language census, ladder health, proposed internal patterns, expected outcome. |
| `setup/*` | Configuration runbook (below). |
| `__tests__/scanner.test.ts` | Ladder rungs, parser rules and every non-`ok` status. |

## The metadata record

One `dependencies` record per asset, under an org-level specification hidden
from the UI (`visibleOn: []`). It lands in the lake as
`core_entities_metadata` with `entity='asset'`, which is what the dashboard
queries — note it does **not** appear in `core_entities_asset.metadata`.

```json
{
  "status": "ok | no_manifest | unresolved | repo_unreachable | repo_missing | lang_unsupported",
  "status_detail": "why, when it is not ok",
  "primary_language": "go", "languages": ["go"],
  "repository_url": "…", "repository_path": "lambdas/go/get-toggles-aws-lambda",
  "commit": "05e71c05…", "match_level": "L1",
  "manifests": [{ "path": "…/go.mod", "language": "go" }],
  "dependencies": [
    { "name": "github.com/your-org/logging", "version": "v1.1.3",
      "direct": true, "internal": true, "local": false, "ecosystem": "go" }
  ],
  "total_count": 4, "direct_count": 2, "internal_count": 4, "local_count": 1,
  "transitive_external_dropped": 59,
  "scanned_at": "…", "scanner_version": "lib-inventory/1.0.0"
}
```

**Every in-scope asset gets a record, including the ones that could not be
scanned.** An asset with no record was never visited. That distinction is the
whole design: coverage is a lake query, not an assumption.

## What is stored, and what is not

This is an **inventory, not an SBOM**. Transitive *external* dependencies are
87% of the volume and nobody configured them — they are whatever the module
graph resolved. Dropping them takes a payload from ~12 KB to ~2 KB per asset
(78 MB → 13 MB across the reference org's 6,733 live assets). They are still counted, in
`transitive_external_dropped`, so the omission is visible rather than silent.

Transitive **internal** dependencies are kept regardless of depth:
one internal logging/telemetry package reached 292 assets indirectly, and the
v1 line of another reached 58, and
those are exactly the migrations this exists to surface. The `direct` flag
survives on every row, because only a direct dependency is a bump the owning
team can make on its own.

Set `keepTransitiveExternal: true` in the scan step's inputs to store the full
SBOM instead.

`local: true` marks a module a `replace` redirects to a filesystem path — code
the asset ships, not a library it consumes. Excluded from the counts.

## How an asset is matched to code

A ladder, measured over 479 real assets:

| Rung | Rule | Assets |
|---|---|---|
| L1 | asset name == a directory basename anywhere in the tree | 476 (99.4%) |
| L2 | the name declared *inside* a manifest (Maven `<artifactId>`, `package.json` `name`, `go.mod` `module`) | 2 (0.4%) |
| L3 | normalized basename (strips `-aws-lambda`, `-aws-uks`, `-service`, …) | 0 |
| L4 | the repo has exactly one manifest, at the root | 1 (0.2%) |
| L5 | unresolved → `status: unresolved` | **0** |

Two rules carry it from 98.5% to 100%:

- **Ambiguity tie-break** — when several directories share a basename, the one
  containing a manifest wins, then the shallowest. Without it a `migrations` asset binds to
  `migrations/src/main/resources/db/migrations`.
- **The whole subtree** — all manifests below the matched directory, not just
  the top one. one observed repository has a single container asset holding
  `frontend/`, `scanner/` and `social_scrapers/`: three manifests, two
  languages, one asset. Hence `languages` is an array.

**No AI is involved.** It was not needed once in 479 assets. L5 is where it
would go, and the dashboard would show exactly how many assets needed it.

## Ecosystems

Only **go** is parsed today (279 of the reference org's 375 deployed repos contain it). A
manifest in any other language is recorded with `status: lang_unsupported` and
its `languages`, so the cost of enabling each parser is a query away.

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
| `/lib-inventory` | `LIB_INTERNAL_PATTERNS` | no | JSON array of regex sources marking a dependency internal, e.g. `["^github\\.com/YOUR-ORG/"]`. **Required** — without it everything looks external |
| `/lib-inventory` | `LIB_MAX_BUILDS` | no | Builds per run. Batching guard |
| `/lib-inventory` | `LIB_MIN_COVERAGE_PCT` | no | The run FAILS below this % of assets written |
| `/lib-inventory` | `GITHUB_TOKEN` | **yes** | Read access to the repositories in scope |
| `/` | `NP_API_KEY` | **yes** | Shared org credential — written once, never overwritten |

Config entries are referenced as `${{ vars.X }}` **directly in step configs**.
Routing them through a workflow `variable` used to seed the raw `${{ … }}`
string (it reached the lake as a ClickHouse `SYNTAX_ERROR`,
2026-07-26); `initialValue` now resolves `vars.*`, but this suite keeps the
direct form so it also runs against an engine that predates that fix. Secrets
are a different matter and must never go through a variable — variables are
persisted to the execution state and served by `GET /executions/:id/state`, so
the runner rejects a `secrets.*` reference in an `initialValue` outright.

## Setup

```bash
cd workflows/lib-inventory/setup
./01-metadata-spec.sh --env-file ../../../.env.<org>
./02-config-entries.sh --env-file ../../../.env.<org> \
  --github-token ghp_… \
  --scope-nrn 'organization=<org>:account=<acct>:namespace=<ns>:application=<app>' \
  --internal-patterns '["^github\\.com/YOUR-ORG/"]'
cd ../.. && npx np-workflow publish lib-inventory/wf-l1-backfill.yaml --alias prod
```

Both scripts are idempotent. `02` verifies up front that the GitHub token can
actually list repositories — a fine-grained PAT that sees none fails every scan
with `repo_unreachable` and looks exactly like an NP permissions bug.

`np-workflow publish` handles the revision + alias + activate dance. Doing it by
hand instead: a new revision is a `PUT`, and the SAME alias must then be
repointed and re-activated — skipping the repoint leaves workers serving the
old revision.

## Development loop

```bash
node lib-inventory/scripts/build-workflow.mjs          # regenerate the YAML
node lib-inventory/scripts/build-workflow.mjs --check  # CI: fail if stale
npx vitest run lib-inventory                                     # from the repo root
npx np-workflow validate lib-inventory/wf-l1-backfill.yaml
```

Always run the generator before uploading — the YAML holds a copy of the
scanner, and uploading a stale one ships stale scanner code.

## Known gaps

- **Batching**: one run processes up to `LIB_MAX_BUILDS` builds in a single
  `code-exec` step. the reference org's full backfill is 1,772 builds / 6,733 assets, which
  needs a `split-in-batches` loop over the build list. Not built yet.
- **Ecosystems**: node, maven, python and dotnet are detected but not parsed.
- **Near-real-time**: population on release creation (an `audit` notification
  channel filtered to `entity=release` → webhook trigger) is not built yet;
  today the inventory only refreshes when the backfill runs.
- **Applications with no repository**: an application with an empty
  `repository_url` in NP is recorded as `repo_missing` and is unscannable until
  that is set. The analysis script counts them up front.
