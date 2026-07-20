# AMI Drift Detection

Detects drift between the AMI configured for EC2 scopes (NP provider
configuration) and the AMI their **active** deployments actually run, and
manages one action item per drifted scope. Portable: load the folder into any
organization and set two config entries.

## Workflows

| File | Workflow | Triggers | What it does |
|---|---|---|---|
| `wf1-ami-drift-scanner.yaml` | `ami_drift_scanner` | cron `0 3 * * *` (AR) + manual | Builds the configured-AMI baseline (provider API → runtime configs), queries the datalake for active EC2 deployments and their deployed AMI, and ensures one idempotent action item per drifted scope (priority `medium`, value `200`, due date now + `AMI_DRIFT_DUE_DAYS`). |
| `ensure-drift-action-item.yaml` | `ami_drift_ensure_action_item` | (sub-workflow) | Per finding: search by `metadata.drift_key = "ami-drift:<scope_id>"`; create when missing, refresh metadata when the deployed AMI changed, no-op otherwise. |
| `wf2-ami-drift-closer.yaml` | `ami_drift_closer` | cron `0 4 * * *` (AR) + manual | Recomputes the current drift set with the same logic and closes (comment + `close`) every open `ami-drift` item whose drift is gone. |

## Loading into an organization

1. **Category** — the action item category must already exist (the workflows
   assume it and fail otherwise). One-off if missing:

   ```bash
   curl -X POST https://api.nullplatform.com/governance/action_item_category \
     -H "Authorization: Bearer $NP_TOKEN" -H 'Content-Type: application/json' \
     -d '{"nrn":"organization=<ORG_ID>","name":"Engineering"}'
   ```

2. **Upload the three definitions** (`POST /workflows/definitions` with the
   normalized JSON, or via the editor) under folder path
   `/action-items/ami-drift`. Upload `ensure-drift-action-item.yaml` first —
   the scanner references it by workflow id.

3. **Config entries** on folder `/action-items/ami-drift`
   (`PUT /workflows/config-entries/:name`):

   | Name | Kind | Value |
   |---|---|---|
   | `NP_API_KEY` | secret | NP API key for the org (Platform Settings → API Keys). Long-lived; the plugins exchange it for a token and cache it. |
   | `NP_ORGANIZATION_ID` | var | Organization id, e.g. `<org-id>` |
   | `AMI_DRIFT_CATEGORY_SLUG` | var | Category slug (e.g. `engineering`). REQUIRED: any `vars.X` reference fails hard at config resolution when the entry is missing — the `\|\| 'engineering'` fallback in the YAML never gets a chance to apply. |
   | `AMI_DRIFT_DUE_DAYS` | var | Due-date offset in days (e.g. `14`). REQUIRED, same reason. |

4. **Activate** an alias for each workflow (activation registers the cron
   triggers as Temporal Schedules; deactivation removes them).

## Semantics worth knowing

- **Idempotency** is caller-side: find by `metadata.drift_key` (string) with
  live statuses, create only on zero matches — one live item per scope.
- **Drift rule (v1.2, per-scope expected AMI)**: the baseline is the NRN
  resolution `GET /nrn/{nrn}?ids=aws.amiId` of each unique application nrn
  (provider entries and runtime configs write into the same NRN tree, so
  they are included automatically). A scope's EXPECTED AMI is the profile
  override matching one of its `profiles`, else the resolved base. Drift =
  deployed ≠ expected. Scopes with no resolvable expected AMI are counted
  as `skipped_unconfigured` (config gap, not drift).
- **NRN filter (scanner)**: optional `nrn` workflow/manual-trigger input —
  prefix match on the scope's application nrn (`equal` or `nrn + ':'`), so
  an org/account/namespace/application NRN scans just that subtree. Empty
  (cron runs) scans the whole organization. Filtering happens before the
  NRN resolution fan-out, so scoped runs also make fewer API calls.
- **Deployments without AMI metadata** (predating deployment
  `infrastructure_configuration` metadata) are skipped and counted in the
  summary — no drift evidence.
- **Empty-baseline guard**: if deployments were found but no configured
  AMIs resolve, both workflows fail instead of mass-creating /
  mass-closing. An `nrn` filter matching zero scopes is NOT an error — the
  run completes with `drifted: 0`.
- **Closer limits (v1)**: only `open` items are closed (`deferred` is left
  alone); the find uses `limit: 200` without cursor pagination.
- The EC2 provider specification id (`f784061e-5b6d-4a0d-a19b-754e7f4ef72c`,
  slug `ec2-configuration`) is platform-global (`visible_to: organization=*`)
  and declared as a workflow variable — override its `initialValue` if it
  ever differs.

## Testing

These workflows are covered by an E2E suite (`runWorkflowE2E` with
plugin-level stubs) that exercises the scanner (drift detection,
skip-no-metadata, due-date default/override, empty-baseline failure, healthy
fleet), ensure (create/update/no-op branches), and closer (closes exactly the
stale items, comments first), plus YAML-shape assertions for the payload
constants. The test suite is maintained separately from this reference repo.
