# nullplatform workflows

Production-grade **workflow suites** for the [nullplatform](https://nullplatform.com)
workflow system, published as reference and examples. Each suite is a set of
declarative workflow definitions (plus setup runbooks and design docs) that
solves a real operational problem end to end — cost visibility and right-sizing,
safe progressive deploys, deployment-governance gates, and AMI drift detection.

They are written to be **portable**: load a suite into an organization, set a
handful of config entries, and activate. The workflows themselves carry no
credentials or org-specific ids — everything tenant-specific is a config entry
(`${{ secrets.* }}` / `${{ vars.* }}`).

## Suites

| Suite | What it does | Highlights |
|---|---|---|
| **[cost/](./cost)** | Daily per-scope Kubernetes cost from Prometheus, catalog + datalake series for dashboards, weekly AI-validated right-sizing with action items and applyable suggestions, and a monthly price calibration from the real AWS bill. | Per-pod sizing math (never fleet sums), a cheap-first scan decision tree with an Opus deep-dive only on survivors, three closers that never close on missing data, a portfolio item for the long tail. Full [architecture](./cost/docs/architecture.md) and [decisions](./cost/docs/decisions.md) docs. |
| **[deploy/](./deploy)** | Reusable blue-green progressive deploy, narrated and verified, orchestrated by an Opus agent over a small, hard-guardrailed tool set. Any workflow can invoke it to redeploy a scope safely. | Deterministic degradation verdict (the agent narrates, it doesn't judge numbers); parks on `signal-wait` during soaks so long waits cost no compute; blocks (approvals/policies) are narrated, not swallowed. |
| **[governance/](./governance)** | Deployment-governance gates backing checklist external items: validate a Jira epic, check a release reached stage, or create-and-track a Jira ticket before a release ships. | Push + re-read (spoofing-safe) waits, dedicated failure-resolve nodes, and the `signal-wait` timeout pattern that survives the Temporal worker's in-sandbox graph validation. |
| **[ami-drift/](./ami-drift)** | Detects drift between the AMI configured for EC2 scopes and the AMI their active deployments actually run, and manages one idempotent action item per drifted scope (with a closer that clears them when drift is gone). | Per-scope expected-AMI resolution via the NRN tree, caller-side idempotency by `metadata.drift_key`, empty-baseline guard against mass create/close. |

Each suite has its own `README.md` with the full setup runbook, semantics, and
gotchas — start there for anything beyond the overview above.

## How to use these

The workflows target the public nullplatform API at
`https://api.nullplatform.com` (workflow-system base path `/workflows`).

1. **Config entries first.** Create the secrets/vars each suite documents
   (`POST /workflows/config`, upsert by name + folder path). A `${{ vars.X }}`
   reference to a missing entry fails loudly (`CONFIG_ENTRY_UNRESOLVED`) even
   with a `|| ''` fallback — so create them before uploading definitions that
   reference them. Secrets are write-only and always redacted; vars are shared
   plain values.
2. **Upload the definitions.** `POST /workflows/definitions` with the normalized
   JSON `IWorkflowDefinition` for each YAML (or upload via the editor). Where one
   workflow references another by id (e.g. a sub-workflow), upload the referenced
   one first and set the returned `wf_…` id. The `cost/` suite ships a
   `setup/` runbook that scripts the whole sequence.
3. **Activate an alias.** Saving a workflow has **zero** external side effects —
   triggers (crons, webhooks, notification channels) register only when you
   activate an alias, and deactivating removes them. Create a named alias and
   activate it.

See each suite README for the exact config-entry names, the upload order, and
the verification steps to run before activating anything.

## Notes

- These are reference workflows extracted from real deployments. Concrete
  organization ids, credentials, hostnames, and internal figures have been
  replaced with placeholders (`<org-id>`, `${{ secrets.* }}`, `my-cluster`, …) —
  substitute your own.
- Test suites are maintained separately and are not included here.
