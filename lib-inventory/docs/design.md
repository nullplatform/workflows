# Library Inventory — design

**Date:** 2026-07-26
**Status:** increment 1 implemented and live on the reference organization (scoped to one application)
**Implementation:** [`workflows/lib-inventory/`](../../../workflows/lib-inventory/)

> **Update 2026-08-31:** the store moved from asset *metadata* to one
> `dependency-inventory` **catalog entity** per asset (upsert by asset id,
> lake table `catalog_entities`). Where this document says "metadata record",
> read "catalog entity"; the design — one record per asset, absence means
> never visited, commit-pinned scans — is unchanged. See the README's
> "The entity document" section.

## Goal

Detect internal libraries that are obsolete or need replacing, per scope, and
eventually open action items about them.

The path there runs through a fact the platform does not currently have: **which
libraries each deployed asset actually uses**. This document designs that
inventory. Obsolescence criteria, action items and the dashboard build on top of
it and are explicitly out of scope for increment 1 — an inventory nobody trusts
makes every verdict above it worthless.

## Why the asset is the carrier

A scope points at an asset *by name* (`core_entities_scope.asset_name`), so
"libraries live in this scope" is a direct join:

```
deployment(status_in_scope='active') → release → build → asset(name = scope.asset_name) → metadata
```

Storing on the build instead would break that join and, more practically, build
metadata has no column in the lake. Entity metadata lands in
`core_entities_metadata`, which is queryable — verified end to end: a write is
visible in the lake in under 2 seconds. Note it does **not** propagate to
`core_entities_asset.metadata`, which stays `{}`.

`/metadata/asset/{id}/{type}` is a supported entity type even though the public
docs list only application / build / namespace.

## Evidence base

Every number below was measured against the reference organization (org `<ORG_ID>`), not assumed.

- 558 applications; 481 `active`; **376 with an ACTIVE deployment** — the last
  is the backfill universe: **1,772 builds, 6,733 assets**.
- Language census over all 376 deployed repos: go 279, python 93, java-maven 24,
  node 24, dotnet 1, php 1, and 8 with no recognised manifest (third-party
  images). By *mono-language* repo: go 232, python 60, java-maven 15, node 6.
- Structural sample of 111 apps / 479 assets, and a deep sample of 30 apps /
  94 assets with dependencies actually extracted.

## Resolution ladder

| Rung | Rule | Assets (of 479) |
|---|---|---|
| L1 | asset name == a directory basename anywhere in the tree | 476 (99.4%) |
| L2 | the name declared inside a manifest (Maven `<artifactId>`, `package.json` `name`, `go.mod` `module`) | 2 (0.4%) |
| L3 | normalized basename (strips `-aws-lambda`, `-aws-uks`, `-service`, …) | 0 |
| L4 | the repo has exactly one manifest, at the root | 1 (0.2%) |
| L5 | unresolved | **0** |

Two rules take it from 98.5% to 100%:

1. **Ambiguity tie-break.** Several directories can share a basename; prefer the
   one containing a manifest, then the shallowest. Without it `acme-exchange`'s
   `migrations` asset binds to `migrations/src/main/resources/db/migrations`.
2. **The whole subtree.** Collect every manifest under the matched directory.
   `acme-scoreboard` has a single container asset containing
   `frontend/`, `scanner/` and `social_scrapers/` — three manifests, two
   languages, one asset. `languages` is therefore an array.

### On AI

The original expectation was that inferring "which asset is which code" would
need a model. It did not: the deterministic ladder resolved 479 of 479. AI stays
designed-in as a future L5 fallback, restricted to assets the deterministic
path has already marked `unresolved`, which keeps its usage auditable — the
dashboard would show exactly how many assets required it.

## Failure is data, not an exception

Every in-scope asset receives a metadata record, including one that could not be
scanned, with `status` carrying the reason:

`ok`, `no_manifest`, `unresolved`, `repo_unreachable`, `repo_missing`,
`lang_unsupported`.

An asset with **no record** was never visited. That is the only meaning of
"missing", so coverage is a lake query rather than an assumption. The run also
fails below `LIB_MIN_COVERAGE_PCT`, so a broken credential cannot quietly
produce a run that scans everything and writes nothing.

This was chosen over "write only successes and fail the run", because the latter
hides gaps from the dashboard — the place where someone would actually notice.

## Inventory, not SBOM

Measured over 653 assets:

| | deps | share |
|---|---|---|
| transitive external | 37,978 | 87.4% |
| direct external | 2,595 | 6.0% |
| direct internal | 1,744 | 4.0% |
| transitive internal | 1,136 | 2.6% |
| local (`replace` to a path) | 167 | 0.4% |

| policy | deps/asset | KB/asset | 6,733 assets |
|---|---|---|---|
| everything (SBOM) | 81.4 | 11.9 | 78.5 MB |
| direct only | 8.4 | 1.7 | 11.4 MB |
| **direct + transitive internal** | **10.5** | **2.0** | **13.4 MB** |

Transitive external is dropped: 87% of the volume, nobody configured it, and it
is a consequence of the direct dependencies rather than a fact about them. It is
still **counted** in `transitive_external_dropped`, so the omission is visible.

Transitive internal is kept because "direct only" would erase the signal: 292
assets reach `goala/uenv` indirectly, 58 reach `goala/utel` v1 — that v1→v2
migration is precisely what this system exists to see. The extra cost over
direct-only is 0.3 KB per asset.

`direct` is preserved on every dependency, because only a direct dependency is a
bump the owning team can perform without touching something else first.

`local: true` marks a module a `replace` redirects to a filesystem path: in-repo
code the asset ships, not a consumed library. Excluded from the counts.

## Transport: GitHub API, no clones

Per build: **2 requests.**

