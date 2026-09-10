# FinOps suite: cloud billing via agent packages, daily cost facts, and app allocation

Date: 2026-09-10. Status: approved design, pre-implementation.
Owner: Gabriel Eisbruch. Target org: itti. Iteration org: kwik-e-mart (1255165411, AWS 688720756067).

## 1. Goal and non-goals

Goal: a total-cost-allocation system on the workflow engine that (1) reads cloud
billing through an agent-run package so customers grant an IAM role instead of
handing us credentials, (2) stores one daily cost fact per subject in the catalog,
and (3) allocates those facts to applications and dimensions incrementally.

Explicit decisions taken with Gabriel on 2026-09-10:

- The total does NOT need to reconcile against the invoice. Prorated allocation
  (k8s by cpu/mem, shared databases) makes exact reconciliation impossible by
  construction. Every fact declares HOW it was allocated so the reader knows
  what is direct and what is a share.
- Go incrementally: direct-allocation resources first (tagged EC2, S3, dedicated
  databases), k8s prorated as the existing suites do, shared resources in an
  explicit bucket until a rule exists. Then look at what is left outside.
- Attribution by app starts with "service to its owning application"; harder
  cases (multi-instance databases, shared caches) come later through config.
- Everything is developed and tested LOCALLY (local agent on Gabriel's laptop,
  local dev-server). The only thing created in kwik-e-mart is the catalog
  entity (specs + instances). Nothing is deployed to itti in this design.

Non-goals: forecasting, anomaly detection, budgets, right-sizing (the `cost/`
suite owns that), Azure/GCP adapters (the runner contract allows them, no work
here), replacing `cost/` or `cost-finout/`.

## 2. Verified platform facts this design relies on

All measured on 2026-09-10 against `api.nullplatform.com` and read from
`nullplatform/agents-api` (`routes/agent_command.js`,
`services/agent_command_executor_service.js`, `schemas/agent_command_schemas.js`)
and `nullplatform/controlplane-agent` main (`supervisor/commandexecutor/worker_orchestrator.go`).

| Fact | Consequence |
|---|---|
| `POST /controlplane/agent_command` accepts `command.type: package-exec` with `data: {package?, version?, environment: {NP_ACTION_CONTEXT: "<json>"}}`. The worker receives the NP_ACTION_CONTEXT JSON as the gRPC `Execute` payload. | The workflow can call a package directly, with an arbitrary JSON request, no notification/channel needed. |
| The API exposes only `executions[0].results.{stdOut, stdErr, exitCode}`; the worker's gRPC `data` is dropped. | Runner output contract: logs on stderr, the result JSON alone on stdout. |
| Sync mode: HTTP gateway cuts at 60 s (504). Agent heartbeat timeout is 60 s and `execution_config.retry.max_attempts` defaults to 3, so a lost completion is re-delivered to the agent up to 3 times per POST. The agent-to-API completion message carries stdout AND data; ~360 KB stdout round-trips, ~800 KB is lost (never completes, re-delivered). | Sync is only for small, fast calls. Large answers are a poison pill, not an error. |
| Async mode: `execution_config: {async: true}` resolves on the agent's `started` (~1 s) with `executions[0].commandId`. There is NO route to fetch the result later (only `POST /agent_command` and `POST /:commandId/cancel`). `ping` never emits `started`, so async ping fails. | The worker must push its result somewhere. |
| The engine has `POST /workflows/webhooks/callback/:executionId/:signalName` (unauthenticated, executionId is the capability) which signals a `signal-wait` step. | The worker pushes the result to the engine; the workflow waits with `signal-wait`. |
| Agent image `alpha-packages-2.2.0` (the template default) does not inject env into docker workers and never answered. `latest` (0.11.1) supports `package-exec`, `NP_WORKER_PATCHES`, `NP_WORKERS`. | Local dev uses `:latest`. The template's `mise run` task must be overridden. |
| Restarting the agent container registers a NEW agent id; commands to the old id fail with "failed to start after all retry attempts". | Workflows select agents by TAGS, never by pinned id. |
| kwik AWS is a linked account: no CUR, no Data Exports, cost allocation tags are managed by the payer (AccessDenied). Cost Explorer works. ~USD 600/30 d, one EKS cluster `developent`, 3 EC2 scopes tagged `scope_id`, `application_id`, `namespace_id`. No Container Insights, no AMP, no metrics-server addon. | Phase 1 uses Cost Explorer. k8s usage split needs an in-cluster package (phase 3). |

