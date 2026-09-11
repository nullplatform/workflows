# Playbook: analyze an AWS account and map its cost to nullplatform

How to repeat the kwik-e-mart analysis for any account (itti next), decide
service by service how each cost is attributed, and get the identifiers that
join cloud resources to null entities. Commands use an admin/read profile
locally; in production the same calls run inside the `cloud-query` package
with the pod's IAM role.

## 0. Prerequisites and the two questions to answer first

```bash
export AWS_PROFILE=<profile> AWS_DEFAULT_REGION=us-east-1
aws sts get-caller-identity
aws organizations describe-organization 2>/dev/null   # payer or linked?
aws cur describe-report-definitions; aws bcm-data-exports list-exports
aws ce list-cost-allocation-tags --status Active
```

| Question | If yes | If no |
|---|---|---|
| Is there a **CUR / Data Export**? | resource-level cost for every service (Athena) → add `athena`/`s3` to the runner and read per resource | Cost Explorer only: per resource for EC2 (14 days), per usage type for the rest |
| Are **cost allocation tags** active (`scope_id`, `application_id`)? | `GROUP BY TAG` attributes Lambda, API GW, ECR, Logs directly | prorate service totals by inventory + usage (CloudWatch), or ask the payer admin to activate them |

Always read **amortized** cost (`AmortizedCost`); check for Savings Plans /
RIs with `GROUP BY PURCHASE_TYPE`. Unblended is only kept for transparency.

## 1. Inventory (one pass, all services)

```bash
# every resource that was ever tagged, with its tags (paginated)
aws resourcegroupstaggingapi get-resources --resources-per-page 100
# never-tagged resources are NOT returned — list them per service:
aws s3api list-buckets; aws dynamodb list-tables; aws lambda list-functions
aws rds describe-db-clusters; aws rds describe-db-instances; aws elasticache describe-replication-groups
aws elbv2 describe-load-balancers; aws ec2 describe-nat-gateways; aws ec2 describe-volumes
```

Count per service: total, with null tags, with cluster tags. Note the tag
**conventions** (plain `scope_id` vs `nullplatform:scope-id`) — the collector
normalizes both.

## 2. Cost, three cuts for one day

```bash
D=2026-09-09; N=2026-09-10
aws ce get-cost-and-usage --time-period Start=$D,End=$N --granularity DAILY --metrics AmortizedCost UnblendedCost --group-by Type=DIMENSION,Key=SERVICE
aws ce get-cost-and-usage --time-period Start=$D,End=$N --granularity DAILY --metrics AmortizedCost UsageQuantity --group-by Type=DIMENSION,Key=SERVICE Type=DIMENSION,Key=USAGE_TYPE
aws ce get-cost-and-usage-with-resources --time-period Start=$D,End=$N --granularity DAILY --metrics AmortizedCost UsageQuantity --group-by Type=DIMENSION,Key=RESOURCE_ID --filter '{"Dimensions":{"Key":"SERVICE","Values":["Amazon Elastic Compute Cloud - Compute"]}}'
```

The first is the truth (Σ = the day). The second explains each service. The
third is the only per-resource view Cost Explorer has (EC2, 14 days).

## 3. Service-by-service mapping decision

Use this table to classify every service that shows up in §2. `Key` is the
identifier that joins the cloud resource to null.

| Service | Attribution | Key to null | Data source | Notes |
|---|---|---|---|---|
| EC2 instances (scopes) | **direct** | tags `scope_id`/`application_id` on the instance | CE resource-level + `DescribeInstances` | exact, amortized |
| EC2 instances (k8s nodes) | **cluster** | tag `eks:cluster-name` / `kubernetes.io/cluster/<n>` | idem | composed into the cluster fact |
| EKS control plane | cluster | service EKS ÷ clusters | CE by service | |
| ELB | cluster or direct | tag `elbv2.k8s.aws/cluster` → cluster; else `scope_id` tag | tagging API + `DescribeLoadBalancers` (denominator) | share by LB count |
| VPC (NAT, endpoints, IPv4), data transfer | cluster (networking) | VPC of the cluster | CE usage types | when several VPCs, split by VPC of the resources |
| EBS | cluster / scope | volume attachment → instance → its owner | `DescribeVolumes` + EBS usage types | prorated by GB |
| RDS / Aurora | **direct → null service** | `service.attributes.host` == cluster/instance **endpoint**; ideally the package stores the ARN | `DescribeDBClusters/Instances` + `GET /service?show_descendants=true` | `allocation_method: service_owner`; several DBs → split RDS cost by instance-hours or DB count |
| ElastiCache, OpenSearch, MSK | direct → null service | endpoint == `attributes.host`/`endpoint` | describe-* + null services | same rule as RDS |
| Lambda, API Gateway, ECR, CloudWatch Logs, CloudFront, Amplify | direct by tag | null tags on the resource | tagging API; cost per resource needs activated allocation tags or CUR; else prorate by CloudWatch usage (invocations, GB-s, requests, stored bytes) | |
| S3, DynamoDB, SQS | rule | usually **untagged** → naming rule / `cost_allocation_rule`; ask provisioning to tag | inventory + CloudWatch (BucketSizeBytes, ConsumedCapacity) for proration | |
| CloudWatch metrics/alarms, KMS, Secrets Manager, Route 53, Kiro, Support | shared | none | CE by service | explicit `unallocated` buckets; a rule can split them by app count or spend share |

