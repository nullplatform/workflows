# Weekly AI Security Assessment

Runs a weekly (Mon 03:00, also manual) AI security assessment of every
active deployment in an organization — deployed code *and* scope
configuration — and idempotently ensures a Governance action item per
finding. The scanner enumerates the active deployment per scope from the
lake, fans out one AI assessment per deployment (a sandboxed agent clones
the deployed commit and returns schema-forced findings), and for each
finding ensures exactly one action item, keyed so re-runs and redeploys
never duplicate work.

## Workflows

Three workflows, deployed as a fan-out chain — the scanner calls the
assessor once per deployment, the assessor calls the ensurer once per
finding:

| # | File | Client key | Role |
|---|---|---|---|
| 1 | `wf1-security-scanner.yaml` | `security_scanner` | Enumerates active deployments (all providers) and fans out one assessment sub-execution per deployment; summarizes results. |
| 2 | `wf2-assess-deployment.yaml` | `security_assess_deployment` | Resolves the deployed repo+commit, runs the sandboxed AI review (code, dependencies, scope config), normalizes findings into a deterministic `finding_key`, and fans out one ensure sub-execution per finding. Never propagates failure to the scanner — failures land on dedicated resolve nodes so the run still completes with a countable status. |
| 3 | `wf3-ensure-security-action-item.yaml` | `security_ensure_action_item` | Idempotent create/update of the action item for one finding, keyed by `metadata.finding_key = "sec:<scope_id>:<slug(rule_id:file)>"`. No live item → create; same commit → no-op; other commit (finding survived a redeploy) → patch metadata. |

## Config entries

Set on folder `/action-items/security-assessment` (see the header comment
in `wf1-security-scanner.yaml` for the authoritative list):

| Name | Kind | Description |
|---|---|---|
| `NP_API_KEY` | secret | NP API key |
| `GITHUB_TOKEN` | secret | Token able to read the deployed repos |
| `NP_ORGANIZATION_ID` | var | Organization id |
| `SEC_CATEGORY_SLUG` | var | Action item category slug |
| `SEC_MIN_SEVERITY` | var | Minimum severity to materialize (default `medium`) |
| `SEC_DUE_DAYS` | var | Due-date offset in days (default `14`) |
| `SEC_AGENT_MODEL` | var | Optional agent model override |

`01-config-entries.sh` seeds the first six (required for the pilot);
`SEC_AGENT_MODEL` is optional and not written by the script — set it
manually via `POST /workflows/config` if you need a non-default model.

## Setup

```bash
# 1. Seed config entries (idempotent upsert by name+path)
source .env.null
export NP_ORGANIZATION_ID=<org id> SEC_CATEGORY_SLUG=<existing category slug>
workflows/security-assessment/setup/01-config-entries.sh

# 2. Upload the three definitions (children first; NOT activated)
source .env.null
pnpm tsx workflows/security-assessment/setup/02-upload-workflows.mjs --dry-run   # inspect
pnpm tsx workflows/security-assessment/setup/02-upload-workflows.mjs
```

Record the three `wf_…` ids the uploader prints, then create + activate a
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

Then repeat the same execution (same inputs) to check idempotency:
`created: 0` on the second run and the same `finding_key`s report
`unchanged` (or `updated` only if a deploy happened in between).
Duplicated items on a re-run means STOP and fix wf3's find/lookup before
anything else.

Do not widen beyond the pilot apps, and do not leave the cron alias active
after the pilot, without an explicit OK.

## v1 limitation

There is no auto-close: if a finding is fixed (the vulnerable code/config
is no longer present), the corresponding action item is never
automatically resolved or closed by this suite. Closing stale findings is
a manual/out-of-band step for v1.
