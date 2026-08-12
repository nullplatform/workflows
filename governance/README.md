# Governance

Deployment-governance workflows that back **checklist external items** — the
gates a release must pass before it ships. Each workflow pairs with a checklist
item `kind`: the `np-checklist-trigger` step auto-registers a notification
channel on alias activation, receives the dispatch (with a `callbackUrl` /
`callbackToken`), does its check, and resolves the item `passed` / `failed`.

## Workflows

| File | Kind | What it checks |
|---|---|---|
| `validate-jira-epic.yaml` | `validate-jira-epic` | The Jira epic referenced in deployment metadata exists, is of type Epic, and sits in a permissible status. Fetches the epic (`jira-get-issue`), validates, resolves the item. |
| `check-release-staged.yaml` | `check-release-staged` | The release was previously deployed to a `dimensions.environment=stage` scope of the same application — scans the last 30 finalized deployments and passes on a match. |
| `create-jira-ticket.yaml` | `create-jira-ticket` | Creates a Jira ticket, writes a per-execution callback URL into a custom field, then **parks on `signal-wait`** until a Jira Automation rule pokes it back. On the poke it re-reads the ticket from Jira (source of truth — the webhook body is untrusted) and resolves passed / failed. |
| `arch-rule-check.yaml` | `arch-rule-check` | Evaluates ONE company architecture rule (carried in the item inputs) against the application repository with an LLM pass, and resolves the item with findings and fix instructions. Incremental: a rule whose files did not change carries over its previous verdict. |
| `audit-entity-check.yaml` | `audit-entity-check` | **Static, preventive** check that the entities this application writes are configured for the HTTP audit pipeline. Reads the enhancer's `entityConfig` / `clients` maps out of its repository and classifies every entity by how it will be enriched (STANDARD = fetched, SELF_CONTAINED = the write must echo it, NRN, ignored), then an LLM pass over this repository looks for write routes that produce no audit event, names that no entry handles, and self-contained entities the write never echoes back. No lake queries and no live probes — runtime health (`degraded`, `dropped`, DLQ) is the pipeline monitors' job, and a pre-deploy probe of a new entity proves nothing. Incremental like `arch-rule-check`, but the checkpoint also stamps a fingerprint of the enhancer configuration: a verdict is reused only while the code diff AND that configuration are unchanged. |

## Patterns worth knowing

- **Push + re-read, spoofing-safe** (`create-jira-ticket`): the workflow never
  polls. A Jira Automation rule POSTs to the callback URL on every transition;
  that POST is only a "poke", and the outcome always comes from a fresh Jira
  read, so a forged or replayed poke is harmless.
- **Dedicated failure-resolve nodes**: a lookup/create failure routes via
  `error_handling.fallback_step` to a single-predecessor resolve node that
  marks the item `failed` with the underlying error — instead of leaving it
  pending until timeout. (A node mixing a failed edge with completed edges
  can't be made ready by any join strategy, hence the dedicated node.)
- **`signal-wait` timeout via `onTimeout: error` + `fallback_step`**, never a
  `timeout` output port — module descriptors can be stale in the Temporal
  worker's in-sandbox graph validation, so an edge off a non-default port trips
  `CONNECTION_SOURCE_PORT_UNKNOWN` at runtime.
- **A fallback needs a declared edge** (`condition: "false"` keeps it dormant),
  and it can only fire into a node whose predecessors are *all* settled — which
  is why each failure path gets its own single-predecessor node. If a failed step
  ever has to rejoin the main path instead of resolving the item, its re-entry
  node must continue to the **same successor the failed step had**, so that every
  join point has two predecessors of which exactly one can complete: that is the
  only shape `join_strategy: any` resolves without a race (`any` fires on the
  *first* completed edge).
- **A checkpoint is only valid for the inputs it was taken against**
  (`audit-entity-check`): the verdict depends on this repository *and* on the
  enhancer's entity configuration, which lives in another repo and moves on its
  own. The incremental decision therefore compares a canonical fingerprint of
  that configuration alongside the code diff — otherwise a change in the enhancer
  would never re-evaluate any application until it happened to touch its own
  code. A checkpoint stamped before the fingerprint existed re-opens the analysis
  exactly once.
- **Gate on what the deploy can change** (`audit-entity-check`): the check reads
  source only. Runtime signals were removed on purpose — they cannot be
  attributed to the deploy that gates on them (the lake's `application` column is
  the *caller*, not the producer), the organization's chronic problems would land
  on every application's item as findings that are not theirs, and the pipeline's
  monitors already watch runtime continuously. What a pre-deploy check cannot
  settle is published as unverified and revisited on the next deploy through the
  checkpoint.
- **What could not be read is not a finding** (`audit-entity-check`): a source
  the step failed to read is reported as unverified on the item and never as a
  defect of the application, and it never blocks the incremental path.

## Configuration

Credentials and tenant settings are supplied as **config entries** scoped to
each workflow or its folder — referenced as `${{ secrets.* }}` / `${{ vars.* }}`,
never inlined:

| Name | Kind | Used by |
|---|---|---|
| `NP_API_KEY` | secret | all five (NP API calls / channel registration) |
| `NP_ORGANIZATION_ID` | var | the org NRN the trigger registers the channel under. `audit-entity-check` cannot use the expression (the hosted engine does not resolve `vars` in trigger config) and carries the literal org id instead — keep the two in sync. |
| `GITHUB_TOKEN` | secret | `arch-rule-check`, `audit-entity-check` (read the application repo, and the enhancer repo) |
| `JIRA_BASE_URL` | var | `validate-jira-epic`, `create-jira-ticket` |
| `JIRA_EMAIL` | var | `validate-jira-epic`, `create-jira-ticket` |
| `JIRA_API_TOKEN` | secret | `validate-jira-epic`, `create-jira-ticket` |
| `JIRA_PROJECT_KEY` | var | `create-jira-ticket` |

`create-jira-ticket` also needs a one-time Jira setup per project: a string
custom field to hold the callback URL, and an Automation rule that sends a web
request to it on "Issue transitioned". Set the custom field id in the workflow
(`__JIRA_CALLBACK_FIELD_ID__`) before uploading.
