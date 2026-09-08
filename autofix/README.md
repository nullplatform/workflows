# Autofix

Turns the security and quality findings a CI pipeline attaches to a
**successful build** into governance action items — one per raw finding, keyed
so the same finding across many builds is one item — and, for every finding CI
marks auto-fixable, opens a **pull request** with the fix, written by a Claude
Code agent in an E2B sandbox. Items close themselves when a later successful
build on the same branch no longer reports the finding — which is exactly what
a merged fix PR produces.

Two workflows, no approval loop by design (the PR *is* the review gate):

| File | What it is |
|---|---|
| `wf-a1-on-build.yaml` | **The listener and the closer.** Webhook fed by an NP audit notification channel (`entity=build`). Re-reads the build, keeps only `status=successful` on watched branches, waits once if the findings have not landed yet, then diffs `quality_metrics.findings[]` against the live autofix items of that repo@branch: creates new items, refreshes known ones, closes vanished ones, and dispatches the fixer once per **fix group**. |
| `wf-a2-fix.yaml` | **The fixer.** One execution per fix group. Stamps the items `in_progress`, runs the agent (clone → verify the finding still applies → minimal fix → cheap verification → push a deterministic branch → open the PR), then stamps every item with the outcome (`pr_opened` + PR link, `already_fixed`, or `failed` + reason) and comments. |
| `setup/*` | Bring-up runbook (below): the `quality_metrics` metadata specification, category, config entries, upload, build channel. |
| `ci/*` | **What CI has to produce.** `quality-metrics.mjs` normalizes Trivy reports into the contract (stable ids, go.mod line numbers, per-package highest fixed version, spec-clipped fields); `github-actions.example.yml` shows where the steps go. Live in `kwik-e-mart/autofixer-application-fixer-test`. |
| `__tests__/autofix.e2e.test.ts` | Every branch of both graphs, on the real engine with stubbed I/O. |

## The contract: what CI writes on the build

The suite reads **normalized findings**, not tool reports. Adding a scanner is a
CI-side change; the workflow never learns tool formats. The contract is a build
**metadata specification** (`setup/00-metadata-spec.json`, created by
`setup/00-metadata-spec.sh`): the platform validates every CI write against it,
so a malformed payload is rejected at `np metadata create` time rather than
misread later. CI writes it with `np metadata create --entity build --data
'{"quality_metrics": …}'` (the build is found from the CI environment, like
`np build update`), **before** the final `np build update --status` — writing
metadata does not fire the build channel (verified live), the status PATCH does. Either embedded on the
build entity (`build.metadata.quality_metrics`) or as a metadata instance
(`GET /metadata/build/{id}` → `quality_metrics`):

```jsonc
{
  "source": { "repository": "org/repo", "repository_url": "https://github.com/org/repo",
              "branch": "master", "commit_sha": "3f9a…", "dockerfile": "Dockerfile", "manifests": ["package-lock.json"] },
  "gates": [ { "name": "container_scan", "tool": "aqua", "result": "failed", "report_url": "…" } ],
  "findings_summary": { "total": 9, "returned": 9, "truncated": false, "auto_fixable": 5 },
  "findings": [
    {
      "id": "aqua:GHSA-xxxx-yyyy-zzzz:axios@1.7.4",          // STABLE per finding — the idempotency key
      "tool": "aqua", "category": "vulnerability", "severity": "high",
      "title": "GHSA-xxxx-yyyy-zzzz: SSRF via absolute URL in axios request path",
      "rule": { "id": "GHSA-xxxx-yyyy-zzzz", "cwe": "CWE-918", "url": "…" },
      "package": { "name": "axios", "ecosystem": "npm", "version": "1.7.4", "fixed_version": "1.8.2", "direct": true },
      "location": { "type": "manifest", "path": "package.json", "line": 23, "snippet": "\"axios\": \"^1.7.4\"" },
      "fix": { "available": true, "auto_fixable": true, "type": "upgrade_package",
               "recommendation": "Upgrade axios to 1.8.2 or later", "command": "npm install axios@^1.8.2" },
      "risk": { "cvss_score": 7.1, "epss_score": 0.07, "exploit_available": false },
      "url": "…"
    }
  ]
}
```

What the workflows rely on:

- `findings[].id` is **stable across builds** for the same finding. It is the
  idempotency key (with repo and branch). A new CVE on the *upgraded* version is
  a genuinely new finding and correctly gets a new item.
- `fix.available && fix.auto_fixable` decides whether the fixer runs. CI made
  that call; the workflow has no category rules of its own. `fix.type` selects
  the agent playbook (`upgrade_package`, `code_change`, …); anything not
  auto-fixable still becomes an item marked `manual`. With `AUTOFIX_FIX_ALL=true`
  the verdict is overridden: every finding is dispatched, and a finding CI left
  without a playbook gets `upgrade_package` when it names a `fixed_version`,
  else `code_change` (the agent has playbooks for `test_failure`, `license`
  and generic findings too).
