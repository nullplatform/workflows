# Bringing the FinOps suite to a new organization — runbook

What we learned putting the suite on nullplatform's own org (2026-09-10/11). Follow it top to
bottom for a new customer; every step names the artifact in this folder that does the work and
the trap we hit the first time. The user-facing model (rules, invoice entity, dashboard) is in
`../README.md`; the mapping design in `mapping-rules-design.md`; the hands-on rule authoring in
`mapping-playbook.md`.

## 0. What you get at the end

- One `cost_daily` catalog entity per **raw** cost fact (cloud service, usage-type bucket, EC2
  instance/scope, EKS cluster + components, database, Lambda scope, Kubernetes scope consumption)
  and per **allocated** fact (raw fact × owner).
- One `application_cost_daily` **invoice** per application per day: flat `charge_items[]`
  (`charge_type` scope | service | application), dimensions, totals by charge type / environment /
  category / cloud service.
- `cost_mapping_rule` (what the customer decided) and `cost_mapping_suggestion` (what we inferred,
  for them to accept).
- A daily loop (`wf0`, cron 04:15 UTC): collect (`wf1`) → Kubernetes consumption (`wf3`) →
  allocate + invoices (`wf2`) → suggestions (`wf-suggest-mappings`).
- A Lake-backed dashboard ("FinOps — Costos por aplicación") over `catalog_entities`.

## 1. Discovery (half a day, no writes)

Answer these before touching anything; each one changes the configuration.