## 3. Architecture

```
workflow (engine)                       customer side
─────────────────                       ─────────────
np-package-call ──async package-exec──▶ agent (tags) ──spawns──▶ cloud-query worker
   │  (dispatch, then WAIT)                                       │ runs SDK calls with the
   │                                                              │ pod's IAM role
   ◀──── POST /workflows/webhooks/callback/{executionId}/{signal} ┘ result JSON
   │
collectors ──▶ cost_daily facts (catalog) ──▶ allocator ──▶ cost_daily facts (allocated=true)
                                                                └──▶ dashboards (np-report, lake)
```

Three layers, each independently testable:

1. **Runner**: `cloud-query` package + `np-package-call` engine plugin + a reusable
   child workflow `finops/tool-cloud-query.yaml`.
2. **Facts**: catalog spec `cost_daily` + one collector workflow per source.
3. **Allocation**: catalog spec `cost_allocation_rule` + allocator workflow that
   turns raw facts into per-application facts.

## 4. Layer 1: the runner

### 4.1 `cloud-query` package (`finops/packages/cloud-query/`)

Already scaffolded and spiked (`simple-bun` template, bun 1.4, `@nullplatform/plugin@0.0.4`).
It carries NO cost semantics. It executes a list of SDK calls and returns raw responses.

Request (the NP_ACTION_CONTEXT JSON, key `cloud_query`):

```json
{
  "cloud_query": {
    "provider": "aws",
    "region": "us-east-1",
    "assumeRole": { "roleArn": "arn:aws:iam::123:role/np-finops", "externalId": "..." },
    "calls": [
      { "id": "cost_by_service", "service": "ce", "operation": "GetCostAndUsage",
        "params": { "TimePeriod": {"Start": "2026-09-01", "End": "2026-09-02"},
                    "Granularity": "DAILY", "Metrics": ["UnblendedCost"],
                    "GroupBy": [{"Type": "DIMENSION", "Key": "SERVICE"}] },
        "paginate": true, "maxPages": 20 }
    ],
    "maxResultBytes": 307200,
    "callback": { "url": "https://api.nullplatform.com/workflows/webhooks/callback/<executionId>/cloud-query.<stepId>",
                  "token": "<opaque, echoed back; optional>" }
  }
}
```

Rules:

- `service` is a fixed allow-list compiled into the binary: `ce`/`cost-explorer`,
  `cloudwatch`, `ec2`, `sts`. Adding a service is a package release. `operation`
  is the PascalCase SDK command name (`GetCostAndUsage` maps to `GetCostAndUsageCommand`).
- Pagination follows `NextPageToken`, `NextToken`, `NextContinuationToken`, `Marker`;
  pages are merged: arrays concatenated, scalars last-page-wins, tokens and
  `$metadata` dropped.
- Credentials: default AWS provider chain (IRSA / pod identity in a cluster,
  `NP_WORKER_PATCHES` env locally). Optional `assumeRole` via STS before the calls.
- Per-call result cap `maxResultBytes` (default 300 KB). Over the cap: the call
  fails with `RESULT_TOO_LARGE`; the caller narrows the window or the grouping.
  The runner never truncates data silently.
- Output contract: progress lines on stderr; on stdout exactly one JSON document
  (the response below). If `callback.url` is present the runner ALSO POSTs the
  response there (JSON body, `Content-Type: application/json`, 3 attempts with
  backoff, 10 s timeout each). The gRPC result `success` is false if any call
  failed or the callback POST failed after retries.

