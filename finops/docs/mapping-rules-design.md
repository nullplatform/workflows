# Mapping rules: how cloud resources become null owners (design, 2026-09-11)

Status (2026-09-11): IMPLEMENTED for phase A — specs `cost_mapping_rule` /
`cost_mapping_suggestion`, allocator `wf2-allocate-daily.yaml` (scope/match/capture/split/map,
priority, defaults, reconciliation), inference `wf-suggest-mappings.yaml` (null services by host,
application parameters), daily loop in `wf0`. Not yet: `by_metric` (needs the consumption
collectors: Performance Insights by `db.name`, log-group `IncomingBytes`, k8s usage), naming-
convention inference, action items for unallocated cost. The README's "Configuration" section is
the user-facing version of this document.

## Problem

`wf1` maps cloud cost to null in code: EC2 instances by `scope_id` tag, RDS clusters by
host equality with a null service, nodes by EKS tags. That is fine for one account we
know; it does not scale to a customer with hundreds of resources, mixed naming, secrets
in parameters and databases shared by many services. The mapping has to be **data**,
authored per organization, with inference where evidence exists and human rules where it
does not — never resource-by-resource hardcoding.

## Model

Two catalog entities per organization.

### `cost_mapping_rule` — what the customer (or we) decide

| Field | Meaning |
|---|---|
| `id`, `name`, `enabled`, `priority` | rules are evaluated by ascending priority, first match wins |
| `scope` | what the rule looks at: `cloud`, `cloud_service` (CE service name), `resource_type` (`rds:cluster`, `sqs:queue`, `logs:log-group`, `lambda:function`, `ec2:instance`, `k8s:namespace`, `pg:database`, …) |
| `match` | list of predicates, all must hold: `tag:<key>` equals / matches regex, `name` regex, `arn` regex, `host` equals, `parameter` (an app parameter value equals the resource host/name), `k8s_label:<key>`, `usage_type` regex |
| `target` | where the cost goes: `{application_id}` / `{scope_id}` / `{service_id}` / `{namespace_id}` / `{cluster: <name>}` / `{bucket: "shared-platform"}` — or `capture`: take the target from the match itself (`application_id` from tag `application_id`, from regex group, from the parameter's application) |
| `method` | `direct` (100% to the target), `split` (several targets with weights), `by_metric` (proportional to a metric the collectors already store: PI `db.load` by `db.name`, log group `IncomingBytes`, k8s requests/usage, SQS `NumberOfMessagesSent`) |
| `source` | `inferred` \| `manual` \| `suggested`; `confidence` 0–1; `evidence` (what produced it) |
| `status` | `active` \| `proposed` \| `rejected` — proposed rules do nothing until approved |

Examples (nullplatform):

```yaml
- name: null tags → application            # generic, ships by default
  scope: {cloud: aws}
  match: [{tag: application_id, regex: "^[0-9]+$"}]
  target: {capture: {application_id: "tag:application_id", scope_id: "tag:scope_id"}}
  method: direct
- name: RDS cluster host = null service host   # generic, ships by default
  scope: {resource_type: "rds:cluster"}
  match: [{host: {equals: "null_service.attributes.host"}}]
  target: {capture: {service_id: "null_service.id"}}
- name: shared approvals Aurora by database load   # inferred from parameters, approved by a human
  scope: {resource_type: "rds:cluster", name: "postgres-approvals-api-db"}
  method: {by_metric: "pi.db.load", dimension: "db.name"}
  target: {map: {catalog_entities_api: {application_id: 1234}, core_entities_api: {application_id: 5678}, tracing_api_production: {application_id: 91011}}}
- name: log groups named <namespace>.<application>
  scope: {resource_type: "logs:log-group"}
  match: [{name: {regex: "^(?<namespace>[a-z0-9-]+)\\.(?<application>[a-z0-9-]+)$"}}]
  target: {capture: {namespace_slug: "$namespace", application_slug: "$application"}}
  method: {by_metric: "cloudwatch.IncomingBytes"}
- name: everything security/compliance is platform
  scope: {cloud_service: {regex: "GuardDuty|Security Hub|Config|Inspector|WAF"}}
  target: {bucket: shared-platform}
```

### `cost_mapping_suggestion` — what we infer, for a human to accept

Same shape as a rule plus `evidence[]`. Produced by an **inference workflow** that runs
after each collection and looks at what is still unallocated. Evidence sources, in order
of trust:

1. **null ids in tags** (`application_id`, `scope_id`, `namespace_id`, `deployment_id`) — exact, confidence 1.0. Cost Explorer can group by these directly once they are activated as cost allocation tags; today nullplatform has `application`, `namespace`, `scope` (names).
2. **null services** (`GET /service`): `attributes.host`/`hostname`/`endpoint` equals a cloud host — exact (RDS, ElastiCache, OpenSearch).
3. **application parameters** (`GET /parameter?nrn=<app>`): a value contains the cloud host / queue URL / bucket / table name → the app is a consumer. Database names come from `DB_NAME`-like parameters. Secrets are not readable (we only see that a secret parameter exists), and CNAMEs (`*.db.nullservices.io`) must be resolved to the RDS host. Confidence 0.8; many consumers → `split`/`by_metric` suggestion.
4. **naming conventions** learned per org: log groups `<ns>.<app>`, queues/topics/buckets containing an application slug, Lambda function names, k8s namespaces/labels. Confidence 0.6, always `proposed`.
5. **nothing** → stays in `unallocated` buckets, listed by cost so the customer sees what a rule would recover.

The suggestion workflow can also create an **action item** per unallocated cost above a
threshold ("$26/day of CloudWatch is unattributed; 81 log groups match `<ns>.<app>`; accept
rule X?"), which is the governance loop we already have.

## Where inference cannot go: shared resources

Shared clusters (RDS, Redis, OpenSearch, the EKS cluster itself) are never "mapped": they
are **split by a consumption metric**, and the rule only says which metric and how
consumers are keyed:

| Shared resource | Metric | Keyed by | Consumer → owner |
|---|---|---|---|
| EKS cluster | requests/usage × blended rates (phase 3) | k8s namespace + pod labels | null scope labels |
| RDS / Aurora cluster | Performance Insights `db.load` by `db.name` (compute), `pg_database_size` (storage), `pg_stat_database` blocks (I/O) | database name / db user | parameters → application (suggested), rule map |
| ElastiCache | CloudWatch `CurrConnections` per node, or client tags | client app | rule |
| CloudWatch | `IncomingBytes` per log group; vended logs by source | log group name | naming rule |
| NAT / VPC / LB | shared → cluster components (already) | | |

## Evaluation order in the allocator

1. Rules with `status=active`, ascending priority, first match per resource.
2. Default generic rules (null tags, null service host) as the lowest priority.
3. Anything left → `unallocated` bucket per cloud service, and a suggestion pass.

Rules are versioned catalog entities: the allocator records `rule_id` on every allocated
fact, so a rule change is auditable and a day can be re-allocated after a rule is fixed
without re-collecting billing.

## What changes in the code

- `wf1` stops mapping: it only produces `raw` facts with all the evidence fields (tags, host,
  name, ARN, cluster, usage type). The mapping moves to the allocator.
- New `wf2-allocate`: per day, reads raw facts + active rules, writes `allocated` facts.
- New `wf-suggest-mappings`: after allocation, evidence sources 2–4 → suggestions/action items.
- Spec additions: `cost_mapping_rule`, `cost_mapping_suggestion`; `rule_id` on `cost_daily`.