| Question | Where to look | Why it matters |
|---|---|---|
| Which AWS accounts pay for what? | `sts GetCallerIdentity` through the agent, Cost Explorer `GetCostAndUsage` by `LINKED_ACCOUNT` | one `wf0` target per account × agent × role |
| Which **cost allocation tags** are active? | CE `GetTags` (or Billing console) | CE can only group by ACTIVE tags. nullplatform had `application`, `namespace`, `scope` (slugs) but not `scope_id`/`application_id`; the ids come from the resources' own tags (tagging API) instead |
| Do resources carry the null tags? | `tagging GetResources` per type (`lambda:function`, `rds:cluster`, `elasticloadbalancing:loadbalancer`…) | EC2 instances and Lambda functions created by null carry `application_id`, `scope_id`, `namespace_id`, `application`, `scope`, `namespace`; databases carry `application` at most |
| Is there an EKS cluster? Karpenter? | `ec2 DescribeInstances` + tags `eks:cluster-name` / `kubernetes.io/cluster/<name>`; CE `GetCostAndUsageWithResources` grouped by `RESOURCE_ID, INSTANCE_TYPE` | nodes that terminated before collection only exist in CE-with-resources; the instance TYPE tells which cluster they belonged to (`inferCluster`) |
| Which shared databases hold many logical databases? | `rds DescribeDBClusters` + Performance Insights `GetResourceMetrics` (`db.load.avg` by `db`) | shared clusters are split by database load (`by_metric`), never mapped to one app |
| Who consumes each shared database? | application **parameters** (`GET /parameter?nrn=<app>`): hosts / CNAMEs (`*.db.nullservices.io`), `DB_NAME`-like values | seeds the `by_metric` map (database name → application) |
| Which null services exist and what is their host? | `GET /service?nrn=<org>&show_descendants=true` | RDS/ElastiCache/OpenSearch whose endpoint equals a service host are `service_owner` automatically |
| Which null account maps to which AWS account? | `GET /runtime_configuration?nrn=<account nrn>` then `GET /runtime_configuration/<id>` → `values.aws.account_id` + `region` (one config per dimension; the org-level one is the default) | one `wf0` target per (null account, AWS account); `expected_account` guards the pairing. itti: 49 null accounts, ~2 AWS accounts each (us-east-1 + sa-east-1) |
| Where do the agents run, which VERSION, with what identity? | `GET /controlplane/agent?nrn=<org or account nrn>&limit=100&offset=…` (paginate; account-level agents are invisible from the org root), field `version`; the agent's `NP_WORKER_RULES` / `NP_ALLOWED_REGISTRIES` | **`package-exec` needs controlplane-agent ≥ 0.9.0 (use 0.11.1, what null runs).** An older agent answers `ping` but never emits `started` for `package-exec`, so the API returns `Command failed to start after all retry attempts` (10 s × 3 attempts, agentId `unknown`) — that error means "old agent", not "bad request". itti's 107 agents were 0.4.1–0.8.0; the worker pod needs a read-only cloud role (see §2) |
| Is Cost Explorer **resource-level** data enabled? | `GetCostAndUsageWithResources` grouped by `RESOURCE_ID`: rows come back as `NoResourceId` when the payer never opted in | without it EC2 has no per-instance rows; `wf1` prices the cluster from the `INSTANCE_TYPE` rows instead (running nodes → cluster by type, or the account's sole cluster). Spot fleets churn types all day, so the type list comes from CE, not from what is running now |
| Where do the pod metrics come from? | Prometheus reachable from the agent (`collector_mode: agent`, null) or New Relic's Kubernetes integration (`collector_mode: newrelic`: `K8sContainerSample` carries `label.scope_id`; config entries `NR_USER_KEY`, `NR_ACCOUNT_ID` at `/finops`) | `wf3` splits the cluster among scopes with max(usage, request) per hour either way; itti/tuti has no Prometheus but reports to NR account 6332316 |
| Which databases do the applications use? | application parameters (`DB_HOST`/`DB_NAME`, `DBM_HOST`, `REDIS_HOST`) + Performance Insights `db.load` by database (`ServiceType` DOCDB for DocumentDB) | itti: `DB_NAME` = the PI database name → exact `by_metric` map; DocumentDB names follow `<app>db`; ElastiCache consumers → equal `split` |
| How is CloudWatch spent? | CE by `USAGE_TYPE`/`OPERATION` for `AmazonCloudWatch` | itti: 67% metric stream, 25% EMF custom metrics from `<ns>.<app>.http_agg`/`.sys_agg` log groups, 4% logs → by log group / by app (see README) |
| Amortized or unblended? | Cost Explorer both metrics | we attribute **amortized** (Savings Plans / RIs spread over covered usage); the console defaults to unblended, so the daily total looks ~25% lower there. Both are stored (`cost_usd`, `unblended_usd`) |

Do the discovery calls through the agent with the cloud-query package
(`tool-cloud-query.yaml`, `mode: sync` for one-off probes). Never with local cloud credentials:
customers will not hand us any.

## 2. Worker identity (IaC) and the agent rule

`setup/02-aws-worker-identity.sh` (or the Terraform in `docs/iam/`) creates:

1. An IAM role for the worker pod (`k8s-np-finops-worker` in nullplatform) with the read-only
   policy in `docs/iam/` (Cost Explorer, EC2/RDS/ELB describes, tagging, Performance Insights,
   CloudWatch Logs metadata, service listings) — EKS Pod Identity or IRSA.
2. A Kubernetes ServiceAccount in the agent's worker namespace (`np-workers`) bound to that role.
3. The agent rule so exactly OUR image gets that ServiceAccount:
   ```json
   [{"match":{"registry":"public.ecr.aws/nullplatform/agent-plugins/workflows/aws-cost-explorer","package":"cloud-query"},"serviceAccount":"np-finops-worker"}]
   ```
   (`NP_WORKER_RULES`, base64 in the agent secret; the registry must also be in
   `NP_ALLOWED_REGISTRIES`). The rule compares the image WITHOUT digest, so pin the digest on our
   side (`tool-cloud-query.yaml` variable `image`) — a tag can be re-pointed by anyone who can push.

Verify with a sync `sts GetCallerIdentity` through the tool: the ARN must be the worker role, not
the node role. Before the workflows exist in the org, the same probe as a curl (session or API-key
bearer of THAT org; read-only, ~200 ms on a working agent):

```bash
curl -s -X POST https://api.nullplatform.com/controlplane/agent_command \
  -H "Authorization: Bearer $NP_TOKEN" -H 'Content-Type: application/json' -d '{
  "selector": {"stage": "sdlc"}, "nrn": "organization=<org>:account=<account>",
  "execution_config": {"retry": {"max_attempts": 1}},
  "command": {"type": "package-exec", "data": {
    "package": {"slug": "cloud-query", "image": "public.ecr.aws/nullplatform/agent-plugins/workflows/aws-cost-explorer@sha256:<digest>"},
    "environment": {"NP_ACTION_CONTEXT": "{\"cloud_query\":{\"provider\":\"aws\",\"region\":\"us-east-1\",\"calls\":[{\"id\":\"who\",\"service\":\"sts\",\"operation\":\"GetCallerIdentity\",\"params\":{}}]}}"}}}}'
```

`executions[0].results.stdOut` is the worker's JSON (`calls[0].result.Arn`). Operation names are the
SDK's PascalCase (`GetCallerIdentity`); a wrong name returns an empty stdout, not an error.

Since agents-api #228/#230 and engine #182 the image travels as `command.data.package =
{slug, image}`; the platform lowers it into the worker's `oci_image` artifact, so no package
registration is needed. Without `image` the organization's registered package runs.

## 3. Catalog specs

`setup/01-catalog-spec.sh` creates or patches the five specs from `specs/*.spec.json` (`cost_daily`, `scope_usage_daily`, the two mapping specs, `application_cost_daily`).

Traps that cost us hours:
- **Undeclared attributes are dropped silently.** Patch the spec BEFORE writing a new field
  (`charge_type` went missing for a whole afternoon).
- **List filters only work on fields indexed when the spec was CREATED** (`stage`, `subject_type`,
  `cloud_service`, `cluster`); `day` came later and `date` is ignored → the workflows read
  `stage=raw|allocated` and filter the day in code.
- **Grants**: the workflows write with the organization's API key, which is not the spec's owner.
  `schema.authorization.entities.grants` must give `read,list,create,write,delete` to `*` (or to
  the key's principal) on every spec — the script rewrites the placeholder admin `732189543` to the
  token's user; the 403 on `application_cost_daily` was exactly this.
- The spec files keep the placeholder principal `732189543`; the script rewrites EVERY `type: user`
  grant to the token's user (a foreign user id → 400 `authorization references unknown user_id`).
  Never commit an org-specific user id into `specs/*.spec.json`.
- Enums (`source`, `allocation_method`, `subject_type`, `charge_type`) must contain every value a
  workflow emits; the spec description is capped at 255 chars.
- **DELETEs never reach the Lake**: `catalog_entities` keeps deleted instances with `_deleted=0`.
  Any Lake query over re-written entities keeps only the latest run
  (`QUALIFY collected_at = max(collected_at) OVER (PARTITION BY day)`).

## 4. Publish the workflows

From the engine repo (the DSL parser is imported from there):

```bash
NP_TOKEN=<bearer> pnpm tsx finops/setup/publish.ts finops \
  --base https://api.nullplatform.com --vars finops/setup/vars.<org>.json
```

Copy `setup/vars.nullplatform.json` (or `vars.itti.json` for a New Relic / single-dimension account) and set: `agent_tags` + `agent_nrn` (REQUIRED for account-level
agents), `org_nrn`, the dispatcher `targets` (one per account; `expected_account` guards a wrong
agent/role pairing; `dimensions` = the null dimension the whole AWS account maps to, e.g.
`{environment: development}`, stamped on every fact without a scope/service of its own),
`k8s_clusters`, and for `wf3` either the cluster's Prometheus URL (`collector_cmd`, `collector_mode:
agent`) or `collector_mode: newrelic` + config entries `NR_USER_KEY` / `NR_ACCOUNT_ID` at `/finops`
(`org_nrn` of `wf3` = the subtree whose scopes the cluster serves).

The workflows read `${{ secrets.NP_API_KEY }}`: a config entry named `NP_API_KEY` must exist at
`/finops` or be inherited from `/` (`GET /workflows/config?path=/finops`). If the agent is not ready
yet, publish anyway and turn the daily cron off until it is
(`POST /workflows/definitions/<wf0 id>/aliases/live/deactivate`; `…/activate` later) — otherwise
`wf0` fails every morning at 04:15 UTC.

For new revisions ALWAYS pass all seven ids (`--update file=id,…`); a partial list creates NEW
definitions with a live cron (the script refuses unless `--allow-create`). Save the printed ids.

## 5. First day, dry then real

1. `wf0` with `{"date":"YYYY-MM-DD","dry_run":true}`: read `summary` (daily total must match Cost
   Explorer amortized for the day), `unallocated_leaves` (what needs rules).
2. Real run for one day; check the catalog: raw rows = one collection (`collected_at` groups),
   allocated rows = `summary.written`, invoices = number of applications.
3. Load the seed rules (`setup/03-mapping-rules.sh setup/rules.<org>.json`, needs a session
   bearer for rows created by a user) — start from `rules.nullplatform.json`:
   security/compliance services → `shared-platform` bucket, CloudWatch remainder → platform,
   shared databases → `by_metric` with the database→application map from the parameters.
4. Re-allocate the day (`wf2` alone, ~5 min); the stale sweep removes the previous allocation.
5. Read the suggestions (`cost_mapping_suggestion`, status `proposed`) with the customer; accept =
   copy into a rule with `status: active`.
6. Activate the cron (already `live` after publish) and backfill: run `wf0` per past day (Cost
   Explorer with resources covers the last 14 days).

### 5.1 How to run a day today (engine caveat, 2026-09-11)

`wf0 → wf2` as one chain wedges on itti: the dispatcher does not always see the allocator child
finish, and after ~6 minutes the sub-workflow step is retried and a SECOND allocator starts on the
same day (`<exec>:allocate:0:2`, then `:0:3`). Deterministic ids keep the data consistent, but three
allocators × 18 write batches saturate the worker. Until the engine fix lands, run a day as:

```bash
# 1) collection + Kubernetes only (no allocation in the dispatcher)
POST /workflows/definitions/<wf0>/execute   {"inputs": {"date": "YYYY-MM-DD", "allocate": false}}
# 2) allocation alone, when (1) is completed
POST /workflows/definitions/<wf2>/execute   {"inputs": {"date": "YYYY-MM-DD"}}
```

The daily schedule follows the same split: `wf0` at 04:15 UTC collects + Kubernetes (`allocate_in_chain:
false` in the org's vars), `wf2`'s own cron allocates yesterday at 05:00 UTC. Suggestions are not
produced by the daily runs while `allocate_in_chain` is false (run `wf-suggest-mappings` by hand).

`setup/backfill.sh <wf0 id> <wf2 id> <day>…` does exactly that, one day at a time (never run days in
parallel: the agent serialises package runs and the worker is shared), re-minting the API-key token
per day (tokens live 60 minutes, backfills do not).

Verify a day from the Lake (what the dashboard will show), never from the execution outputs alone:

```sql
WITH f AS (SELECT JSONExtractString(data,'day') day, JSONExtractString(data,'application_id') appid,
  JSONExtractString(data,'allocation_method') method, JSONExtractString(data,'collected_at') run,
  JSONExtractFloat(data,'cost_usd') usd FROM (SELECT id, argMax(data,_version) data FROM catalog_entities
  WHERE entity_specification_id = '<cost_daily spec>' GROUP BY id HAVING argMax(_deleted,_version) = 0)
  WHERE JSONExtractString(data,'stage') = 'allocated' AND JSONExtractString(data,'allocation_method') != 'rollup'
  AND JSONExtractString(data,'subject_type') != 'unallocated' QUALIFY run = max(run) OVER (PARTITION BY day))
SELECT day, count() rows, round(sum(usd),2) total, round(sumIf(usd, appid != ''),2) apps,
  round(sumIf(usd, method = 'unallocated'),2) unalloc FROM f GROUP BY day ORDER BY day
```

`total` must equal Cost Explorer (amortized) for the day; `apps / total` is the attribution.

**Deleting bad data**: `DELETE /catalog/instances/<slug>/<id>` cleans the catalog only — the Lake keeps
the rows (`_deleted` never flips). The dashboard hides them because it keeps the latest run per day,
so the cure for a bad day is a good re-run of that day, not a delete. Delete first, then the
dashboard shows nothing for that day until the re-run lands.

## 6. Dashboard

The definition is generated by `setup/report-finops.py --spec-id <cost_daily spec uuid>` and persisted
with the np-report skill (`POST /report`, draft; publishing is a separate step). Rules that matter:
- base query = latest run per day over `catalog_entities` (see §3), `argMax(data,_version)`
  instead of `FINAL` over the whole table (6–8 s → ~1 s);
- filter `params` keys MUST equal the schema property names or the frontend never re-runs the
  query on change;
- an area chart with one day renders nothing → stacked bars;
- KPIs: total = applications + shared platform buckets + Kubernetes overhead + unallocated.
- `report-finops.py --spec-id … --usage-spec-id … [--top 8]` needs `NP_TOKEN` to read the top-N values
  per grouping (the explorer's stacked charts have fixed series); regenerate after a backfill.
- A `visibility: user` report belongs to the user who created it: `PATCH /report/<id>` with the org's
  API key is a 403 — use that user's session token. Publishing is a separate explicit step.
- Frontend quirks that cost an hour each: JSON Forms `rule` (SHOW/HIDE) is ignored; `Categorization`
  tabs render the hidden charts with zero width; a nested query target is never written; stacked bars
  with many series + `borderRadius` draw as 1px outlines (no radius, explicit `colors`).
- It can be created before the first collection: every query must still run with empty params
  (KPIs return one row of 0/NULL, arrays return nothing) — verify with `ch_query.sh` as in the
  np-report skill, then `POST /report` with the customer's session bearer.

## 7. Operations

### Symptoms → cause (all seen on 2026-09-11)

| Symptom | Cause | Fix |
|---|---|---|
| `Command failed to start after all retry attempts` (agentId `unknown`) | agent < 0.9.0 has no `package-exec` | upgrade the agent (0.11.1) |
| `agent_command HTTP 403` in `call_package` | the API key's role lacks `agent:run_command` on the account NRN | key with `ops` (or grant it), config entry `NP_API_KEY` at `/finops` |
| `Lake query failed … only one statement per request` | a `;` inside an SQL comment | no comments in Lake SQL |
| `The specified ServiceType is invalid for engine chimera` | Performance Insights on DocumentDB | `ServiceType: DOCDB` |
| `NerdGraph HTTP undefined` | http-request outputs `statusCode`, not `status` | read `statusCode` |
| `STEP_INPUT_TOO_LARGE … 2362076 bytes` on `allocate` | the catalog list has NO day filter: every day's raw facts came back | `read_raw` reads the day from the Lake |
| `input exceeds sandbox boundary limit of 1048576` on `summary` | batches passed as a code-exec input | batches only reach outputs on dry runs |
| parent stuck on a completed child, `:allocate:0:2` appears | engine: sub-workflow completion missed, step retried at ~6 min | run wf2 alone (§5.1) |
| `Workflow history size exceeds limit` on `suggest` | suggestions fan-out per application (26 apps) | pending (`wf-suggest-mappings`) |
| dashboard shows a day you deleted | Lake keeps deleted rows | re-run the day |


- Every daily run is idempotent per day: ids are deterministic (`raw-<type>-<id>-<day>`,
  `alloc-<raw id>-<owner>[-<metric key>]`, `<app>-<day>`), writes are upserts, and each workflow
  deletes the day's rows it did not produce (its own `source` only).
- Sizes: the code sandbox caps a step output at 1 MB; the parent workflow's Temporal history must
  stay small — batches of 40 facts per child, `output_projection` on read steps, never a
  per-row fan-out (752 children re-ran in a loop once the history passed ~14 MB).
- Command completions > ~400 KB are dropped by the platform: the worker returns a receipt and the
  engine reads the result through the callback (`callback_allowed_hosts`).
- Performance Insights needs `Date` objects: the worker coerces ISO strings under `*Time` keys.
- The old per-pod cost tracker (metadata `cost_tracking`) is superseded by `wf3` + the invoices.