Response:

```json
{
  "provider": "aws", "region": "us-east-1",
  "identity": { "account": "688720756067", "arn": "arn:aws:iam::...:role/np-finops" },
  "token": "<echoed callback.token>",
  "calls": [
    { "id": "cost_by_service", "ok": true, "pages": 1, "durationMs": 980, "result": { "ResultsByTime": [...] } },
    { "id": "big", "ok": false, "durationMs": 4191, "errorCode": "RESULT_TOO_LARGE", "error": "result is 1.7 MB, cap is 300 KB; narrow the query" }
  ]
}
```

Package identity: manifest `name: cloud-query`, selector `{package: cloud-query}`,
`command_types: ["custom"]`. Version from `package.json`.

Distribution: `np package publish` to a registry allowed by the customer agent
(`worker.allowedRegistries`). For itti the image is pinned by digest in the agent
Helm values (`worker.pins`) with `serviceAccount` bound to the IAM role. This is
operator configuration, outside this repo.

Tests: `bun test` unit tests on `runner.ts` (pagination, merge, caps, per-call
errors, validation) with a fake client factory. No live AWS in tests.

### 4.2 Engine plugin `np-package-call` (workflow-system-demo, `packages/core/src/plugins/built-in/np-package-call/`)

A new MODULE plugin, composite wait, two-phase protocol per CLAUDE.md
("Composite wait plugins MUST use the two-phase protocol"). It does not extend
`np-agent-command` because that plugin is a one-shot sync call and the wait
semantics differ; `np-agent-command` stays untouched.

Config:

| Field | Type | Notes |
|---|---|---|
| `apikey` | string | `${{ secrets.NP_API_KEY }}` (config entry, never `ctx.secrets`) |
| `agent_selector` | `{ nrn?, tags }` | passed verbatim to `/controlplane/agent_command` (`selector` + `nrn`). Never `agent_id`. |
| `package` | string | e.g. `cloud-query` |
| `version` | string, optional | semver pin |
| `action_context` | object | becomes `environment.NP_ACTION_CONTEXT` (JSON-stringified by the plugin) |
| `mode` | `async` (default) or `sync` | sync: one-shot, result parsed from `results.stdOut`; async: dispatch + wait |
| `callback_base_url` | string | default `https://api.nullplatform.com`; the plugin builds `${base}/workflows/webhooks/callback/${execution.id}/${signalName}` and injects it as `action_context.<callback_key>` |
| `callback_key` | string | default `cloud_query.callback` (dotted path inside `action_context` where `{url, token}` is written) |
| `timeout` | duration string | wait timeout, default `30m` |
| `retry_max_attempts` | int | `execution_config.retry.max_attempts`, default 1 (NOT the API default 3: re-delivery of a package-exec re-runs billing calls) |
| `timeout_seconds` | int | HTTP timeout for the dispatch call, default 30 (async) / 120 (sync) |

Behavior (async):

1. Phase 1: build `signalName = package-call.${ctx.stepId}`, `correlationKey = ${ctx.executionId}`,
   a random `token = ctx.helpers.uuid()`; inject `{url, token}` into the action
   context; POST `/controlplane/agent_command` with `execution_config: {async: true, retry: {max_attempts}}`.
   On HTTP error or `executions[0].status !== 'success'`: return a NON-retryable
   failure with the platform error (`AGENT_NOT_FOUND`, `DISPATCH_FAILED`).
   Otherwise return `IStepResult.wait` with `{signalName, correlationKey, timeout}`
   and interim outputs `{commandId, agentId, dispatchedAt}`.
2. Phase 2 (`ctx.resume`): the signal payload is the runner response. Verify
   `payload.token === token` (stored in step state in phase 1); mismatch = failure
   `CALLBACK_TOKEN_MISMATCH` (the callback route is unauthenticated; the token
   makes a forged POST harmless). Outputs: `{commandId, agentId, response, calls: response.calls, failed: [...ids]}`.
   `status: 'failure'` with `CALLS_FAILED` when any call has `ok: false`
   (the response is still in outputs so the workflow can branch).
