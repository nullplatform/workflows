# Weekly AI Security Assessment (v2)

Runs a weekly (Mon 03:00, also manual) AI security assessment of every
**application's** newest active deployment in an organization — deployed code
*and* scope configuration — idempotently ensures a Governance action item per
finding, and **auto-closes** the items whose finding the re-scan proves is
gone. v2 is per-application and stateful: each app carries its own
last-assessed baseline, so a normal run only re-audits what actually changed
since the previous one instead of re-scanning the whole codebase every week.

## How it works

- **Unit of assessment: the application, not the scope.** The scanner
  enumerates the *newest active deployment per application* (lake `argMax`
  over `core_entities_deployment`, across every scope/provider) — one row per
  app, carrying whichever scope currently holds that app's freshest active
  deployment. This moved from scope-level in v1 because the state below is
  application-scoped.
- **Mode: `delta` (default) or `full`.** `full` runs when explicitly requested
  (`workflow.inputs.mode: full`) or automatically on an app's first-ever run
  (no prior baseline, or no resolvable current commit to diff against — see
  wf2's `decide` step). Otherwise the agent gets `git diff
  <last_commit>..<current_commit>` and only needs to assess the changed
  surface for *new* findings, though it still verdicts every already-open
  finding against the current code either way.
- **Skip when nothing changed.** If the deployed commit is identical to
  `last_commit` and the mode isn't `full`, the app is skipped entirely —
  no agent run, no API calls beyond the state read.
- **Per-app state, in application metadata.** Each assessed app's baseline
  lives at `GET/POST/PATCH /metadata/application/{id}` under the
  `security_assessment` key:
  `{ last_commit, last_run_at, last_full_at, last_mode }`. It is written
  **only on the assessed path** — never on a skip, never on a failed
  build-context/state-read/agent step — so a failed run always re-attempts
  next time instead of silently advancing the baseline. If the write itself
  fails after a successful assessment, that's **not** treated as a failure:
  the created/closed items already landed, so the run still reports
  `status: assessed` with `reason: state_not_persisted` (and simply
  re-derives from the older baseline next time). See `API-CONTRACTS.md` §1
  for the full read/write contract, including the POST-then-PATCH split
  (first write for an app is `POST`, every later one is `PATCH` — there's no
  upsert verb).
- **Evidence-based close.** On every run the agent is handed the app's
  currently-open findings and must verdict each one — `resolved` (with how it
  verified it) or left off entirely (still present, or it couldn't check). A
  finding is only actually closed when its key both (a) was in the
  agent's `resolved[]` output **and** (b) was genuinely in the open set the
  agent was given — a hallucinated or invented key can never close anything.
  A key the agent *also* re-reports as a live finding in the same run is
  dropped from the close list too (contradiction guard — see `normalize` in
  wf2). Closing is delegated to `wf4-close-resolved-finding.yaml`, which
  finds the live item by `metadata.finding_key`, closes it
  (`ignoreInvalidTransition: true`, so re-running over an already-closed item
  is a safe no-op), and comments the resolution — close-then-comment, and
  only for transitions the close call actually confirmed (mirrors the fix in
  `workflows/ami-drift/wf2-ami-drift-closer.yaml`).
- **Idempotency key.** `finding_key = "sec:<application_id>:<slug(rule_id:file)>"`
  — application-scoped (not scope-scoped), deterministic, and never taken
  from the agent. The same issue at the same file produces the same key on
  every run, which is what makes both the ensure (wf3) and close (wf4) sides
  idempotent.

## Workflows

Four workflows. The scanner fans out one assessment per application; the
assessor fans out one ensure-item call per new/surviving finding and one
close call per finding the re-scan proved resolved:

| # | File | Client key | Role |
|---|---|---|---|
| 1 | `wf1-security-scanner.yaml` | `security_scanner` | Enumerates the newest active deployment per application (all providers, lake `argMax`) and fans out one stateful assessment per app; summarizes results (assessed/skipped/failed counts, findings created/updated/unchanged/closed). |
| 2 | `wf2-assess-deployment.yaml` | `security_assess_application` | Resolves the deployed repo+commit, reads/decides the app's mode against its persisted state, runs the sandboxed AI review (delta diff or full sweep), normalizes new findings and agent-verdicted resolutions, fans out to wf3 per finding and wf4 per resolved finding, then persists the new state. Never propagates failure to the scanner — failures land on dedicated resolve nodes so the run still completes with a countable status. |
| 3 | `wf3-ensure-security-action-item.yaml` | `security_ensure_action_item` | Idempotent create/update of the action item for one finding, keyed by `metadata.finding_key = "sec:<application_id>:<slug(rule_id:file)>"`. No live item → create; same commit → no-op; other commit (finding survived a redeploy) → patch metadata. |
| 4 | `wf4-close-resolved-finding.yaml` | `security_close_finding` | Idempotently closes the action item for one finding the assessor's re-scan verdicted resolved. Finds the live item by `finding_key`, closes it (`ignoreInvalidTransition: true`), then comments the resolution; no-ops to `not_found` when nothing matches. |

## Config entries

Set on folder `/action-items/security-assessment` (see the header comment in
`wf1-security-scanner.yaml` for the authoritative list):

| Name | Kind | Description |
|---|---|---|
| `NP_API_KEY` | secret | NP API key |
| `GITHUB_TOKEN` | secret | **READ-ONLY** token for the deployed repos — `contents: read` and nothing else (see the warning below) |
| `NP_ORGANIZATION_ID` | var | Organization id |
| `SEC_CATEGORY_SLUG` | var | Action item category slug |
| `SEC_MIN_SEVERITY` | var | Minimum severity to materialize (default `medium`) |
| `SEC_DUE_DAYS` | var | Due-date offset in days (default `14`) |
| `SEC_AGENT_MODEL` | var | Agent model — **required** (e.g. `claude-opus-5`). The YAMLs read `${{ vars.SEC_AGENT_MODEL || 'claude-opus-5' }}`, but the `\|\|` fallback never fires: the resolver throws `CONFIG_ENTRY_UNRESOLVED` on the unresolved var before evaluating it, so every referenced var is effectively required. |

`01-config-entries.sh` seeds all seven.

> **`GITHUB_TOKEN` must be read-only.** Scope it to `contents: read` on the
> repositories being assessed — a fine-grained PAT or a GitHub App
> installation token, never a classic `repo` token and never one that can
> write, open PRs, or read Actions secrets. The agent runs with
> `blockSubprocess: false` (it needs `git`) over source it did not write, and
> that source is adversarial input by definition: the whole point of the
> assessment is that the repository may contain something hostile. The
> workflow's own prompt tells the agent to treat repository content as data
> rather than instructions, but a read-only token is what makes a successful
> injection unable to do anything except lie in a report.

## Setup

```bash
# 0. Register the application metadata specification (once per org).
#    REQUIRED before wf2 can persist state — without it, every
#    read_state/write_state call 400s ("body must NOT have additional
#    properties"), the app never accumulates a baseline, and every run falls
#    back to a full sweep. See API-CONTRACTS.md §1b.
source .env.null
export NP_ORGANIZATION_ID=<org id>
workflows/security-assessment/setup/00-metadata-spec.sh

# 1. Seed config entries (idempotent upsert by name+path)
export SEC_CATEGORY_SLUG=<existing category slug>
workflows/security-assessment/setup/01-config-entries.sh

# 2. Upload the four definitions (children first; NOT activated)
pnpm tsx workflows/security-assessment/setup/02-upload-workflows.mjs --dry-run   # inspect
pnpm tsx workflows/security-assessment/setup/02-upload-workflows.mjs
```

Record the four `wf_…` ids the uploader prints, then create + activate a
`prod` alias for each via `POST /workflows/definitions/:id/aliases/prod/activate`
— activation is required for executions, and the cron trigger only arms on
the scanner's activation.

## Pilot runbook (org 4, a few apps)

```bash
# Manual pilot run — execute wf1 with the pilot filter
curl -s -X POST "$API/workflows/executions" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"workflowId":"<wf1 id>","inputs":{"applications":"grafana, Services API","max_deployments":3}}'

