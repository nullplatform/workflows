# FinOps suite

Cloud billing read through an **agent-run package** (the customer grants an
IAM role, no credentials in workflows), one **cost fact per subject per day**
in the catalog, and allocation to applications by direct attribution and by
Kubernetes consumption.

Read first:
- [docs/analysis-kwik-e-mart-2026-09-10.md](./docs/analysis-kwik-e-mart-2026-09-10.md) — the reference analysis (numbers, decisions, what maps and what does not)
- [docs/mapping-playbook.md](./docs/mapping-playbook.md) — how to repeat it for another account, service by service, and which ids join cloud resources to null
- Design: `docs/superpowers/specs/2026-09-10-finops-cost-allocation-design.md`; phase-0 plan: `docs/superpowers/plans/2026-09-10-finops-phase0-runner.md`

| Piece | What it is |
|---|---|
| `packages/cloud-query/` | The runner package (image `public.ecr.aws/nullplatform/agent-plugins/workflows/aws-cost-explorer`): generic AWS SDK call executor — `ce`, `ec2`, `elbv2`, `rds`, `pi` (Performance Insights), `tagging`, `cloudwatch`, `logs`, `sts` — pagination, per-call size cap, callback with host allow-list; in callback mode the command completion is a small receipt. See its README. |
| `tool-cloud-query.yaml` | Reusable child: agent tags (+ `agent_nrn`) + calls → results by call id (async with engine callback by default, sync for small calls). Carries the image as an `oci_image` artifact: no package registration on the platform. |
| `wf0-aws-billing-dispatch.yaml` | **The daily loop** (cron 04:15 UTC): one target per account (agent tags × NRN × AssumeRole × region) → `wf1` per target → `wf2` allocation of the day → `wf-suggest-mappings` for what stayed unallocated. `expected_account` guards the pairing. |
| `wf1-aws-billing-daily.yaml` | Collector: one day of AWS billing → `raw` `cost_daily` facts (cloud services, usage-type buckets, EC2 scopes by null tags, one bucket for instances that terminated before collection, EKS clusters with components per cloud service + blended rates, databases with host/tags). Evidence fields (`tags`, `host`) travel with the facts. |
| `wf3-k8s-consumption-daily.yaml` | **Kubernetes consumption**: per null scope, `max(usage, request)` per hour from the cluster's Prometheus through the agent (the cost tracker's collector script), priced with the day's blended rates → `raw-k8s-scope-*` rows (cost, usage, waste, core-h/GiB-h) and the cluster row's consumption shares (`metric_shares`/`metric_owners`) that split the cluster among applications. Replaces the metadata `cost_tracking` writes of `cost/wf1b`. |
| `wf2-allocate-daily.yaml` | **Allocator**: raw facts of a day + active `cost_mapping_rule`s → `allocated` facts per source fact × owner (categorized) + one rollup per application, per shared bucket and one `unallocated`, and one **`application_cost_daily`** row per application (total, by category, by cloud service, the resources behind it, the Kubernetes part). Σ allocated = Σ cloud services, always. |
| `wf-suggest-mappings.yaml` | **Inference**: unallocated leaves × evidence (null services by host, application parameters) → `cost_mapping_suggestion` rows (`proposed`) with evidence, confidence and the USD they would recover. |
| `wf-cost-fact-upsert.yaml` | Child: `PATCH /catalog/instances/<slug>/<id>?upsert=true` for one row (facts, rules, suggestions — `catalog_slug` input) |
| `specs/cost_daily.spec.json` | Catalog spec (62 fields): subject, null dimensions, cloud dimensions, amortized `cost_usd` + `unblended_usd`, capacity/rates, evidence (`tags`, `host`), allocation provenance (`rule_id`, `share`, `source_fact_id`, `category`), rollups. Logical id `<stage>-<subject_type>-<slug>-<date>`; `day` = filterable copy of `date`. |
| `specs/application_cost_daily.spec.json` | The per-application daily **invoice**: `<application_id>-<day>` with `date`, `total_usd`, flat `charge_items[]` (each line says how it was charged — `charge_type` `scope` (any scope type, with `scope_id`), `service` (`service_id`) or `application` (by tag/rule, no null object) — plus category, cloud service, USD, share and the rule that attributed it), `totals` by charge type / category / cloud service, and `consumption` (Kubernetes usage vs request per scope). |
| `specs/cost_mapping_rule.spec.json`, `specs/cost_mapping_suggestion.spec.json` | The rules as data (see [docs/mapping-rules-design.md](./docs/mapping-rules-design.md)) and what the inference proposes. |
| `setup/01-catalog-spec.sh` | Creates/updates the three specs (session bearer; the admin grant is rewritten to the token's user) |
| `setup/02-aws-worker-identity.sh` | Worker pod identity for clusters without IaC (Pod Identity role + SA + the agent rule) |
| `setup/03-mapping-rules.sh` | Upserts a rules JSON (e.g. `setup/rules.nullplatform.json`) into `cost_mapping_rule` |
| `setup/publish.ts`, `setup/vars.<org>.json` | Publishes the seven workflows to an engine (platform or local) in dependency order with per-org variable values |
| `docs/iam/` | Read-only policy + trust documents for the worker role (IRSA, Pod Identity, cross-account) |
| `__tests__/` | 16 E2E tests on the local executor, plugins stubbed at the plugin level |

CI note: `npm run validate` skips `finops/tool-cloud-query.yaml` — the published `@nullplatform/workflow-kit` (0.1.0) predates the `np-package-call` plugin and reports it as unregistered; the file is covered by the E2E tests and validated by the engine on publish. Remove the exclusion when the kit is re-released from the current engine.

State (2026-09-11): LIVE in nullplatform's organization (org 4): daily loop published with alias `live`, rules seeded from `setup/rules.nullplatform.json`, 2026-09-09 collected (384 USD amortized). Engine plugin `np-package-call` is deployed (workflow-system 0.0.125).

## Local loop

1. **Engine** (from the engine worktree that has the plugin):
   ```bash
   cd ~/workspace/null/workflow-system-demo/.worktrees/np-package-call
   WORKFLOW_SECRET_GLOBAL_NP_API_KEY=$NP_API_KEY WORKFLOW_INTER_SERVICE_SECRET=<32+ chars> PORT=3210 \
     pnpm tsx scripts/dev-server.ts
   ```
2. **Agent** (docker backend on the laptop; AWS creds only for dev):
   ```bash
   cd finops/packages/cloud-query
   export NP_API_KEY=... NP_WORKER_AWS_ACCESS_KEY_ID=... NP_WORKER_AWS_SECRET_ACCESS_KEY=...
   mise run run          # tags package:cloud-query,local:$USER,env:local; callback allow-list includes host.docker.internal
   ```
3. **Publish** the tool on the local engine. `npx np-workflow publish` refuses
   (its plugin catalog is the published engine), so normalize with the engine's
   own DSL and POST it (verified 2026-09-10; the `publish.ts` snippet lives
   in the phase-0 plan, Task 8): `POST /workflows/definitions` with the parsed
   YAML, then `POST /workflows/definitions/:id/aliases {name: live, revision}` and
   `POST .../aliases/live/activate`. Note: the engine's `PORT` must not collide
   with a docker-published port (k3d publishes 3000 on this laptop → use 3210).
4. **Run** with the callback pointed at the laptop — as an INPUT, not a
   variable override (`variables` in the execute body are ignored):
   ```bash
   curl -s -X POST http://127.0.0.1:3210/workflows/definitions/$WF/execute -H 'Content-Type: application/json' -d '{
     "inputs": { "agent_tags": {"package":"cloud-query","local":"'$USER'"},
                 "callback_base_url": "http://host.docker.internal:3210",
                 "calls": [ {"id":"who","service":"sts","operation":"GetCallerIdentity"},
                            {"id":"by_service","service":"ce","operation":"GetCostAndUsage",
                             "params":{"TimePeriod":{"Start":"2026-09-08","End":"2026-09-09"},"Granularity":"DAILY","Metrics":["UnblendedCost"],"GroupBy":[{"Type":"DIMENSION","Key":"SERVICE"}]}} ] } }'
   ```
   Verified outcomes (2026-09-10, kwik-e-mart): async run `completed` in 4 s with
   the callback received by the engine and exactly one delivery on the agent;
   sync `who` in 4 s; an oversized 60-day call `failed` with
   `NP_PACKAGE_CALL_CALLS_FAILED` (`RESULT_TOO_LARGE`, 1.5 MB vs 300 KB cap)
   delivered through the callback, again with a single delivery — no re-delivery
   storm.

## Configuration: how cost becomes an owner

Nothing about a customer's resources lives in code. Three layers, per organization:

1. **Evidence the collector records on every raw fact** — `tags`, `host`, `cluster`, `component`,
   `resource_type`, `usage_type`, the null dimensions wf1 could derive (`application_id`,
   `scope_id`, `service_id` from null tags and null service hosts).
2. **Rules** (`cost_mapping_rule` rows, edited via API/UI, versioned): evaluated by the allocator
   per raw fact, ascending `priority`, first match wins. Shape:

   ```json
   {
     "id": "rds-approvals-shared-by-consumers",
     "enabled": true, "status": "active", "priority": 100, "source": "inferred", "confidence": 0.6,
     "scope": { "cloud_service": "Amazon Relational Database Service", "resource_type": "rds:cluster" },
     "match": [{ "field": "host", "equals": "postgres-approvals-api-db.cluster-xyz.us-east-1.rds.amazonaws.com" }],
     "method": "split",
     "target": { "split": [
       { "weight": 1, "target": { "application_id": "1234", "application_slug": "entities-api" } },
       { "weight": 1, "target": { "application_id": "5678", "application_slug": "users-api" } }
     ]},
     "evidence": [{ "kind": "parameter", "detail": "catalog.entities-api parameter DB_HOST references …" }]
   }
   ```

   - `scope`: field → value, list, or `{regex}` on the raw fact (cheap pre-filter).
   - `match`: predicates, all must hold: `{field, equals | in | regex | exists}`; `field` is a dotted
     path (`tags.application_id`, `host`, `subject_name`, `resource_id`, `usage_type`, `component`).
     Regex named groups become `$captures`.
   - `target`: a literal owner (`application_id`, `scope_id`, `service_id`, `namespace_id`, `cluster`,
     `bucket`), or `capture` (take the owner from the fact / a regex group), or `split` (weights), or
     `map` (`key` → owner table). `method`: `direct | split | map | by_metric`.
   - `by_metric`: the collector attaches a consumption metric to the fact (`metric: pi.db.load`,
     `metric_shares: {database → share}` — Performance Insights DB load by database on the cluster
     writer, one call per RDS subject per day); the rule's `map.entries` say which application owns
     each key; keys without an owner stay visibly unallocated (`metric_key` on the row). Example, the
     shared approvals Aurora (15 databases):

     ```json
     { "id": "rds-approvals-by-database-load", "priority": 90, "method": "by_metric",
       "scope": { "cloud_service": "Amazon Relational Database Service", "resource_type": "rds:cluster" },
       "match": [{ "field": "host", "equals": "postgres-approvals-api-db.cluster-….rds.amazonaws.com" }, { "field": "metric", "equals": "pi.db.load" }],
       "target": { "map": { "key": "db.name", "entries": {
         "core_entities_api": { "application_id": "1182532716" }, "tracing_api_production": { "application_id": "518811741" },
         "notifications": { "application_id": "1593752815" }, "approvals": { "application_id": "1372325109" }, "…": "…" } } } }
     ```
     Keep an equal-`split` rule with lower priority as the fallback for days without PI data.
   - `category` overrides the cost category derived from the cloud service.

   Three defaults ship with the allocator, lowest priority: `default:null-service` (fact carries
   `service_id` + `application_id`), `default:null-dims` (fact carries `application_id`/`scope_id`
   from null tags), `default:cluster` (cluster components → the cluster, split by consumption in
   phase 3).

   More examples:

   ```json
   { "id": "security-compliance-platform", "priority": 10,
     "scope": { "cloud_service": { "regex": "GuardDuty|Security Hub|Inspector|AWS Config|WAF" } },
     "target": { "bucket": "shared-platform" }, "category": "security" }
   ```
   ```json
   { "id": "log-groups-by-name", "priority": 30, "scope": { "resource_type": "logs:log-group" },
     "match": [{ "field": "subject_name", "regex": "^(?<ns>[a-z0-9-]+)\\.(?<app>[a-z0-9-]+)$" }],
     "target": { "capture": { "application_slug": "$app" } } }
   ```
   ```json
   { "id": "ids-in-tags", "priority": 900,
     "match": [{ "field": "tags.application_id", "regex": "^[0-9]+$" }],
     "target": { "capture": { "application_id": "tags.application_id", "scope_id": "tags.scope_id", "namespace_id": "tags.namespace_id" } } }
   ```

3. **Suggestions** (`cost_mapping_suggestion`, `status: proposed`): after each allocation, the
   inference workflow looks at what stayed unallocated and proposes rules with evidence — a null
   service whose host matches (confidence 0.95), applications whose parameters reference the host
   (0.7 for one consumer, 0.6 for several → an equal split to refine with a metric). Accepting one is
   copying its `rule` into `cost_mapping_rule` with `status: active` (`setup/03-mapping-rules.sh`
   does it from a JSON).

What the allocator writes (`stage: allocated`, all in `cost_daily`):

| Row | id | Meaning |
|---|---|---|
| leaf allocation | `alloc-<raw id>-<owner>` | one per source fact × owner: `cost_usd`, `share`, `rule_id`, `category`, `application_id`/`scope_id`/`service_id`/`cluster`/`bucket`, `source_fact_id` |
| application rollup | `alloc-app-<application_id>-<day>` | `cost_usd`, `by_category`, `by_cloud_service`, `quantity` = facts |
| shared bucket rollup | `alloc-bucket-<name>-<day>` | e.g. `shared-platform` |
| kubernetes | `alloc-bucket-<cluster>-<component>-<day>-app-<id>` | a cluster component split by the scope's consumption share (`default:cluster-consumption`, category `kubernetes`, `scope_id` on the row) |
| kubernetes overhead | `alloc-bucket-<cluster>-<component>-<day>-cluster-<cluster>` | the share no scope covers (system namespaces, idle headroom) |
| unallocated | `alloc-unallocated-<day>` | `by_cloud_service` = the gap to close with rules |

**The per-application entity** (an invoice): `GET /catalog/instances/application_cost_daily/<application_id>-<day>`
(or list `?application_id=<id>` / `?day=<day>`):

```json
{ "id": "2044993572-2026-09-09", "date": "2026-09-09", "application_id": "2044993572", "application_slug": "entities-api",
  "total_usd": 9.1, "currency": "USD",
  "charge_items": [
    { "charge_type": "service", "service_id": "38879e91-…", "service_name": "oltp-database", "category": "database", "cloud_service": "Amazon Relational Database Service", "subject_id": "oltp-database", "cost_usd": 3.59, "share": 1, "allocation_method": "direct", "rule_id": "default:null-service" },
    { "charge_type": "scope", "scope_id": "596334143", "scope_name": "production", "scope_type": "web_pool_k8s", "category": "kubernetes", "cloud_service": "Amazon Elastic Compute Cloud - Compute", "subject_id": "runtime|nodes", "component": "nodes", "cost_usd": 2.1, "share": 0.013, "allocation_method": "by_metric", "rule_id": "default:cluster-consumption" },
    { "charge_type": "application", "category": "database", "subject_id": "postgres-approvals-api-db", "cost_usd": 1.99, "share": 0.06, "allocation_method": "by_metric", "rule_id": "rds-approvals-by-database-load" }
  ],
  "totals": { "by_charge_type": { "scope": 3.52, "service": 3.59, "application": 1.99 }, "by_category": { "database": 5.58, "kubernetes": 3.52 }, "by_cloud_service": { "…": "…" } },
  "consumption": { "596334143": { "core_h_chargeable": 96, "core_h_used": 22, "gb_h_chargeable": 380, "gb_h_used": 190, "usage_usd": 1.2, "waste_usd": 2.3 }, "total": { "…": "…", "scopes": 1 } } }
```

`charge_type` says through which null object the line was charged: a scope (any type — k8s, lambda,
custom/EC2 — always with its `scope_id`), a service, or the application itself (a queue, a bucket, a
shared database's share attributed by tag or rule without a null object).

Other queries: `GET /catalog/instances/cost_daily?stage=allocated&application_id=<id>` (allocated
facts of one app), `…&stage=allocated&subject_type=unallocated` (the gap),
`…&stage=raw&subject_type=cluster` (cluster rows with rates, shares and overhead).

**Kubernetes**: the cluster's cost (nodes, control plane, LBs, networking, storage) is split by each
scope's consumption share = its chargeable cost (`max(usage, request)` per hour × blended rates)
over the cluster cost. What no scope covers stays with the cluster as `kubernetes_overhead`. The
scope rows (`raw-k8s-scope-*`, `source: k8s`) keep usage vs request, so waste per scope is visible.

### Step chain and the 1 MB step output

`wf2` runs `prep → read_raw + read_rules + scopes + services → allocate → (gate → write_facts) +
(invoices → invoice_gate → write_invoices) → summary`. The code sandbox caps a step's output at
1 MB, so the allocated facts leave `allocate` exactly once (the gates only decide whether the
fan-outs write, for `dry_run`) and the invoices are built in their own step from those facts.
For nullplatform the outputs are ~850 KB (752 facts) and ~450 KB (48 invoices): a customer with
several hundred scopes will need `allocate` to write in chunks instead of returning the facts.
The summary reports `cluster_pending_usd` (clusters without consumption shares yet) separately
from `kubernetes_overhead_usd` (what no scope covered once the shares exist).

## Deploying to an organization (done for nullplatform, org 4, 2026-09-11)

Everything is per organization; nothing is registered on the platform as a package.

1. **Worker identity** (once per cluster). The controlplane-agent spawns the collector as
   a pod in its worker namespace; without an identity of its own the pod runs as the NODE
   role. Give it a read-only role + ServiceAccount + an agent rule:
   - IaC (nullplatform's own runtime): `iac-null-runtime` `iam/roles.tf` `k8s_np_finops_worker`
     (IRSA) + `k8s/np_finops_worker.tf` (SA `np-workers/np-finops-worker`).
   - Any other cluster: `setup/02-aws-worker-identity.sh --cluster <name>` (Pod Identity)
     or `docs/iam/` by hand.
   - Agent: `NP_ALLOWED_REGISTRIES` must include `public.ecr.aws/nullplatform/*` and
     `NP_WORKER_RULES` must map the image to the SA:
     `[{"match":{"registry":"public.ecr.aws/nullplatform/agent-plugins/workflows/aws-cost-explorer","package":"cloud-query"},"serviceAccount":"np-finops-worker"}]`
     (restart the agent). Verify with a sync `sts GetCallerIdentity` through the tool.
2. **Catalog specs**: `NP_TOKEN=<session bearer> setup/01-catalog-spec.sh` creates/updates
   `cost_daily`, `cost_mapping_rule`, `cost_mapping_suggestion` (the admin grant is rewritten to the
   token's user). Create the specs BEFORE the first collection: the catalog silently drops
   attributes the spec does not declare.
3. **Secret**: `POST /workflows/config {"name":"NP_API_KEY","value":…,"secret":true,"path":"/finops"}`
   with a session bearer (an org API key with catalog + agent_command grants).
4. **Per-org values**: copy `setup/vars.nullplatform.json` — agent tags + `agent_nrn`
   (REQUIRED when the agent is registered under an account: the control plane does not
   find account-level agents from the organization root), `org_nrn`, dispatcher targets.
5. **Publish** (from the engine repo, so the DSL parser resolves):
   `NP_TOKEN=<bearer> pnpm tsx finops/setup/publish.ts finops --base https://api.nullplatform.com --vars finops/setup/vars.<org>.json`
   and later `--update <file>=<id>,…` for new revisions — **always with all seven ids**: a
   partial list would publish the omitted files as NEW definitions (with a live cron on the
   dispatcher copy); the script refuses that unless `--allow-create` is passed. The dispatcher
   (`wf0`) owns the schedule (04:15 UTC): collect → k8s consumption (`k8s_clusters` in the vars) →
   allocate → suggest. `wf1`/`wf2`/`wf3` have no cron of their own.
6. **Rules**: start from `setup/rules.<org>.json` (copy the nullplatform one) and load it with
   `setup/03-mapping-rules.sh`; everything else comes from the suggestions.
7. **First run**: execute `wf0` with `{"date":"YYYY-MM-DD","dry_run":true}`, read the
   child summaries (collection, allocation, suggestions), then run it for real. Rows: `GET /catalog/instances/cost_daily?stage=raw&subject_type=cluster`
   (the `date` query filter is ignored by the catalog list API today — filter on other
   fields or query the lake).

### What nullplatform's first day looked like (2026-09-09, account 283477532906)

275 rows: 38 `cloud_service`, 222 `bucket` (usage types + cluster components + one
`ec2-instances-unattributed`), 9 `scope`, 7 `service` (RDS clusters, 2 mapped to null
services by host), 1 `cluster`, 1 `resource`. Total 383.20 USD amortized.

Known gap: Karpenter nodes that terminated before collection are not in `DescribeInstances`,
so their cost (539 instance-days, 64.74 USD) lands in `ec2-instances-unattributed` instead
of the cluster's `nodes` component, and the blended rates come out high. Fix: activate
`aws:eks:cluster-name` as a cost allocation tag (Billing → Cost allocation tags; today only
`application`, `namespace`, `scope` are active) and group the EC2 resource query by that
tag — terminated instances keep their tags in Cost Explorer.