3. Timeout: the wait fails (`onTimeout: error` semantics); route with
   `error_handling.fallback_step` + a declared `condition: "false"` edge, never
   via a non-default output port (CLAUDE.md port-wiring rule).

Behavior (sync): as today's `np-agent-command exec` branch but for `package-exec`;
`JSON.parse(results.stdOut)` into `response`; any parse error is `BAD_RUNNER_OUTPUT`.

Descriptor: `category: nullplatform`, `executeMode: all`, ports `default` only,
`capabilities: ['awaits-signal']`, rich `configUiSchema`, examples for both modes.
Tests with `createPluginTest`: dispatch body shape, wait shape, token check,
sync parse, error mapping. The activity must not use `waitForSignal()` (throws
on Temporal).

Determinism: the token comes from `ctx.helpers.uuid()`; no `Date.now()`.

### 4.3 Child workflow `finops/tool-cloud-query.yaml`

A reusable sub-workflow so collectors (and agents, via `sub-workflow` as a tool)
do not repeat the plumbing:

- Inputs: `agent_tags` (object), `calls` (array), `region` (string, optional),
  `assume_role_arn` (optional), `mode` (`async` default).
- One `np-package-call` step + a `code-exec` that reshapes `outputs.calls` into
  `{ <call id>: result }` and fails loudly listing failed call ids.
- Outputs: `results` (map by call id), `identity`.

## 5. Layer 2: daily cost facts

### 5.1 Catalog spec `cost_daily` (`finops/specs/cost_daily.spec.json`)

Generalizes `infrastructure_cost_daily` (falabella). One instance per
(subject, day, allocation stage). Flat fields, denormalized names, `additionalProperties: false`,
`schema.authorization` grants as in the falabella spec (without it API keys get 403).

| Group | Fields |
|---|---|
| Identity | `id` (`<stage>:<subject_type>:<subject_id>:<d>`), `d` (YYYY-MM-DD), `stage` enum `raw` / `allocated` |
| Subject | `subject_type` enum `cloud_service` / `resource` / `cluster` / `scope` / `service` / `application` / `bucket`; `subject_id`; `subject_name`; `nrn` (nullable) |
| Null dimensions (nullable) | `application_id`, `application_name`, `namespace_id`, `namespace_name`, `account_id`, `account_name`, `environment`, `scope_id`, `scope_name`, `service_id`, `service_name` |
| Cloud dimensions | `cloud` enum `aws` / `azure` / `gcp` / `other`; `cloud_account`; `region`; `cloud_service` (e.g. `Amazon Elastic Compute Cloud - Compute`); `usage_type` (nullable); `resource_id` (nullable); `cluster` (nullable) |
| Money | `cost_usd` (chargeback), `usage_usd` (nullable, when usage is known), `waste_usd` (nullable) |
| Usage vs reservation (nullable, resource-kind specific) | `cpu_req_core_h`, `cpu_used_core_h`, `mem_req_gb_h`, `mem_used_gb_h`, `storage_gb`, `requests_total`, `units` (free-form unit label), `quantity` |
| Provenance | `source` enum `aws_ce` / `aws_cur` / `k8s` / `manual`; `allocation_method` enum `direct_tag` / `direct_resource` / `cluster_split_cpu_mem` / `service_owner` / `rule` / `unallocated`; `rule_id` (nullable); `parent_id` (nullable: the raw fact an allocated fact came from); `share` (0..1, nullable); `collected_at`; `collector` (workflow id + revision) |

Invariants:

- `raw` facts are written only by collectors; `allocated` facts only by the
  allocator. Each workflow owns its top-level fields; catalog `PATCH ?upsert=true`
  merges at top level (falabella lesson).
