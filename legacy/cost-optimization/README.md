# cost-optimization (legacy — superseded by `cost/`)

> **Do not deploy this suite on new orgs.** It is the July 2026 first-pass
> PoC of cost governance, kept for reference. The production suite is
> [`cost/`](../../cost/) (wf1 cost tracker, wf2 right-sizing scanner, wf3
> events, wf4 apply, wf6 calibration, wf7 closer, wf8 QA), which replaced
> this design after live bring-up on two real clusters.

## What it was

A scanner → planner → apply pipeline over action items:

| File | Role |
|---|---|
| `wf1-cost-scanner.yaml` | Entry scanner: finds over-provisioned scopes, opens action items |
| `wf1b/c/d-cost-scanner-*.yaml` | Same scanner scoped per namespace / account / organization |
| `analyze-scope.yaml` | Per-scope analysis sub-workflow |
| `wf2-remediation-planner.yaml` | Turns findings into remediation suggestions |
| `wf3-apply-and-deploy.yaml` | Applies the suggested resources and redeploys the scope |
| `on-action-item-event.yaml` | Reacts to action-item transitions |

## Why it was replaced

- Billing moved to **scope CONFIG as the source of truth** with a
  cluster-level loading factor (`cost/wf6-cluster-cost-calibration.yaml`)
  instead of point-in-time usage inference.
- Metrics collection moved to a remote agent on the cluster
  (`COST_AGENT_CMDLINE`) rather than API-side estimation.
- The scanner/closer pair adopted the streaming-pagination + idempotent
  action-item patterns shared with `ami-drift/` and `runtime-lifecycle/`.

See `cost/docs/architecture.md` and `cost/docs/decisions.md` for the
decision trail.
