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
| `packages/cloud-query/` | The runner package: generic AWS SDK call executor (Cost Explorer, EC2, ELB, RDS, tagging API, CloudWatch, STS), pagination, 300 KB cap, callback with host allow-list. See its README. |
| `tool-cloud-query.yaml` | Reusable child: agent tags + calls → results by call id (async with engine callback by default, sync for small calls) |
| `wf0-aws-billing-dispatch.yaml` | Multi-account dispatcher: one target per account (agent tags × package version/pin × AssumeRole × region), fan-out of wf1, summary per account. `expected_account` guards the pairing. |
| `wf1-aws-billing-daily.yaml` | Daily collector: one day of AWS billing → `cost_daily` facts (cloud services, usage-type buckets, EC2 scopes/resources, EKS clusters with components + blended rates, databases mapped to null services by host). `dry_run` input. |
| `wf-cost-fact-upsert.yaml` | Child: `PATCH /catalog/instances/<slug>/<id>?upsert=true` for one fact (fan-out target) |
| `specs/cost_daily.spec.json` | Catalog spec (51 fields): subject, null dimensions, cloud dimensions, amortized `cost_usd` + `unblended_usd`, capacity/rates, provenance. Logical id `<stage>-<subject_type>-<slug>-<date>`. |
| `setup/01-catalog-spec.sh` | Creates/updates the spec (needs a session bearer; org API keys get 403) |
| `setup/publish.ts` | Publishes the three workflows to a local engine, patching child ids |
| `__tests__/` | E2E on the local executor, plugins stubbed at the plugin level |

State (2026-09-10): verified live against kwik-e-mart in dry-run (116 facts/day,
Σ services = amortized total). The spec created in kwik (`faf54d0b…`) was
created with `specification: read`-only grants and cannot be patched or deleted
by its creator — recreate it (new slug or admin delete) with the grants now in
`specs/cost_daily.spec.json` before writing facts.

Engine dependency: plugin `np-package-call` (workflow-system-demo, branch
`feat/np-package-call`). Until that ships, `npx np-workflow validate` reports
`No module plugin registered as "np-package-call"` (the kit validates against
the published engine); the E2E tests run against the stub and pass.

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
2. **Catalog spec**: `setup/01-catalog-spec.sh` (session bearer; grants must name a user of
   THAT org — see `specs/cost_daily.spec.json`).
3. **Secret**: `POST /workflows/config {"name":"NP_API_KEY","value":…,"secret":true,"path":"/finops"}`
   with a session bearer (an org API key with catalog + agent_command grants).
4. **Per-org values**: copy `setup/vars.nullplatform.json` — agent tags + `agent_nrn`
   (REQUIRED when the agent is registered under an account: the control plane does not
   find account-level agents from the organization root), `org_nrn`, dispatcher targets.
5. **Publish** (from the engine repo, so the DSL parser resolves):
   `NP_TOKEN=<bearer> pnpm tsx finops/setup/publish.ts finops --base https://api.nullplatform.com --vars finops/setup/vars.<org>.json`
   and later `--update tool-cloud-query.yaml=<id>,…` for new revisions. The dispatcher
   (`wf0`) owns the schedule (04:15 UTC); `wf1` has no cron of its own.
6. **First run**: execute `wf0` with `{"date":"YYYY-MM-DD","dry_run":true}`, read the
   child's `summary`, then run it for real. Rows: `GET /catalog/instances/cost_daily?stage=raw&subject_type=cluster`
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
