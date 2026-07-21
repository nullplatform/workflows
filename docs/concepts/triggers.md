# Triggers

A trigger is how an execution starts without a human calling `execute`. All
triggers share one lifecycle rule: **they register on alias ACTIVATION,
never on save** — uploading a definition wires nothing.

## The catalog

| Trigger | Fires when | Notes |
|---|---|---|
| `manual` | You run it (UI RUN button, `POST …/execute`, `np-workflow run`) | Declare run parameters on the trigger's `config.inputs` — that is what builds the RUN dialog (see below) |
| `cron` | On schedule | Registered/paused with the alias; timezone-aware expressions |
| `webhook` | An HTTP request hits the minted URL | URLs are **token-bearing and alias-scoped**: the trailing segment is an opaque capability token minted at activation. Read the real URL from `GET /workflows/triggers?workflowId=…&status=active` — never construct one by hand |
| `slack` | A message/mention/action in Slack | Applies an idempotency key automatically (`slack:<team>:<event>`) so redeliveries never double-start |
| `np-deployment` / `np-scope` | Platform deployment/scope events | Event-specific routing: the handler can activate a per-event output port (e.g. `onCreated` vs `onUpdated`) |
| `np-action-item` | Action-item events (created, comment added, suggestion accepted…) | Filterable by labels (`labelFilters`); the backbone of item-driven flows |
| `np-checklist` | Checklist item lifecycle | Used by governance gates |
| `on-error` / `execution-failed` | Another workflow's execution fails | Build your own failure-handling/alerting workflows |

Every trigger's exact config schema is in the
[plugin catalog](../reference/plugin-catalog.md), or live via
`GET /workflows/plugins` for your deployment (your org's custom plugins
included).

## Run parameters: `config.inputs` on the manual trigger

To make the RUN dialog prompt for values, declare them on the **manual
trigger's** `config.inputs` — not as workflow `variables`:

```yaml
- id: start
  plugin_type: manual
  config:
    inputs:
      scope_id: { type: string, required: true, description: "Scope to analyze" }
      dry_run:  { type: boolean, default: false }
```

Steps read them as `${{ workflow.inputs.scope_id }}`. `variables:` is
internal mutable state seeded from `initialValue` — it never prompts, and an
input's `default:` is NOT applied at runtime (constants a step needs go in
`variables`).

## Trigger payload → workflow inputs

Whatever the trigger produces (webhook body, platform event, cron tick
metadata) arrives as `workflow.inputs.*`. A trigger step is a pure entry
point at runtime — no plugin executes; its payload passes through, and
event-specific ports route different event kinds to different branches.

## Activation semantics you can rely on

- Activate = register (cron scheduled, webhook URL minted, event
  subscription created). Deactivate = deregister. Atomic, with rollback.
- Re-activating mints **new** webhook tokens — old URLs stop working; always
  re-read from the triggers endpoint after activation.
- Two aliases of the same workflow can be active with different revisions —
  each carries its own trigger registrations.

## Retried starts: idempotency keys

Anything that may deliver twice (queues, webhook redeliveries, overlapping
crons) should pass `"idempotencyKey"` on `execute`. One execution per
`(workflow, key)` — the repeat call returns the same execution with
`deduplicated: true`. The Slack trigger does this for you; custom callers do
it themselves.

## One event, several consumers

Comments on action items follow a useful pattern (see the cost suite's wf3):
the trigger forwards each comment as a **signal** first — if an execution is
waiting on it, the comment was a command ("deploy now"); if nobody is
waiting (the signal API answers non-2xx), route it to a Q&A workflow
instead. Trigger → signal → fallback is the house pattern for "commands
first, questions second".
