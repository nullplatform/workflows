# FinOps analysis — kwik-e-mart (AWS 688720756067), 2026-09-10

Everything below was measured on 2026-09-10 with the `kwik_admin` profile
(Cost Explorer, EC2, tagging API, RDS) and the nullplatform API for org
1255165411. Day analyzed: **2026-09-09**. It is the reference the collectors
in this suite were built and verified against; repeat it for a new account
with [mapping-playbook.md](./mapping-playbook.md).

## 1. The account in one look

| Fact | Value | Why it matters |
|---|---|---|
| Billing role | **Linked account** of an organization payer | no CUR, no Data Exports, cost allocation tags managed at the payer (`ListCostAllocationTags` → AccessDenied, `GROUP BY TAG` returns 0). Cost Explorer works. |
| Spend | ~USD 600 / 30 days unblended | small, ideal to iterate |
| Amortized vs unblended, 09-09 | **37.32** amortized vs 20.69 unblended | EC2 is Savings-Plan covered: unblended EC2 = 0.001/day with a -22.85 negation line on `NoResourceId`; per-instance unblended shows on-demand rates. **Amortized is the chargeback basis** (`cost_usd`); unblended kept in `unblended_usd`. |
| Kubernetes | one EKS cluster `developent` (1.34), 9 nodes: 4× c5a.xlarge, 2× t3.large, 3× t3.medium = 26 vCPU / 60 GiB | Karpenter + an ASG; no Prometheus, no Container Insights, no metrics-server addon, no AMP |
| Load balancers | 4 (3 belong to the cluster by tag `elbv2.k8s.aws/cluster`, 1 `null-main-balancer`) | |
| Networking | 1 NAT gateway + VPC endpoints in the cluster VPC `vpc-01cb60321d5e7b150` | attributed to the cluster |
| Databases | Aurora MySQL cluster `transactions` with **no instances** (backup + 1 GB storage, cents); null service `transactions` exists with `attributes.host` = the cluster endpoint | the mapping key for databases is the **host** |
| Tagged resources (tagging API) | 2,064 | see §3 |

## 2. Daily cost by service, 2026-09-09 (amortized)

| Service | USD | Notes |
|---|---|---|
| EC2 – Compute | 16.57 | 32 resources at resource level; SP covered |
| EC2 – Other | 6.20 | EBS gp3 1.52 + gp2 1.42, NAT hours 1.08, NAT bytes 0.99, regional data transfer 0.80, CPU credits 0.38 |
| CloudWatch | 3.10 | metric monitoring 2.33 |
| VPC | 3.04 | public IPv4 1.56, VPC endpoints 1.44 |
| EKS | 2.40 | control plane |
| ELB | 2.16 | 96 LB-hours = 4 LBs |
| Kiro | ~2 | seat licence, org-level |
| S3, ECR, Secrets Manager, Lambda, DynamoDB, KMS, Route53, … | < 1 each | |
| **Total** | **37.32** | Σ of the `cloud_service` facts |

## 3. Which resources carry a null identity

From the tagging API (only resources that were tagged at least once are
returned — never-tagged ones are invisible there):

| Service | Resources | With null tags | Tag convention |
|---|---|---|---|
| ECR | 915 | 914 | `account`, `application`, `namespace` (+ `_id`), `nullplatform` |
| ELB (LBs, TGs, listeners) | 321 | 156 | `elbv2.k8s.aws/cluster`, `ingress.k8s.aws/stack` |
| EKS objects | 206 | 36 | k8s labels |
| API Gateway | 145 | 103 | **`nullplatform:scope-id`, `nullplatform:application`** (prefixed variant) |
| EC2 | 140 | 5 | `scope_id`, `application_id`, `namespace_id`, `scope`, `application`, `namespace` |
| Lambda | 117 | 90 | plain `scope_id`… |
| CloudWatch Logs | 113 | 44 | plain |
| CloudFront, ElastiCache, Amplify | 2 / 1 / 1 | all | plain |
| **DynamoDB (21 tables), S3 (19 buckets)** | — | **none** | untagged → rule by name/config or provisioning must tag |

Two tag conventions coexist (`scope_id` and `nullplatform:scope-id`); the
collector normalizes both (`npDims()` in `wf1-aws-billing-daily.yaml`).

## 4. What Cost Explorer can and cannot attribute

- **Per resource**: only EC2 instances (and NAT gateways, which show up under
  EC2-Compute with their ARN), last **14 days**, `GetCostAndUsageWithResources`.
  EBS volumes come back as `NoResourceId` → prorated by attached GB.
- **Per tag**: needs cost allocation tags activated at the payer. Not available here.
- **Per usage type**: always; it is the breakdown the `bucket` facts carry.
- Each Cost Explorer call costs USD 0.01.

## 5. The EKS cluster, composed (09-09)

| Component | USD | Rule |
|---|---|---|
| nodes | 15.79 | amortized cost of instances tagged to the cluster (`eks:cluster-name`, `kubernetes.io/cluster/<name>`) |
| networking | 5.92 | VPC service (IPv4, endpoints) + EC2-Other NAT/data-transfer usage types, split evenly across clusters |
| control_plane | 2.40 | EKS service ÷ clusters |
| load_balancers | 1.62 | ELB service × (LBs tagged to the cluster ÷ all LBs from `DescribeLoadBalancers`) |
| storage | 1.84 | EC2-Other EBS usage types × (GB attached to cluster nodes ÷ all attached GB) |
| other | 0.17 | rest of EC2-Other (CPU credits) × instance share |
| **cluster** | **27.74** | |

Capacity: 624 core-hours, 1,440 GiB-hours. Blended rates with `cpu_share = 0.5`:
**0.02223 USD/core-hour** (0.0000222 per millicore-hour) and **0.009633 USD/GiB-hour**.
The cluster is not split per scope in the collector; the allocator charges
consumers `cpu_core_h × rate + gib_h × rate`, idle stays on the cluster.

## 6. Decisions taken

1. Amortized cost as `cost_usd`; unblended alongside.
2. Σ `cloud_service` = the day; every other subject is an attribution with
   `parent_id` (buckets, resources, scopes, services) or derived (cluster).
3. Cluster = nodes + control plane + LBs + networking + storage + other; blended
   rate per core-hour and GiB-hour over reserved capacity.
4. Databases map to the null service by **host**; `allocation_method: service_owner`,
   owner application from the service NRN.
5. Facts are **one row per subject per day** (116 for this account/day: 21
   services, 50 usage-type buckets, 29 EC2 resources, 2 scopes, 1 cluster + 6
   components, 1 database). Falabella runs the same pattern at 2.5k rows/day.
6. Next stage (`allocated`): one row **per application per resource per day**,
   categorized (compute, kubernetes, database, storage, network, other), cut by
   environment / namespace / account — see the design spec.

## 7. Open items for this account

- Activate cost allocation tags `scope_id`, `application_id` at the payer to
  attribute Lambda, API Gateway, ECR, Logs by tag in Cost Explorer.
- Tag DynamoDB tables and S3 buckets at provisioning (or add naming rules).
- In-cluster consumption (phase 3) to allocate the cluster by usage.
- Aurora `transactions` has no instances: cents today; the mapping is in place.
