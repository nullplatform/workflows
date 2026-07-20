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

## Configuration

Credentials and tenant settings are supplied as **config entries** scoped to
each workflow or its folder — referenced as `${{ secrets.* }}` / `${{ vars.* }}`,
never inlined:

| Name | Kind | Used by |
|---|---|---|
| `NP_API_KEY` | secret | all three (NP API calls / channel registration) |
| `NP_ORGANIZATION_ID` | var | all three (org NRN the trigger registers under) |
| `JIRA_BASE_URL` | var | `validate-jira-epic`, `create-jira-ticket` |
| `JIRA_EMAIL` | var | `validate-jira-epic`, `create-jira-ticket` |
| `JIRA_API_TOKEN` | secret | `validate-jira-epic`, `create-jira-ticket` |
| `JIRA_PROJECT_KEY` | var | `create-jira-ticket` |

`create-jira-ticket` also needs a one-time Jira setup per project: a string
custom field to hold the callback URL, and an Automation rule that sends a web
request to it on "Issue transitioned". Set the custom field id in the workflow
(`__JIRA_CALLBACK_FIELD_ID__`) before uploading.