# Poll until terminal
curl -s "$API/workflows/executions/<execution id>" -H "Authorization: Bearer $TOKEN"
```

Verify:
- Execution status `completed`; `outputs.assessed ≥ 1`, `failures` empty or explained.
- `GET /action_item?...metadata filter finding_key prefix "sec:"` — items exist, correct category, priority matches severity, metadata all strings, description shows evidence and masked secrets only.
- Agent step logs confirm it cloned the deployed commit (not HEAD of main, unless the commit was unresolvable).
- `GET /metadata/application/<app id>` shows a `security_assessment` value
  with the app's `last_commit`/`last_run_at`/`last_full_at`/`last_mode` after
  the run.

Then repeat the same execution (same inputs) to check idempotency: the
commit hasn't changed, so the app should now be **skipped**
(`reason: no_change`) — `created: 0`, and no new agent run at all. To
exercise the close path, wait for (or manually trigger) a redeploy that fixes
a reported finding, then re-run: the app's mode falls back to `delta`, the
agent verdicts the previously-open finding `resolved`, and the corresponding
action item closes with a comment.

Duplicated items on a re-run means STOP and fix wf3's find/lookup before
anything else. An item that should have closed but didn't means check the
agent's `resolved[]` output against `pack_open`'s `open_keys` in the
execution's step logs first (see wf2's `normalize` step for the three close
guards) before assuming the plugin is broken.

Do not widen beyond the pilot apps, and do not leave the cron alias active
after the pilot, without an explicit OK.

## v1 → v2

v1 was scope-level, stateless (every run did a full codebase sweep, every
time), and had no auto-close — a fixed finding just sat open until someone
closed it by hand. v2 moves the assessment unit to the application, persists
a per-app baseline in application metadata so most runs only diff the
change since the last one, and adds evidence-based auto-close (wf4) driven
by the agent's own verdict on each already-open finding.
