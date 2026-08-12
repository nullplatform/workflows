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
| `audit-entity-check.yaml` | `audit-entity-check` | Validates that the entities this application writes are correctly wired into the HTTP audit pipeline (producer emits the event, the audit-enhancer has config for the entity name, its service account can read it). Combines deterministic signals — two lake queries, the enhancer's `entityConfig`, and a fetch probe replaying the enhancer's own GET — with an LLM pass for write routes that produce no audit at all. Incremental, same checkpoint scheme as `arch-rule-check`. |

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
  and it can only fire into a node whose predecessors are *all* settled. When a
  failed step must rejoin the main path instead of resolving the item — the two
  lake queries in `audit-entity-check` — give it its own single-predecessor
  re-entry node that continues to the **same successor the failed step had**.
  Every join point then has two predecessors of which exactly one ever
  completes, which is the only shape `join_strategy: any` resolves without a
  race (`any` fires on the *first* completed edge, so two edges that can both
  complete would start the target too early). Chaining the re-entry into the
  next step, rather than skipping to the end, is what keeps one dead source from
  taking its independent siblings down with it.
- **Degraded sources are not findings** (`audit-entity-check`): signal
  collection reports anomalies of the audited system and failures to read a
  source on two separate channels. Only the former may force an analysis;
  otherwise one missing credential silently disables the incremental path
  forever. Both are published on the item.

## Configuration

Credentials and tenant settings are supplied as **config entries** scoped to
each workflow or its folder — referenced as `${{ secrets.* }}` / `${{ vars.* }}`,
never inlined:

| Name | Kind | Used by |
|---|---|---|
| `NP_API_KEY` | secret | all five (NP API calls, lake queries) |
| `NP_ORGANIZATION_ID` | var | the org NRN the trigger registers the channel under. `audit-entity-check` cannot use the expression (the hosted engine does not resolve `vars` in trigger config) and carries the literal org id instead — keep the two in sync. |
| `GITHUB_TOKEN` | secret | `arch-rule-check`, `audit-entity-check` (read the application repo, and the enhancer repo) |
| `ENHANCER_API_KEY` | secret | `audit-entity-check` (the audit-enhancer's own api key: the fetch probe replays its GET with its identity, so the response codes are conclusive) |
| `JIRA_BASE_URL` | var | `validate-jira-epic`, `create-jira-ticket` |
| `JIRA_EMAIL` | var | `validate-jira-epic`, `create-jira-ticket` |
| `JIRA_API_TOKEN` | secret | `validate-jira-epic`, `create-jira-ticket` |
| `JIRA_PROJECT_KEY` | var | `create-jira-ticket` |

`create-jira-ticket` also needs a one-time Jira setup per project: a string
custom field to hold the callback URL, and an Automation rule that sends a web
request to it on "Issue transitioned". Set the custom field id in the workflow
(`__JIRA_CALLBACK_FIELD_ID__`) before uploading.