- Σ `allocated` facts of a day ≤ Σ `raw` facts of the day. The difference is
  visible as `allocation_method: unallocated` facts, never hidden.
- A subject's daily fact is idempotent: re-running a collector for a day
  overwrites the same `id`.

Retention: 400 days of daily facts. Weekly/monthly aggregates are a dashboard
concern (lake queries), not stored.

### 5.2 Collectors (kwik, phase 1)

All collectors are daily crons with a `date` input (default: yesterday, UTC),
and a `days_back` input for backfill fan-out. Each runs one
`tool-cloud-query` call set sized under the 300 KB cap (one day, one grouping
per call).

| Workflow | Calls | Facts written (`stage: raw`) |
|---|---|---|
| `wf1-aws-billing-daily.yaml` | CE `GetCostAndUsage` for `date`, DAILY, `UnblendedCost`, grouped (a) by `SERVICE`, (b) by `SERVICE` + `USAGE_TYPE` | one `cloud_service` fact per service (`allocation_method: unallocated`, the org-level truth), one `bucket` fact per (service, usage_type) when `USAGE_TYPE` grouping is available |
| `wf2-aws-tagged-resources-daily.yaml` | CE grouped by `TAG` `scope_id` (needs the tag activated at the payer; kwik: DEFERRED until activated, see §8), fallback: EC2 `DescribeInstances` filtered by tag `scope_id` + CE `RESOURCE_ID` grouping for the last 14 days | one `scope` fact per tagged scope with `allocation_method: direct_tag`, joined to null names via `np-lake-query` (scope, application, namespace) |
| `wf3-eks-cluster-daily.yaml` | CE filtered by tag `eks:cluster-name` = cluster (nodes) + service `Amazon Elastic Container Service for Kubernetes` (control plane) | one `cluster` fact per EKS cluster with `cost_usd` = nodes + control plane, `allocation_method: unallocated` until phase 3 splits it |

Joins to null entities use `np-lake-query` (scope/application/namespace names by
id), never the NP API in a loop.

Fact writes: `code-exec` with `PATCH /catalog/instances/cost_daily/{id}?upsert=true`,
3 retries with backoff on 5xx (copied from `cost-finout/wf3`), `mapLimit` 5.
Writes are the only network I/O outside the runner; the step runs
`runtime.kind: microvm` with `executionConfig.timeoutMs` set explicitly.

## 6. Layer 3: allocation

### 6.1 Catalog spec `cost_allocation_rule`

One instance per rule, evaluated in `priority` order by the allocator:

| Field | Meaning |
|---|---|
| `id`, `name`, `enabled`, `priority` (int) | identity and ordering |
| `match` | object: any of `subject_type`, `cloud_service`, `usage_type` (glob), `resource_id` (glob), `cluster`, `cloud_account`, `region` |
| `method` | enum `service_owner` / `fixed_split` / `by_usage` / `bucket` |
| `targets` | for `fixed_split`: `[{application_id, share}]` (shares sum to 1); for `bucket`: `{bucket_name}`; for `service_owner` / `by_usage`: empty (resolved from null data) |
| `usage_metric` | for `by_usage`: `cpu_req_core_h` / `mem_req_gb_h` / `requests_total` |

Built-in behavior without rules: `scope` facts with `application_id` allocate
100 % to that application (`direct_tag`); `service` facts allocate to the
service's owning application (`service_owner`, owner read from the lake);
everything else stays `unallocated`.

### 6.2 Allocator `wf5-allocate-daily.yaml`

Daily cron after the collectors. For a `date`: read raw facts (lake query on
`cost_daily` with `stage = raw`), read rules, apply in priority order, write
`allocated` facts with `parent_id`, `share`, `rule_id`, `allocation_method`.
Output summary fact per application (`subject_type: application`) and per
bucket. Re-runnable: it first deletes nothing; it overwrites by `id`
(`allocated:application:<app>:<d>`, `allocated:bucket:<name>:<d>`).

Sanity check inside the run: Σ allocated ≤ Σ raw, else fail the run.