- `findings_summary.truncated` (or `returned < total`) and any gate whose
  `result` is not `passed`/`failed` **block closing** — absence is not proven.
- The build's `branch` (the NP entity, falling back to `source.branch`) is
  matched against `AUTOFIX_BRANCHES`; the application's `repository_url` (falling
  back to `source.repository_url`) names the repository.

## The item model

One action item per raw finding, under the **application's NRN**, category
`AUTOFIX_CATEGORY_SLUG`, priority = severity, `created_by: agent:autofix`.

```
labels:   workflow_type=autofix  finding_category=<category>  tool=<tool>  severity=<sev>  auto_fixable=true|false
metadata: finding_key      "<owner/repo>@<branch>|<finding.id>"   ← idempotency key (string)
          finding_scope    "<owner/repo>@<branch>"                ← the ONE lookup filter per build
          finding_id, tool, category, severity, rule_id, rule_url, cwe,
          package_name, package_ecosystem, package_version, fixed_version,
          location_path, location_line, repository, repository_url, branch, application_id, report_url,
          first_build_id, first_seen_at, last_build_id, last_commit_sha, last_seen_at,
          seen_builds, seen_build_ids[≤20],
          auto_fixable, fix_type, fix_group, fix_status, fix_attempts, fix_started_at, fix_finished_at,
          fix_execution_id, fix_branch, fix_summary, fix_error, pr_url, pr_number
```

`fix_status` is the fixer's state machine, and the listener's re-dispatch policy
reads it on every build:

| `fix_status` | Meaning | Next successful build that still reports the finding |
|---|---|---|
| `manual` | not auto-fixable | refreshed, never dispatched |
| `pending` | fixable, not attempted yet | dispatched |
| `in_progress` | a fixer run owns it (`fix_started_at`) | skipped while younger than `stale_fix_hours` (2h); retried after |
| `pr_opened` | PR open (`pr_url`) | skipped — the PR merge makes the finding vanish, which closes the item |
| `already_fixed` | agent found HEAD already fixed | retried below `max_fix_attempts` (3) |
| `failed` | fix did not complete (`fix_error`) | retried below `max_fix_attempts` (3), then left alone |

Items are **never reopened** (platform rule). A finding that comes back after
its item closed gets a fresh item on the next build.

## Fix groups: items are per finding, PRs are per change

Auto-fixable findings are grouped by the change that fixes them:

- `upgrade_package` → `upgrade:<ecosystem>:<package>:<fixed_version>` — three
  advisories on the same `axios` with the same fixed version are three items and
  **one** PR. The PR links back to every item.
- anything else → `<fix.type>:<finding.id>` — one PR per finding.

Groups go out worst-severity-first, capped at `max_fix_groups_per_build` (10);
the remainder stays `pending` and is picked up by the next build. The work
branch is `autofix/<slug>-<hash(group_key)>`, a pure function of the group, so a
duplicate dispatch finds the PR already open (`already_open`) instead of
opening a second one.

## Lifecycle of one finding

```
build #1 successful ──► item created (pending) ──► fixer: PR #42 opened ──► item pr_opened, comment with link
build #2 (PR not merged yet) ──► item refreshed (seen_builds=2), fixer skipped (pr_opened)
PR #42 merged; build #3 successful, finding gone ──► item CLOSED, comment "no longer reported by build #3 … Fix PR: …"
```

## Config entries (folder `/autofix`)

| Name | Kind | Used by | Value |
|---|---|---|---|
| `NP_API_KEY` | secret | both | org credential (written once at `/` by `01-config-entries.sh`, never overwritten) |
| `NP_ORGANIZATION_ID` | var | wf-a1 | numeric org id — search scope for the item lookup |
| `AUTOFIX_BRANCHES` | var | wf-a1 | comma-separated, `*` wildcards allowed: `main,master,release/*`. Empty → `main,master` |
| `AUTOFIX_CATEGORY_SLUG` | var | wf-a1 | action item category slug (`02-category.sh` prints it) |
| `AUTOFIX_FIX_ALL` | var | wf-a1 | `true` → **every** finding is dispatched to the fixer, ignoring CI's `fix.auto_fixable` (rollout/testing switch). Anything else → CI decides. Items record both verdicts (`metadata.auto_fixable`, `metadata.ci_auto_fixable`) |
| `GITHUB_TOKEN` | secret | wf-a2 | `contents:write` + `pull_requests:write` on every repository in scope |

Runtime constants live in `variables:` of wf-a1 (`metadata_grace_seconds` 120,
`max_metadata_waits` 1, `max_fix_groups_per_build` 10, `max_fix_attempts` 3,
`stale_fix_hours` 2, `max_items_per_build` 200) — an input `default:` is not
applied at runtime, `initialValue` is.

## Setup

