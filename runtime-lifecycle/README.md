# Lambda Runtime Lifecycle

Detects lambdas (NP `serverless` scopes) running on AWS Lambda runtimes that are
deprecated or about to be deprecated, opens Engineering action items with
one-click AI migration suggestions, gates claimed resolutions against the live
deploy, and auto-closes items once a compliant deploy is active.

Mirror of the [cost right-sizing suite](../cost/README.md)'s proven patterns:
idempotency, lake-first detection, flat per-item writes, suggestion UX, prod
hard gates, event routing. Design doc:
[`docs/superpowers/specs/2026-07-20-lambda-runtime-lifecycle-design.md`](../../docs/superpowers/specs/2026-07-20-lambda-runtime-lifecycle-design.md).

Rollout target: **kwik-e-mart** (org `1255165411`, API key in repo-root `.env`)
first; **null** (org 4, `.env.null`) later.

## Pieces (see the design doc for the full rationale)

| File | What it is |
|---|---|
| `wf-r1-catalog-sync.yaml` | Weekly cron (Sunday): AI-agent scrape of the AWS Lambda runtime support/deprecation docs → validated upsert of the `lambda_runtimes` org metadata catalog |
| `wf-r2-scanner.yaml` | Weekly cron (Monday): ONE lake query finds active `serverless` scopes on a deprecated/expiring runtime, classifies each against the catalog, and opens/refreshes Engineering action items (label `workflow_type: lambda-runtime`) with a migration suggestion — all via flat per-item `np-api-call` passes (no sub-workflow fan-out; the old `wf-r2b` child is retired) |
| `wf-r3-events.yaml` | Action-item events for `workflow_type=lambda-runtime`: suggestion accepted → wf-r4; resolved → live-deploy compliance gate; comments → ack + AI answer |
| `wf-r4-apply.yaml` | Applies an accepted suggestion: patches `capabilities.serverless_runtime.id`, prod hard-gates to apply-only, dev/stage optionally redeploys via the shared `progressive_deploy` sub-workflow |
| `wf-r5-closer.yaml` | Daily cron (08:00): ONE lake query finds live items whose scope is gone or now on a supported runtime, re-verifies each against the LIVE scope/deploy, and closes + comments the confirmed ones — all via flat per-item `np-api-call` passes (no sub-workflow fan-out; the old `wf-r5b` child is retired); never touches deferred/pending items |
| `setup/*` | Configuration runbook (below) |
| `__tests__/*` | `runWorkflowE2E` coverage (catalog validation, classification, idempotency, prod gates, resolve gate, closer) |

## Catalog: `lambda_runtimes` organization metadata

Hidden from the UI (root `schema.visibleOn: []`) — maintained entirely by
wf-r1, readable via API and the lake. One instance per org:

```json
{
  "runtimes": [
    { "id": "nodejs16.x", "language": "nodejs", "version": "16",
      "status": "deprecated", "deprecation_date": "2024-06-12",
      "block_function_create": "2025-02-28", "block_function_update": "2025-03-31",
      "os": "Amazon Linux 2" }
  ],
  "source_urls": ["…"],
  "scraped_at": "ISO", "supported_count": 0, "deprecated_count": 0
}
```

## Config entries

| Path | Name | Secret | Purpose |
|---|---|---|---|
| `/runtime-lifecycle` | `NP_ORGANIZATION_ID` | no | Org id, for API calls that need it explicitly |
| `/runtime-lifecycle` | `RUNTIME_LIFECYCLE_CATEGORY_SLUG` | no | Real category slug (`engineering`) — slugs are global, never hardcode |
| `/runtime-lifecycle` | `RUNTIME_WARN_DAYS` | no | Days-to-deprecation threshold for `priority: high` (default `31`) |
| `/runtime-lifecycle` | `RUNTIME_TARGET_HORIZON_DAYS` | no | Forward horizon (days) the scanner/dashboards consider (default `180`) |
| `/deploy` | `DEPLOY_WINDOW_START` / `_END` / `_TZ_OFFSET` | no | Deploy window for the shared `progressive_deploy` sub-workflow (wf-r4) |
| `/deploy` | `DEPLOY_TRAFFIC_STEPS` | no | Progressive traffic steps, e.g. `10,50,100` |
| `/deploy` | `DEPLOY_STEP_WAIT_SECONDS` | no | Soak time between traffic steps |
| `/deploy` | `DEPLOY_PENDING_TIMEOUT_MINUTES` | no | How long a gated/pending deployment is polled |
| `/deploy` | `DEPLOY_MAX_ERROR_RATE_INCREASE` / `DEPLOY_MAX_RESPONSE_TIME_RATIO` | no | Progressive-deploy degradation gates |
| `/` | `NP_API_KEY` | **yes** | Shared org credential — written once, never overwritten by re-runs (checked via GET before upsert) |

## Setup (kwik-e-mart)

Reuses the cost suite's `lib.sh` conventions (`workflows/cost/setup/lib.sh`)
and `--env-file` so the same scripts run against kwik-e-mart (`.env`) and,
later, null (`.env.null`). Run in order, from `workflows/runtime-lifecycle/setup/`:

```bash
./01-catalog-spec.sh   --env-file ../../../.env   # lambda_runtimes org metadata spec + empty seed instance
./02-category.sh       --env-file ../../../.env   # verify the Engineering category (create if missing/grants)
./03-config-entries.sh --env-file ../../../.env   # config entries on /runtime-lifecycle and /deploy, + root NP_API_KEY secret
```

All three are idempotent — safe to re-run. `01` upserts the metadata spec
(create-or-patch) and only seeds the instance if none exists; `02` reports the
existing category rather than duplicating it (category slugs are global on
the platform — always read the slug back, never assume it); `03` upserts
config entries by name+path and skips the root secret if it's already there.

Live state on kwik-e-mart (verified 2026-07-20): spec id
`edce24c3-37d5-4a03-b305-385525ec7e7b`, category `Engineering` → slug
`engineering` (id `8dXVjyDvLaHx`).

## Crons (once the workflows are deployed)

| Workflow | Schedule |
|---|---|
| wf-r1 catalog sync | Weekly, Sunday |
| wf-r2 scanner | Weekly, Monday |
| wf-r5 closer | Daily, 08:00 |
