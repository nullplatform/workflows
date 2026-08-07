# deploy-governance

Deploy governance without a human bottleneck: every production deployment
gets an **automatic change analysis** (what changed, who touched it, how risky
it is), the result gates the deploy through a **risk × criticality matrix**,
and the accumulated data rolls up into **weekly functional summaries** per
application and namespace — release notes nobody had to write.

This is the suite nullplatform runs on its own organization (dogfood). It
replaced "someone self-approves in Slack" with evidence-based gates.

## The system

```
deploy to production
        │
        ▼ (checklist external item, kind: deploy-change-analysis)
┌─────────────────────────┐    per-deploy analysis:
│ deploy-change-analysis  │──► diff deployed→candidate release (GitHub compare)
│ (np-checklist-trigger)  │    PRs as rich objects (author, collaborators+roles,
└───────────┬─────────────┘    description, LLM one-line summary)
            │                  deterministic risk signals (db migrations, auth,
            │                  infra, deps paths) + LLM score bounded by floors
            │                  light matrix: risk × app criticality → auto/peer/group
            ▼
  deployment.metadata.change   (the durable artifact everything else reads)
            ▲
┌───────────┴─────────────┐
│ deploy-backfill         │  nightly cron (+ manual webhook): finds prod deploys
│                         │  WITHOUT metadata in the last N days and fires the
└─────────────────────────┘  analysis for each — self-healing safety net
            │
            ▼ (weekly cron, well after the nightly)
┌─────────────────────────┐  ONE LLM call aggregates the week's already-written
│ deploy-weekly-summary   │  per-deploy summaries into app summaries + namespace
└───────────┬─────────────┘  roll-ups. No GitHub calls, no re-analysis.
            ▼
  application/deploy_summaries + namespace/deploy_summaries
  (rolling 53 weeks; the catalog card shows latest_summary only)
```

## Workflows

| File | Trigger | Purpose |
|---|---|---|
| `deploy-change-analysis.yaml` | `np-checklist-trigger`, kind `deploy-change-analysis` | Resolves the checklist external item on real deploys: analysis → metadata → item resolution with markdown + per-gate results |
| `deploy-change-analysis-manual.yaml` | webhook | Same pipeline behind a plain webhook: smoke tests and backfill children. Payload mirrors the trigger outputs (`runId`, `itemId`, `callbackUrl`, `callbackToken`, `inputs.*`) plus backfill overrides (`from_release_id`, `previously_deployed`) |
| `deploy-backfill.yaml` | cron (nightly) + webhook (manual) | Lake query for prod deploys missing `metadata.change` → fires the manual webhook per deploy. Skip-existing makes it idempotent and convergent |
| `deploy-weekly-summary.yaml` | cron (weekly) | Aggregates the week per app/namespace, one LLM call, writes rolling summaries |

`templates/checklist-template-cross-validation.yaml` is the target checklist
template: the analysis item (informational) plus a `cross_validation` group
(`aggregation: any`) where already-deployed fastpath, the risk matrix, a
four-eyes pair review, and an admin escalation each unblock the deploy.

## Setup

1. **Catalog specs** (one-time):
   ```bash
   NP_API_KEY=... NP_ORGANIZATION_ID=<org> ./setup/01-catalog-specs.sh
   ```
   Then classify applications (`governance.criticality`, editable in the UI)
   and map users (`identity.github_username`).

2. **Config entries** (never in YAML):

   | Entry | Kind | Scope | Used by |
   |---|---|---|---|
   | `NP_API_KEY` | secret | each workflow | NP API + lake access |
   | `GITHUB_TOKEN` | secret | analysis workflows | compare/PR/review reads |
   | `NP_ORGANIZATION_ID` | var | analysis workflows | trigger NRN + user listing |
   | `CHANGE_ANALYSIS_WEBHOOK` | secret | backfill | activated webhook URL of the manual variant (token-bearing → secret) |

   Note: a workflow's `path:` does **not** inherit folder config — scope
   entries to each workflow.

3. **Publish** (`npx np-workflow publish <file> --alias live`), activate, then
   set `CHANGE_ANALYSIS_WEBHOOK` to the URL minted for the manual variant
   (`GET /workflows/triggers?workflowId=...`).

4. **Backfill history**: `POST` the backfill webhook with
   `{"days": 14, "application_id": 0}` (0 = all apps). Re-fire until it
   reports `fired: 0` — see gotchas.

## Metadata contract: `deployment.metadata.change`

The durable artifact of the suite. Its specification carries a **full JSON
Schema** (`specs/deployment-change.spec.json`, upserted by the setup script)
so the dashboard renders it schema-driven instead of dumping a JSON blob.

What the analysis writes per deploy (all levels `additionalProperties: true`):