Databases and caches that run **inside** the cluster (null services with
`hostname 172.20.x.x` / `helm_release_name`) have no AWS line: they are part
of the cluster's consumption and get allocated in phase 3 by namespace/pod
→ service via the release name.

## 4. Kubernetes recommendation

- Compose the cluster: nodes + control plane + tagged LBs + VPC networking +
  attached EBS + other EC2 charges. Store the composition as component rows.
- Do **not** split the cluster per scope from billing. Derive **blended rates**
  over reserved capacity: `rate_cpu = cost × cpu_share ÷ Σ(vCPU × hours)`,
  `rate_mem = cost × (1 − cpu_share) ÷ Σ(GiB × hours)`; `cpu_share` defaults to
  0.5 (Kubecost convention), tune per org. Capacity from `DescribeInstanceTypes`
  and instance-hours from CE resource-level.
- Allocate by consumption (phase 3): a package running in the cluster reads
  requests/usage per pod (metrics.k8s.io or Prometheus when present), maps pods
  to scope/service via labels, and the allocator charges
  `cpu_core_h × rate_cpu + gib_h × rate_mem`. Idle capacity stays on the
  cluster as an explicit bucket. Iron rule from the `cost/` suite: compare
  usage vs request **per pod**, never per fleet.
- The pod's identity for cost is the pod's IAM role (IRSA / Pod Identity): the
  `cloud-query` worker needs `ce:*Get*`, `ec2:Describe*`, `elasticloadbalancing:Describe*`,
  `rds:Describe*`, `tag:GetResources`, `cloudwatch:GetMetricData`, `sts:GetCallerIdentity`.

## 4b. The role the worker runs with — configured per customer

Three knobs, all per target and all without registering the package on the
platform. `wf0-aws-billing-dispatch` holds one **target per account**:

```json
{ "name": "prod", "agent_tags": { "package": "cloud-query", "account": "prod" },
  "package_version": "0.0.1",
  "assume_role_arn": "arn:aws:iam::111122223333:role/np-finops", "assume_role_external_id": "…",
  "region": "us-east-1", "expected_account": "111122223333" }
```

| Knob | Chooses | Where it is set |
|---|---|---|
| `agent_tags` | **which agent** (cluster / environment) runs the worker | target |
| `package_version` | **which worker pin** on that agent — and the pin declares the pod **service account** → IAM role (pins are keyed by package + version; different SAs = different pinned versions/patch targets) | target + agent Helm values |
| `assume_role_arn` (+ `assume_role_external_id`) | the **AWS role** assumed before the calls, per account | target (or config entry) |

`expected_account` makes the run fail when the STS identity the worker ended up
with is another account — the facts always carry `cloud_account` from that
identity, never from config.

Two layers underneath:

**Layer 1 — identity of the worker pod (per cluster, in the agent Helm values).**
The agent patches the worker pod for the `cloud-query` package with a service
account; that service account carries the IAM role (IRSA or EKS Pod Identity):

```yaml
worker:
  allowedRegistries: ["public.ecr.aws/nullplatform/*"]
  patches:
    - target: { package: cloud-query }
      merge:
        spec:
          serviceAccountName: np-cloud-query      # annotated eks.amazonaws.com/role-arn: arn:aws:iam::<acct>:role/np-finops-worker
```

The role's policy is the read-only set below. Trust: the cluster's OIDC
provider with `sub = system:serviceaccount:<ns>:np-cloud-query` (IRSA) or
`pods.eks.amazonaws.com` (Pod Identity).

