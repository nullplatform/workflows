# Deploy Analysis suite

Continuous, LLM-assisted analysis of what actually ships: every finalized
deployment in the configured namespaces gets a risk assessment and a
functional summary written to its catalog metadata, and a weekly roll-up
narrates each application's and namespace's week — one summary per
environment, so production and staging never mix.

## Workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `deploy-change-analysis.yaml` | manual (invoked as sub-workflow) | Analyzes ONE deployment: GitHub compare of deployed vs previous release, PRs + participants (roles from commit authors AND PR author/reviewers/approvers), AI-usage detection (commit trailers), deterministic risk signals, LLM risk + functional summary → writes `deployment.metadata.change`. Heuristic fallback if the LLM step fails. |
| `deploy-backfill.yaml` | cron hourly + manual (`days=N`) | Finds finalized deployments in the configured namespaces/environments missing `metadata.change` and fans out one analysis per deployment (sub-workflow forEach, bounded concurrency). Idempotent and convergent — re-runs only process what is missing. Initial backfills: run manually with `days: 15`. |
| `deploy-weekly-summary.yaml` | cron Mondays + manual (`week_offset=N`) | Rolls the week's analyses up per (application, environment) and (namespace, environment). Prod lands in metadata `deploy_summaries`, stage in `deploy_summaries_stage`; each keeps `latest_summary`/`latest_short` (catalog card) plus a rolling 53-week `weeks[]` history, idempotent by `week_start`. |

## Data model

- `deployment / change` — the per-deploy analysis (risk, rationale, summary,
  PRs, participants, signals, AI usage). Written once; the backfill skips
  deployments that already have it.
- `application|namespace / deploy_summaries` — weekly PROD roll-ups.
- `application|namespace / deploy_summaries_stage` — weekly STAGE roll-ups.
  An entity that only deploys to one environment only ever grows that block.
- All specs are **namespace-scoped** (never organization-wide): summaries are
  developer-visible, and entities outside the analyzed namespaces must not
  show empty metadata blocks.
- Participants: identity is commit-level (every commit author in the deployed
  range gets role `author`, even inside someone else's PR) plus PR-level
  roles (`author`/`reviewer`/`approver`). The weekly contributor `prs`
  counter counts PRs *opened* by that login — per-person content attribution
  (commits/lines per person) is a known follow-up.

## Setup (in order)

```bash
export NP_API_KEY=…           # org key: lake read + metadata write on the namespaces
export GITHUB_TOKEN=…         # PAT that can read the analyzed apps' repos

# 1. Metadata specs, scoped per namespace NRN
./setup/01-metadata-specs.sh \
  "organization=<org>:account=<acc>:namespace=<ns1>" \
  "organization=<org>:account=<acc>:namespace=<ns2>"

# 2. Config entries (folder /deploy-analysis)
./setup/02-config-entries.sh --namespaces "<ns1>,<ns2>" --environments "prod,stage"

# 3. Upload definitions (from the engine repo root; patches the sub-workflow id)
pnpm tsx workflows/deploy-analysis/setup/03-upload-workflows.mjs

# 4. Activate the `live` aliases (printed by the uploader), then the initial backfill:
curl -X POST "$API/workflows/definitions/<deploy_backfill-id>/execute?alias=live" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"inputs":{"days":15}}'

# 5. Seed past weekly summaries (after the backfill completes):
#    execute deploy_weekly_summary with {"inputs":{"week_offset":1}} and {"week_offset":2}
```

## Configuration knobs

| Where | Name | Meaning |
|---|---|---|
| config var | `DEPLOY_ANALYSIS_NAMESPACES` | comma-separated namespace ids to analyze |
| config var | `DEPLOY_ANALYSIS_ENVIRONMENTS` | scope `environment` dimension values (e.g. `prod,stage` — check your org's slugs) |
| config secret | `NP_API_KEY`, `GITHUB_TOKEN` | credentials the steps use |
| step config | `risk_agent.maxIterations: 10` | agent turn budget — newer models spend a few no-op tool turns before answering; 3 (the old opus tuning) dies with `error_max_turns` |
| step config | `summarize.maxIterations: 30` | same, sized for busy weeks |

## Cost reference (measured)

~USD 0.07 per deployment analysis (sonnet-class model, ~4–6k output tokens);
~USD 0.7–0.9 per weekly run. A 15-day backfill of ~135 deployments cost
~USD 8. Per-execution usage (turns, tokens, `cost_usd`) is available in each
run's `risk_agent`/`summarize` step outputs (`outputs.usage`).

## Operational notes

- The backfill's hourly tick uses a 1-day lookback; gaps longer than that
  (outage, disabled alias) self-heal on the next manual `days=N` run.
- Cron overlap policy is SKIP: a tick that lands while the previous run is
  still going is dropped — no pile-up.
- A large fresh backfill can saturate the sandbox pool; children that die
  before the LLM step cost nothing and the next run picks them up.
- `execute` takes `alias`/`revision` as **query string** parameters
  (`?alias=live`) — passing them in the body silently runs `latest`.