| Field | Shape | Notes |
|---|---|---|
| `risk` | `low \| medium \| high` | LLM score bounded by deterministic floors |
| `short_summary` / `summary_md` | string / markdown | one-liner + full narrative (PRs, participants, rationale) |
| `risk_rationale`, `risk_floors_applied` | string, string[] | floors: `db_migration`, `auth_change`, `first_deploy` |
| `change_categories` | `[{category, count, notes}]` | LLM taxonomy (feature/bugfix/security/…); `category` is deliberately a free string in the schema so historical docs never fail write-validation |
| `breaking`, `hotfix` | boolean | only present when true |
| `approval` | `{mode, criticality}` | matrix decision: `auto \| fastpath \| par \| grupo` |
| `from_release` / `to_release` | `{id, semver, commit_sha}` | `from_release` is `null` on first deploys |
| `releases_between`, `previously_deployed` | int, bool | accumulation + rollback fastpath |
| `signals` | sizes + `sensitive_paths{}` | deterministic inputs to the risk score |
| `prs` | rich PR objects | number/title/author/summary/size + per-PR `ai {used, level}` |
| `participants` | `[{github, np_user_id?, roles}]` | `np_user_id` null until mapped via `user/identity` |
| `ai_usage` | `{prs_ai, prs_total, commits_ai, commits_total}` | declared-AI lower bound |

**Visibility contract**: the schema declares `visibleOn: ["read"]` at the
root — the document renders on the **deployment detail** only. It never
becomes deployment-list columns (nothing is marked `visibleOn: list`, which
list columns require per property) and never appears in create/update forms
(it is machine-written). Raw payloads (`commits`, `files`, long PR
descriptions, plumbing ids) are intentionally **not declared** as properties:
`additionalProperties: true` keeps accepting them on writes, but the
schema-driven UI does not render them — `summary_md` already narrates that
content.

**Evolving the schema**: the metadata service validates every write against
it, so a stricter schema can brick the analysis pipeline. Before changing
`specs/deployment-change.spec.json`, validate a sample of real stored docs
against the new schema (AJV 8, `strict: false` — same as the service), then
re-run `setup/01-catalog-specs.sh` (it PATCHes the existing spec in place).

## Cron layout

- Backfill: nightly (e.g. `30 1 * * *`), window 3 days — self-heals gaps.
- Weekly summary: e.g. Mondays `0 9 * * 1` — hours AFTER the nightly, so the
  closing week is fully analyzed before it is summarized.

## Production gotchas this suite encodes

- **Trigger config is literal**: `${{ vars.* }}` does NOT resolve inside a
  trigger's `config` at activation (steps resolve at run time; triggers do
  not) — the `np-checklist-trigger` `nrn` must be a literal, or channel
  creation fails with an opaque 401. Activation also needs a caller with
  `notification_channel` permissions (the activate call's bearer is the
  actor for channel management).

- **Sandbox pool saturation**: firing 100+ analysis children at once exhausts
  the code-exec sandbox pool; children die *before* the LLM step (zero cost).
  The dispatcher skips deploys that already have metadata, so re-firing
  converges instead of re-paying. Failures show as `SANDBOX_NOT_AVAILABLE`
  or as executions that "completed" through their failure-resolve fallback —
  check step statuses, not execution status.
- **GitHub reads are parallel**: per-commit PR lookups and per-PR reviews run
  in chunks of 10. Sequential, a 100-commit diff exceeds the sandbox budget.
- **First deploys**: the lake's TSV `NULL` (`\N`) for `lag()` means "first
  deploy of this scope". The dispatcher sends the explicit `"none"` sentinel;
  the analysis then keeps `from = null` instead of wrongly diffing against
  *today's* current release.
- **Agent prompt size**: the weekly summary sends a compact `llm_view`
  (summaries + PR titles only) — the full gathered object on a busy week
  (~180KB) crashes the agent runner. Keep agent prompts under ~100KB.
- **Agent tool detours**: data-in → structured-out agent steps need
  "do NOT use tools, respond directly" in the system prompt and enough
  `maxIterations` headroom (15), or the model burns its turns exploring.
- **Metadata writes are schema-validated** (with AJV type coercion, so
  mismatches produce confusing errors like `prs/0 must be object`). Each
  spec must declare exactly what its workflow writes.
- **Catalog UI keys** live *inside* schema properties: `visibleOn`
  (`create|read|update|list`; `[]` hides a field from the UI while keeping
  it via API), `uiSchema`, `tag`. The dashboard card renders the `read`
  context — this suite shows `latest_summary` only and keeps `weeks` as
  API/lake data.
- **Lake over HTTP**: `POST /data/lake/query {query}` returns *headerless*
  TSV — parse positionally, expect numbers as strings, and add `FINAL` to
  versioned tables or rows duplicate.

## Tests

The suites' usual plugin-level stubbing does not apply here: this suite's
I/O happens inside `code-exec` sandboxes (raw `fetch` to the NP API, the
lake and GitHub), not through stubbable integration plugins. Validate with
`npx np-workflow validate <file>` (all four pass, including the dual graph
pass) — behavioral coverage comes from the manual-webhook variant, which
runs the full pipeline against a real deployment without touching any
checklist run.
