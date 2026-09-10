# IAM for the cloud-query worker

| File | Attach to | Purpose |
|---|---|---|
| `np-finops-worker-policy.json` | the role that READS billing (worker role, or the per-account role when AssumeRole is used) | least-privilege read-only for phases 1–3 (Cost Explorer, inventory, tags, CloudWatch). Every action is a read; `Resource: "*"` because these APIs are not resource-scoped. |
| `np-finops-worker-policy-cur.json` | same role, only when the account has a CUR queried through Athena | replace the two bucket placeholders |
| `trust-irsa.json` | the worker role, EKS with IRSA | one OIDC provider per cluster; `sub` pins the agent namespace + service account `np-cloud-query` |
| `trust-pod-identity.json` | the worker role, EKS Pod Identity | then `aws eks create-pod-identity-association --cluster-name <c> --namespace <ns> --service-account np-cloud-query --role-arn <role>` |
| `np-finops-worker-assume-policy.json` | the worker role, multi-account | lets the base identity assume `np-finops` in every customer account |
| `trust-cross-account.json` | each customer/account role `np-finops` | trusts the worker role, gated by an `ExternalId` per customer |

Two shapes:

1. **Single account** — worker role = reader: `trust-irsa.json` (or pod identity) + `np-finops-worker-policy.json`.
2. **Multi-account** — worker role = `np-finops-worker` with only `np-finops-worker-assume-policy.json`; each account has `np-finops` with `trust-cross-account.json` + `np-finops-worker-policy.json`; the dispatcher target sets `assume_role_arn` + `assume_role_external_id`.

Cost Explorer notes: linked accounts need "linked account access to Cost Explorer" enabled at the payer; cost allocation tags are activated at the payer; every Cost Explorer API call costs USD 0.01.