**Layer 2 — AssumeRole per account (per customer, in the workflow config).**
When the customer wants its own role, or bills several accounts, the worker
assumes a role before every call. `wf1-aws-billing-daily` takes
`assume_role_arn` + `assume_role_external_id` (inputs or the workflow
variables `assume_role_arn` / `assume_role_external_id`; set them on the
customer's revision or from config entries). Trust policy of that role:

```json
{ "Effect": "Allow",
  "Principal": { "AWS": "arn:aws:iam::<worker-account>:role/np-finops-worker" },
  "Action": "sts:AssumeRole",
  "Condition": { "StringEquals": { "sts:ExternalId": "<customer-specific external id>" } } }
```

The worker's base role then only needs `sts:AssumeRole` on the customer roles;
the read-only policy lives on the customer role. One collector run per account
(the `cloud_account` dimension separates the facts).

Read-only policy for whichever role does the reading:

```json
{ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow", "Resource": "*", "Action": [
  "ce:GetCostAndUsage", "ce:GetCostAndUsageWithResources", "ce:GetDimensionValues", "ce:GetTags",
  "ec2:DescribeInstances", "ec2:DescribeVolumes", "ec2:DescribeInstanceTypes", "ec2:DescribeTags",
  "elasticloadbalancing:DescribeLoadBalancers", "rds:DescribeDBClusters", "rds:DescribeDBInstances",
  "tag:GetResources", "cloudwatch:GetMetricData", "cloudwatch:ListMetrics", "sts:GetCallerIdentity" ] }] }
```

## 5. Direct-cost recommendation

1. Every resource null provisions must carry `application_id`, `scope_id` or
   `service_id`, plus `namespace_id`, `account_id`, `environment` — in EC2 tags
   (already), Lambda (already), API Gateway (prefixed variant), and **also S3,
   DynamoDB, SQS, ElastiCache, RDS** (missing today).
2. Service packages should persist the cloud identifier in `attributes`
   (`arn`, `identifier`, `host`). Host is enough for anything with an endpoint.
3. Activate cost allocation tags at the payer for `scope_id`, `application_id`,
   `service_id`; with them, Cost Explorer attributes per tag with no inventory.
4. Anything shared (KMS, Secrets Manager, Route 53, support, seat licences)
   stays in explicit `unallocated` buckets until a `cost_allocation_rule` says how
   to split it. Never hide it inside another number.

## 6. What the facts look like

One row per subject per day in the `cost_daily` catalog spec. Every part of
the logical id is a field:

```json
{"id": "raw-cluster-developent-2026-09-09", "date": "2026-09-09", "stage": "raw",
 "subject_type": "cluster", "subject_id": "developent", "subject_name": "developent",
 "cluster": "developent", "region": "us-east-1", "cloud": "aws", "cloud_account": "688720756067",
 "cost_usd": 27.743594, "quantity": 9, "units": "nodes",
 "cpu_capacity_core_h": 624, "mem_capacity_gb_h": 1440, "cpu_share": 0.5,
 "rate_cpu_usd_core_h": 0.02223, "rate_mem_usd_gb_h": 0.009633,
 "allocation_method": "unallocated", "source": "aws_ce",
 "collector": "finops_aws_billing_daily@0.2.0", "collected_at": "2026-09-10T16:44:43.520Z"}
```

Sum rule: Σ `cost_usd` over `subject_type = cloud_service` equals the day's
amortized total. Buckets, resources, scopes and services carry `parent_id`
to the service fact; the cluster is derived from its components. The
`allocated` stage (next) produces one row per application per resource per
day, categorized (compute, kubernetes, database, storage, network, other) and
cut by environment / namespace / account.

## 7. Checklist for a new account (itti)

- [ ] payer or linked? CUR? allocation tags? Savings Plans / RIs?
- [ ] inventory with tag coverage per service, both tag conventions
- [ ] one day of cost in the three cuts; Σ services = amortized total
- [ ] cluster composition and blended rates for each EKS cluster
- [ ] databases/caches ↔ null services by host/ARN; list the unmatched
- [ ] untagged S3 / DynamoDB / SQS: naming rule or tagging request
- [ ] IAM role for the worker (IRSA), agent Helm values (`allowedRegistries`, pin, `serviceAccount`)
- [ ] run `wf1-aws-billing-daily` in `dry_run`, review the summary, then write


## 6. From mapping by hand to rules (2026-09-11)

Everything §1–§5 discovered for one account becomes DATA, not code:

1. Run the collector once (`dry_run`), open `wf2`'s `unallocated_leaves` (or the
   `alloc-unallocated-<day>` row): that is the list to work through, ordered by USD.
2. For each leaf, find the evidence: null tags (`tags.application_id` → `capture`), a null
   service host (`default:null-service` already handles it), application parameters (the
   suggestion workflow scans them; `setup/03-mapping-rules.sh` loads what you accept), naming
   conventions (regex with named groups → `capture`), or a business decision (`bucket`).
3. Shared resources get a `split` now and a `by_metric` later (Performance Insights `db.name`,
   log-group `IncomingBytes`, k8s requests): the rule stays, only the method changes.
4. Re-run `wf2` for the day: rules are versioned and every allocated row records its `rule_id`,
   so a day can be re-allocated after a rule change without re-collecting billing.