```bash
# 0. local check — same engine + validator the platform runs
npx vitest autofix && npx np-workflow validate autofix/*.yaml

# 0b. the build metadata specification CI writes and the listener reads
NP_API_KEY=… autofix/setup/00-metadata-spec.sh

# 1. category (prints the slug to use)
NP_API_KEY=… autofix/setup/02-category.sh --name Security --slug security

# 2. config entries (GitHub token required; --check-repo verifies push permission)
NP_API_KEY=… autofix/setup/01-config-entries.sh --github-token ghp_… \
    --branches "main,master" --category-slug security --check-repo org/repo

# 3. upload wf-a2 then wf-a1 (child reference patched to the wf_ id), point + activate `live`
NP_API_KEY=… node autofix/setup/03-upload-workflows.mjs --alias live

# 4. GO-LIVE SWITCH: NP audit channel (entity=build, method=PATCH) → wf-a1's webhook.
#    Stage it: --nrn to one application first; widen to the org when the first PR looks right.
NP_API_KEY=… node autofix/setup/04-build-channel.mjs --nrn organization=X:account=Y:namespace=Z:application=W
```

Order matters: the channel is created against the webhook URL the engine
mints at activation (token-bearing, one org). Re-activating an alias mints a
new token — re-run step 4, it converges. Engine facts met on the way (2026-09-08):
an alias is CREATED with `POST …/aliases {name, revision}` (PUT only repoints
an existing one, 404 otherwise); a live trigger row reports `status: "live"`;
a category named "Security" got the slug `security-1` because the name was
taken — always read the slug back.

**CI side.** Copy `ci/quality-metrics.mjs` into the repository and add the steps
from `ci/github-actions.example.yml` between the asset push and the final status
update. Trivy stands in for Aqua/Checkmarx; any scanner works as long as the
normalizer emits the contract. The image scan is OS packages only (`--pkg-types
os`): the repository scan already covers language packages with manifest line
numbers, and a Go binary's stdlib CVEs would add ~140 findings that all share
one fix.

**Verify before widening.** Trigger a real build on a watched branch, or replay
one: `POST <webhookUrl>` with
`{"source":"audit","notification":{"entity":"build","entity_id":"<build id>","method":"PATCH"}}`.
The execution's outputs say what happened (`status: processed|skipped`, the
skip `reason`, `created/updated/closed`, `fix_groups_dispatched`); the items
appear under the application; each fixer execution ends with `pr_url` or a
per-item `fix_error`.

## Design notes and known assumptions

- **The payload is a poke, not a source of truth.** The webhook body yields a
  build id; status, branch, findings, application and repository are re-read
  with the org credential. A forged POST costs one lookup.
- **Every build PATCH fires the channel** — status flips and metadata writes
  alike. The listener needs both `status=successful` and a findings array; if
  CI flips the status before it writes the findings, the run parks once
  (`metadata_grace_seconds`) and re-reads, and the later write re-fires the
  channel anyway. The find-then-create diff makes concurrent deliveries
  converge. If your CI writes `quality_metrics` through the metadata API
  (`/metadata/build/{id}/quality_metrics`) rather than a build PATCH, confirm
  which audit `entity` that emits and add it to the channel filter
  (`04-build-channel.mjs`) — otherwise the grace wait is the only defense.
- **Metadata PATCH replaces, it does not merge.** Every write carries the full
  merged metadata: wf-a1 merges onto the item it just looked up; wf-a2
  fetches each item first and never patches an item it could not fetch.
- **Writes that are not idempotent are not retried** (item POST, close,
  comment); idempotent GET/PATCH passes are. A failed iteration is an absorbed
  `{}` slot at the same index — every pass is zipped index-aligned and counted.
- **The sandbox blocks subprocesses by default.** The live `claude-code-agent`
  descriptor exposes `sandbox.blockSubprocess` (default `true`); wf-a2 sets it
  to `false` so git, npm, `gh` and the toolchains run. Egress is
  `allowedHosts` (GitHub + the public registries). Which binaries the default
  E2B template ships is a deployment fact — the prompt falls back to the GitHub
  REST API when `gh` is missing; run one fixer on a throwaway finding before
  widening the channel to an organization. The token reaches the agent only as
  `env`, never as prompt text; the agent is told never to print it, never to
  force-push, never to touch the base branch, and never to invent a PR URL
  (wf-a2 downgrades a URL-less `pr_opened` to `failed`).
- **Agent budget**: `claude-opus-4-8`, `maxIterations` 120, step timeout 60 min
  (`metadata.executionTimeoutMs`), verification capped at ~15 min by prompt.
  Ten groups per build is the spend cap; lower `max_fix_groups_per_build` for
  a first rollout.
- **Scale**: one execution per build; the findings array travels through
  execution state (the sandbox boundary is 1 MB — hundreds of findings with
  snippets are fine, tens of thousands are not). The item lookup is one page
  (`find_limit` 200) — at the cap, closing is blocked (`item_lookup_truncated`)
  rather than done on a partial view.

## Development loop

```bash
npx vitest autofix                          # 21 E2E tests, real engine, stubbed I/O
npx np-workflow validate autofix/*.yaml     # production-parity graph validation
node autofix/setup/03-upload-workflows.mjs --dry-run
```