## 7. Phases and acceptance

| Phase | Deliverable | Acceptance |
|---|---|---|
| 0 | `np-package-call` plugin (engine) + `finops/tool-cloud-query.yaml` | Unit tests green; local dev-server executes `tool-cloud-query` against the local agent in async mode and receives the callback; sync mode works for a small call; oversized call fails with `RESULT_TOO_LARGE` and NO re-delivery on the agent |
| 1 | `cloud-query` package hardened (callback POST, tests) + `cost_daily` spec in kwik + wf1/wf3 collectors + 30-day backfill | Lake query shows one `cloud_service` fact per service per day for 30 days; Σ facts of a day equals CE's daily total within 1 % |
| 2 | wf2 tagged resources (EC2 scopes) + allocator with built-in behavior + rules spec + 1 `fixed_split` rule | Per-application allocated facts for the 3 tagged scopes; unallocated bucket visible; Σ allocated ≤ Σ raw enforced |
| 3 | k8s split: in-cluster `k8s-query` package (Kubernetes API: pod requests/usage via metrics.k8s.io when present) + `wf4-eks-split-daily.yaml` splitting `cluster` facts by cpu/mem into `scope` facts | Cluster fact fully split (scopes + `cluster-overhead` bucket) for kwik's `developent` |
| 4 | itti rollout runbook: IAM role + IRSA, agent Helm values (`allowedRegistries`, `pins`, `serviceAccount`), package publish, config entries | Documented in `finops/README.md`; not executed in this design |

Every phase ends with: `pnpm lint:workflows`, `np-workflow validate` on the
YAMLs, E2E test with `runWorkflowE2E` for each collector (mocking
`np-package-call` at the plugin level), and a live run on the local dev-server.

## 8. Open items (tracked, not blocking phase 0/1)

- Cost allocation tag `scope_id` must be activated at kwik's payer account for
  `GROUP BY TAG`. Until then wf2 uses the EC2 inventory + resource-level CE.
- itti: confirm billing source (CE vs CUR) and whether it is a payer or linked
  account. CUR adds `athena` + `s3` to the runner allow-list.
- `agents-api` retry default of 3 re-delivers package-exec on lost completions;
  the plugin sends `max_attempts: 1`. A platform-side "no retry for package-exec"
  default is worth proposing separately.
- The callback route is unauthenticated by design; the per-dispatch token
  closes the forged-POST gap for this plugin. An engine-level HMAC remains a
  future hardening (noted in `webhooks-callback.ts`).

## 9. Local development setup (recorded from the spike)

```bash
# CLI with `np package` (preview channel), kept separate from the stable np
curl -fsSL -o ~/.local/bin/np-preview https://cli.nullplatform.com/packages-preview/np-Darwin-arm && chmod +x ~/.local/bin/np-preview
brew install mise

# worker image
cd finops/packages/cloud-query && docker build -t cloud-query-worker:dev .

# local agent (docker backend). AWS creds reach the worker through a pod patch.
docker run -d --name np-cloud-query-agent --network host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e NP_API_KEY -e NP_WORKER_BACKEND=docker -e NP_WORKER_IMAGE=cloud-query-worker:dev \
  -e NP_WORKER_PATCHES='[{"target":{"package":"cloud-query"},"merge":{"spec":{"containers":[{"name":"worker","env":[{"name":"AWS_ACCESS_KEY_ID","value":"..."},{"name":"AWS_SECRET_ACCESS_KEY","value":"..."},{"name":"AWS_REGION","value":"us-east-1"}]}]}}}]' \
  public.ecr.aws/nullplatform/controlplane-agent:latest \
  -runtime=host -tags=package:cloud-query,local:$USER,env:local
# after rebuilding the image: docker rm -f np-worker-docker-desktop-cloud-query
```

The `mise run` task from the template must be updated to `:latest` and to pass
`NP_WORKER_PATCHES`; that change ships with phase 1.
