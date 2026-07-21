# Signals & waits

Everything that pauses a workflow — an approval, a webhook callback, a
nightly deploy window, a human replying on a thread — pauses on **one
primitive: the signal**. There are no event subscriptions inside workflows
and no polling loops; a paused execution is parked durably (no compute
burns) until its signal arrives or its timeout fires.

## The contract

A wait declares **what it waits for**:

```yaml
- id: wait_approval
  type: wait
  plugin_type: signal-wait
  config:
    signalName: rightsizing-command      # the channel
    correlationKey: "item:${{ workflow.inputs.item_id }}"   # WHICH wait
    timeout: "48h"
    onTimeout: continue                  # or: error
```

Anyone delivers the signal through the API:

```
POST /workflows/signals/rightsizing-command
{ "correlationKey": "item:ai_123", "payload": { "action": "deploy-now" } }
```

- `signalName` is the channel; `correlationKey` selects the specific parked
  execution. Design keys around your domain (`item:<id>`, `scope:<id>`).
- A signal with **no one waiting** answers non-2xx (409). That is not an
  error — it is information. The house pattern routes unclaimed signals to a
  fallback (e.g. an unclaimed item comment was a question, not a command).
- The waking payload is the wait step's output — branch on it downstream.

## Timeouts

`timeout` + `onTimeout` decide what happens when nobody signals:

- `onTimeout: error` — the step fails; route the failure with
  `error_handling.fallback_step` to a dedicated resolve step.
- `onTimeout: continue` — the step completes through its normal port with
  `timedOut: true` in its outputs; branch on it with a decider.

Do **not** wire a separate connection off a `timeout` port of a wait step —
route timeouts through `onTimeout` + outputs. Error paths declared via
`error_handling.fallback_step` need their edge declared with
`condition: "false"` so the graph knows it exists without traversing it on
success.

## Wait plugins: "do something, then wait" as ONE step

Most real waits are composite: create a resource, then wait for the human.
Wait plugins package both so authors never see the signal plumbing:

- `slack-ask` — post an interactive message, wait for the button.
- `np-action-item-wait` — wait for an item transition.
- `jira-wait-transition` — wait for a ticket to reach a status.
- `webhook-wait` — mint a one-shot callback URL, wait for it to be hit.

Under the hood these use a two-phase protocol (side effect first, park
second) so the wait is exactly as durable as a plain `signal-wait`. From the
YAML they are a single step with a `timeout`.

## Waiting in a loop: re-arm

For "wait, act, wait again" (a nightly window that re-arms until the item
closes; a thread that accepts many commands), wire the wait in a cycle: wait
→ decide → act → back into the wait's **re-entry port**. Two things make
loops work:

- The looped step needs `join_strategy: any` (it has a normal entry edge AND
  the loop-back edge — the default `all` deadlocks).
- Re-entry ports reset the node's join state each iteration; the engine's
  per-node execution cap bounds runaway loops.

The deploy suite's `progressive-deploy` is the full pattern live: the agent
decides, parks on `signal-wait` for each soak, and resumes with its
conversation intact — hours of wall-clock, near-zero compute.

## Signals vs triggers

A **trigger** starts a new execution; a **signal** wakes a parked one. When
an external event could be either ("a comment arrived"), deliver it as a
signal first and fall back to starting a workflow when nobody was waiting —
see [triggers.md](./triggers.md#one-event-several-consumers).

## Testing waits

The test harness resolves signals synchronously: hand `runWorkflowE2E` a
signal handler map and assert both branches — the signaled path and the
timeout path. Every suite with a wait has an example; the governance suite's
tests cover the timeout-fallback wiring explicitly.