1. `GET /repos/:o/:r/git/trees/{commit}?recursive=1` — the full file list in one
   response. 0 of 375 repos hit the truncation limit.
2. One GraphQL query with N aliased `object(expression: "<sha>:<path>")` —
   measured at 6 `go.mod` in 0.71s, cost 1 point.

Pinning to the build's commit SHA makes the record reproducible: it describes
the code that was actually built, not today's `main`. Full the reference organization backfill is
~3,544 GitHub requests (a PAT allows 5,000/h; a GitHub App 15,000/h).

Nothing runs a build. For maven that caps us at `pom.xml` plus statically
fetched parent POMs and `<properties>` interpolation, which is accepted.

## Ecosystems

Only **go** is parsed in increment 1 — 279 of 375 deployed repos contain it.
Other manifests are recorded as `lang_unsupported` with their `languages`, so
the value of enabling each parser is measurable before writing it.

Go is also the only ecosystem that yields the direct/transitive split for free:
`go.mod` carries the `// indirect` marker written by `go mod tidy`, so it is
read rather than inferred (accurate only as of the last `tidy`). `package.json`
and `pom.xml` declare direct dependencies only; transitive resolution there
means reading the lockfile or the POM hierarchy. Consequence to accept when
those land: transitive-internal detection will be weaker outside Go.

## Workflow shape

`wf-l1-backfill.yaml`, four steps:

1. `np-lake-query` — every asset reachable from an ACTIVE deployment whose
   application NRN matches `LIB_SCAN_NRN_PREFIX`. `groupUniqArray`, not
   `groupArray`: a release with several active deployments otherwise repeats
   each asset per scope, turning 6,733 assets into 40,718. Assets are emitted as
   a JSON string so a ClickHouse tuple array never crosses the plugin boundary.
2. `code-exec` with `network.allowedHosts: [api.github.com]` — which routes the
   step to an isolated sandbox with egress denied everywhere else.
3. `np-api-call` per item — `POST /metadata/asset/{id}/dependencies`, an upsert,
   so re-running is idempotent.
4. `code-exec` summary — coverage, per-status and per-language tallies; throws
   below the threshold.

`dry_run: true` routes 2 → 4 directly and writes nothing.

The scanner lives in `scanner/*.mjs` and is **generated into** the YAML by
`scripts/build-workflow.mjs`, because `code-exec` has no include mechanism. The
generator compiles the body as an `AsyncFunction` (exactly as the sandbox does)
and refuses to emit one that does not compile; `--check` fails on a stale YAML.

## Engine findings (live, 2026-07-26)

Three landed as comments in the YAML so they are not rediscovered:

- **`variables.initialValue` did not resolve `${{ vars.X }}` config entries.**
  The raw template reached the lake query and came back as a ClickHouse
  `SYNTAX_ERROR`. Root cause: variables were seeded before the config resolver
  ran. **Fixed** — the resolver now runs first and `initialValue` resolves
  `vars.*`. `secrets.*` is deliberately rejected there instead: variables are
  persisted and served by `GET /executions/:id/state`, so a secret in one would
  leak. The suite still uses the direct `${{ vars.X }}` form in step configs so
  it runs against engines predating the fix.
- **A connection `condition` was a raw expression only** — wrapping it in
  `${{ }}` raised `ExpressionParseError`, even though every other expression an
  author writes uses that form. **Fixed** — a condition that is exactly one
  `${{ … }}` template is now unwrapped and evaluated, for connections, decider
  `step.condition` and `loop.while` alike.
- **Markers inside a YAML block scalar must be valid JavaScript comments.** A
  `#` marker reached the sandbox verbatim and failed with
  `SANDBOX_RUNTIME — Invalid or unexpected token`.

## Verified result

Live on the reference organization, application `1412378069` (feature-flagging), definition
`wf_cObsaIM0_ftF`:

```
assets_scanned: 24   assets_written: 24   coverage_pct: 100
by_status: { ok: 24 }   by_language: { go: 24 }
dependencies_stored: 183   transitive_external_dropped: 1554
```

Queryable from the lake, and already showing drift inside a single application:
`lambda-go` v1.4.0 on 5 assets against v1.6.0 on 15; `goala/utel/v2` in three
versions.

The wider dry run (60 apps / 653 assets) gives the shape of the org: 82.1% `ok`,
17.8% `lang_unsupported` (74 maven, 40 python, 2 node), 1 `no_manifest`, and
zero `unresolved` or `repo_unreachable`.

## Next increments

1. **Batching** — `split-in-batches` over the build list, so a whole-org backfill
   is one run instead of `LIB_MAX_BUILDS`-sized manual passes.
2. **Near-real-time** — an `audit` notification channel filtered to
   `entity=release, method=POST` pointed at a webhook trigger, so a release
   refreshes its own assets. the reference organization already runs `audit`-sourced channels, so no
   new plugin is needed.
3. **More ecosystems** — maven and python first by asset count. Read the lockfile
   / POM hierarchy to classify, still store only direct + internal.
4. **Verdicts** — auto-derived ("behind the fleet's leading version") and/or a
   curated catalog of internal libraries with `status` and replacement `target`,
   mirroring `lambda_runtimes` in the runtime-lifecycle suite.
5. **Dashboard** — `np-report` over `core_entities_metadata`.
6. **Deploy-time checks** — once verdicts exist.

## Open issues

- The the reference organization `GITHUB_TOKEN` in `.env.the reference organization` (`ecanizal-the reference organization`) **can see zero
  repositories** — `/user/repos` returns an empty list and the target repo 404s.
  The live run uses Gabriel's personal PAT as a stopgap; a GitHub App or machine
  token has to replace it before any real rollout.
- 9 sampled applications have an empty `repository_url` in NP and are
  unscannable until it is set.
