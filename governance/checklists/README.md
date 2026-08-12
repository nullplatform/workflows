# Checklist template definitions

The workflows in `governance/` resolve **checklist external items**, but a
workflow alone does nothing until a **checklist template** exists in the
approval-api and is associated with an `ApprovalAction`. These files version
those template definitions — the other half of the experience, which
otherwise lives only as rows in the approval-api.

All three are **snapshots of the live production templates** (fetched from
the approval-api on 2026-08-12), not sketches:

| Template | Live id | Items | Paired workflow(s) |
|---|---|---|---|
| [`deploy-gate.yaml`](./deploy-gate.yaml) | `tmpl_9biefuuos8lbszqc` v2 | `epic_valid` (external, `validate-jira-epic`) + `tests_confirmed` (manual) + `release_passed_stage` (external, `check-release-staged`) | `validate-jira-epic.yaml`, `check-release-staged.yaml` |
| [`create-jira-ticket-gate.yaml`](./create-jira-ticket-gate.yaml) | `tmpl_29u1dbnujpvjpgcq` v1 | `create_jira` (external, `create-jira-ticket`) | `create-jira-ticket.yaml` |
| [`security-deploy-gate.yaml`](./security-deploy-gate.yaml) | `tmpl_9a7hsfvf9zo244vx` v5 | 2 manual policy confirmations + 1 condition + 3 public-scope external gates (`create-jira-ticket-public` ×2, `validate-security-assessment`) | Jira-ticket workflow variants (live in the demo org; not yet in this repo) |

⚠️ `security-deploy-gate.yaml` predates the removal of the legacy condition
dialect — its condition item uses `evaluator: expression`, which today's
validator rejects (`condition.evaluator.removed`). Rewrite it as a
mongo-like `query` before re-creating that template (note in the file).

## How the halves connect

```
deployment:create ──► ApprovalRequest ──► ChecklistRun (items from template)
                                              │ external item dispatched
                                              │ (notification: source=checklist,
                                              │  action=checklist:item:dispatched,
                                              │  context.kind=<kind>)
                                              ▼
                    np-checklist-trigger (filters on kind) ──► workflow runs
                                              │
                                              ▼
                    np-checklist-item-resolve (callbackUrl/token from dispatch)
                                              │
                                              ▼
                    item passed/failed ──► re-aggregation ──► final_outcome
```

The `np-checklist-trigger` step in each workflow auto-registers the
notification channel at **alias activation** — no channel to create by hand.
The template's `external.kind` and the trigger's `config.kind` are the
contract; they must match exactly.

## External item shape (NP dispatch path)

External items here declare only:

```yaml
external:
  kind: "<semantic-name>"      # required — channels filter on this
  inputs: { … }                # optional — templated against the run context
  timeout_seconds: 60          # optional — item fails if no callback in time
  trigger: auto                # auto | on_demand
```

`channel`/`url`/`method`/`headers` are **rejected** by the approval-api
validator (`CHECKLIST_TEMPLATE.INVALID_EXTERNAL_SHAPE`) — routing belongs to
notification channels, not the template.

Other validator rules worth knowing (they used to fail silently at run time,
now they fail at save time):

- Condition `query` / `applies_when` paths address the context catalog
  directly (`build.metadata.coverage`), **never** `context.`-rooted.
- Item ids must not be `and`, `or`, `not`, `true` or `false` (reserved by
  the aggregation grammar).
- Every item needs an explicit `behavior` (`gate` | `informational` |
  `override`).

## Deploying a template

With the `np-checklist` skill (or the equivalent raw API calls against
`/approval/checklist/template`):

```bash
# 1. Create
create_template.sh \
  --nrn "organization=<org-id>" \
  --name "deploy-gate" \
  --definition-file ./deploy-gate.yaml \
  --created-by "<you>"

# 2. Associate with the approval action (fails 409 if the action still has
#    live policies — use migrate_action.sh for those)
set_action_template.sh --action-id <approval-action-id> --template-id <tmpl_…>

# 3. Activate the paired workflows' aliases so their triggers register the
#    notification channels, then fire a deployment and watch the run.
```

Templates are versioned and runs snapshot them — editing a template never
affects in-flight runs.
