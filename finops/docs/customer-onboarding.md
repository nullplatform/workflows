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
| Where do the agents run and with what identity? | `GET /agent` (needs `nrn` — account-level agents are invisible from the org root), the agent's `NP_WORKER_RULES` / `NP_ALLOWED_REGISTRIES` | the worker pod needs a read-only cloud role (see §2) |
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
the node role.

Since agents-api #228/#230 and engine #182 the image travels as `command.data.package =
{slug, image}`; the platform lowers it into the worker's `oci_image` artifact, so no package
registration is needed. Without `image` the organization's registered package runs.

## 3. Catalog specs

`setup/01-catalog-spec.sh` creates or patches the four specs from `specs/*.spec.json`.

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

Copy `setup/vars.nullplatform.json` and set: `agent_tags` + `agent_nrn` (REQUIRED for account-level
agents), `org_nrn`, the dispatcher `targets` (one per account; `expected_account` guards a wrong
agent/role pairing), `k8s_clusters`, the cluster's Prometheus URL for `wf3` (`collector_cmd`).

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

## 6. Dashboard

The definition is generated by `setup/report-finops.py --spec-id <cost_daily spec uuid>` and persisted
with the np-report skill (`POST /report`, draft; publishing is a separate step). Rules that matter:
- base query = latest run per day over `catalog_entities` (see §3), `argMax(data,_version)`
  instead of `FINAL` over the whole table (6–8 s → ~1 s);
- filter `params` keys MUST equal the schema property names or the frontend never re-runs the
  query on change;
- an area chart with one day renders nothing → stacked bars;
- KPIs: total = applications + shared platform buckets + Kubernetes overhead + unallocated.

## 7. Operations

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
