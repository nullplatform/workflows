# Analysis first, not copy-paste

Every default in this suite came from measuring **one** organization. None of
them are portable by assumption:

- "asset name == directory name" resolved 99.4% of the reference org's assets. That is a
  property of how one organization's repositories are laid out, not a law.
- "go only" is right where 279 of 375 deployed repos are Go. Somewhere else the
  same choice would cover a quarter of the fleet.
- An internal-library pattern derived from one org is meaningless in another.
- Even the shape of the backfill — 376 apps, 1,772 builds, 6,733 assets — set
  the batching and threshold defaults.

So before rolling this out to a new organization, **run the analysis and read
it**. It is read-only: the lake and the GitHub API, no NP writes, no clones, no
builds.

```bash
NP_API_KEY=… GITHUB_TOKEN=… node lib-inventory/analysis/analyze-org.mjs \
  [--sample 40] [--json report.json]
```

## What each section decides

| Section | Decides |
|---|---|
| 0. GitHub token | Whether anything below is even possible. A fine-grained PAT that lists zero repositories fails every scan with `repo_unreachable` and looks exactly like an NP permissions bug — this catches it in one line instead of 6,000 |
| 1. Backfill universe | `LIB_MAX_BUILDS` and the batching plan. Also how many assets can only ever be `repo_missing` because their application has no `repository_url` in NP |
| 2. Language census | Which parsers matter here, and therefore how much of the fleet a Go-only scanner actually covers. Also flags truncated repo trees, which need a different strategy |
| 3. The ladder | **The go/no-go.** L5 > 0 means this org's repository layout is not what the rules assume |
| 4. Internal patterns | `LIB_INTERNAL_PATTERNS`. Derived from the GitHub owners of the org's own application repositories, not from dependency frequency |
| 5. Expected outcome | `LIB_MIN_COVERAGE_PCT`, and what a healthy run should look like so a bad one is recognisable |

## Reading section 3 — the one that can stop you

The ladder is the load-bearing assumption. If it reports L5 > 0, the script
prints the unresolved assets; go look at those repositories before changing
anything. The usual causes, and what each implies:

- **A build system that renames artifacts.** The asset is `payments-svc` and the
  directory is `services/payments`. If the mapping is a consistent rule, add a
  suffix/prefix to `NAME_SUFFIXES` in `scanner/scanner.mjs` so L3 catches it.
- **The name lives inside the manifest**, as with Maven's `<artifactId>`. That
  is L2 and already handled — note the analysis script deliberately does *not*
  fetch manifest contents, so its L1/L3/L4-only figure is a **lower bound**. A
  real scan can only do better.
- **No relationship at all** between asset names and layout. That is the case
  the AI fallback was designed for and it has never been needed. Talk about it
  before building it; a naming convention is cheaper than a model.

A high `no_manifest` count is not a failure. It usually means third-party images
(postgres, grafana, kuma) that genuinely have no dependencies to extract, and
they are recorded as such.

## Reading section 4 — do not accept it blindly

The script proposes patterns from the GitHub owners of the organization's own
application repositories, which is the only signal in NP that reliably means
"ours". It cannot see:

- private module hosts that are not GitHub (self-hosted GitLab, Artifactory),
- Maven `groupId`s like `com.acme.*`,
- npm scopes like `@acme/`.

Add those by hand. Getting this wrong is not fatal — nothing breaks — but the
inventory becomes a list of everyone else's libraries instead of yours, and
`internal_count` stops meaning anything.

## Reference baseline, for comparison

Measured 2026-07-26 on the reference organization. If a new org's numbers look wildly
different, that is information, not a bug.

| | reference org |
|---|---|
| apps / builds / assets (live) | 375 / 1,772 / 6,733 |
| ecosystems by repo | go 279, python 93, java-maven 24, node 24, dotnet 1, php 1 |
| repos with no manifest | 8 |
| ladder | L1 476, L2 2, L3 0, L4 1, **L5 0** (of 479) |
| internal patterns | `["^github\\.com/YOUR-ORG/"]` |
| expected statuses (go-only) | ~82% `ok`, ~18% `lang_unsupported` |
| dependency split | 87.4% transitive-external (dropped), 6.0% direct-external, 4.0% direct-internal, 2.6% transitive-internal |

## Then, and only then

```bash
cd lib-inventory/setup
./01-metadata-spec.sh   --env-file <env>
./02-config-entries.sh  --env-file <env> --scope-nrn <narrow NRN> --internal-patterns '<from section 4>'
```

Start `LIB_SCAN_NRN_PREFIX` at a single application, run with `dry_run: true`,
read the summary, and only then widen to a namespace and to the org. The
workflow makes that cheap on purpose.
