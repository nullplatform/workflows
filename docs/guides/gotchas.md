# Workflow & Plugin Authoring — Gotchas & Lessons

Hard-won knowledge from building, deploying, and debugging real workflows on
this engine. Every entry is **symptom → cause → fix** with a tiny snippet.

If you are about to write your first scanner/loop, read
[Loops and Streaming](../concepts/loops-and-streaming.md) first — this doc covers the
sharp edges *around* those patterns. For expression syntax basics see
[Expressions](../concepts/expressions.md); for the plugin catalog see the
[Plugin Catalog](../reference/plugin-catalog.md).

---

## Workflow YAML

### Expression scope: `workflow.inputs.X` vs bare `inputs.X`

**Symptom.** `${{ inputs.namespace_id }}` resolves to `undefined` even though
the workflow was started with `{ "inputs": { "namespace_id": "..." } }`.

**Cause.** In the expression scope, **bare `inputs.*` is the *step's* resolved
inputs map**, not the workflow inputs. The runner injects the step's declared
`inputs:` block under the `inputs` root so a step's `config:` can reference its
own declared inputs. Workflow-level inputs live under `workflow.inputs.*`.

**Fix.** Use the right root:

```yaml
# Workflow input → always workflow.inputs.X
filters: { namespace_id: "${{ workflow.inputs.namespace_id }}" }

# A value this step declared in its own inputs: block → bare inputs.X
- id: summarize
  inputs:
    results: "${{ variables.app_results }}"
  config:
    code: "return { n: (inputs.results || []).length };"   # inputs.results = THIS step's input
```

Other roots available in scope:
`execution.id` / `execution.correlationKey` / `execution.startedAt`,
`variables.X` (alias of `workflow.variables.X`), `steps.<id>.outputs.*`,
`steps.<id>.status`, `steps.<id>.error.message`, `signal.*`, `trigger.*`,
`secrets.*`, and the per-item `$item` / `$items` / `$itemIndex`.

> Note: `outputs` (workflow-level) is shorthand for `items[0]`, and
> `steps.<id>.outputs.*` is the *previous step's* item-0 outputs — do not reach
> into another step's outputs from a `config:` block; declare an `inputs:` entry
> or use a `variables.X`.

### Runner seeds `variables` from `initialValue`, but does NOT apply input `default` at runtime

**Symptom.** You declared `inputs.okStatuses` with a `default:` value, but at
runtime it is missing/empty when the trigger didn't supply it — the workflow
behaves as if the constant was never set.

**Cause.** The runner seeds the live variable map from each variable's
`initialValue`. It does **not** synthesize input values from an input schema's
`default` — that `default` is documentation/UI metadata, not a runtime fallback.
Inputs are whatever the trigger/caller actually passed.

**Fix.** Put runtime constants the trigger won't supply in `variables` (with
`initialValue`), not in `inputs`:

```yaml
variables:
  okStatuses:
    initialValue: ["Done", "Resolved", "Closed"]   # reliably seeded every run
  failStatuses:
    initialValue: ["Cancelled", "Won't Do", "Rejected"]
```

(The governance suite has a real example.)

### The expression parser has NO array or object literals

**Symptom.** `contains(["Done","Closed"], $item.status)` throws a parse/eval
error; `{ a: 1 }` in an expression doesn't work either.

**Cause.** The grammar's `primary` is `literal | '(' expr ')' | call |
memberAccess` only — there is no array/object literal production. `[` is solely
the computed-member-access operator (`obj[expr]`). String/number/boolean/null
are the only literals.

**Fix.** Lift the array into a `variable` (or input) and reference it:

```yaml
variables:
  okStatuses: { initialValue: ["Done", "Resolved", "Closed"] }
# …
config:
  expression: "contains(variables.okStatuses, $item.status)"
```

### `case` decider needs a UNIQUE port per `cases[].port`; group with chained `conditional`s

**Symptom.** You want "any of {Done, Resolved, Closed} → passed" and tried to
point several `cases` at one port — routing is ambiguous / the canvas can't draw
it cleanly.

**Cause.** The `case` plugin routes by matching the expression result against
each `cases[].match` with strict `===`, activating that case's `port`. Each case
is expected to own a distinct output port; it is a switch, not a set-membership
grouper.

**Fix.** To group multiple values to one outcome, use a chain of `conditional`
deciders with `contains(...)`:

```yaml
- id: classify_ok
  type: decider
  plugin_type: conditional
  config: { expression: "contains(variables.okStatuses, $item.status)" }
- id: classify_fail
  type: decider
  plugin_type: conditional
  config: { expression: "contains(variables.failStatuses, $item.status)" }
connections:
  - { from: classify_ok,   to: resolve_ok,    sourcePort: "true" }
  - { from: classify_ok,   to: classify_fail, sourcePort: "false" }
  - { from: classify_fail, to: resolve_fail,  sourcePort: "true" }
  - { from: classify_fail, to: wait,          sourcePort: "false" }   # keep-waiting back-edge
```

`conditional` and `case` are both `type: decider`. The conditional ports are
`true` / `false`.

### Do NOT route an edge off a MODULE plugin's non-default OUTPUT PORT

**Symptom.** Create-time validation passes, but at runtime the execution fails
with `CONNECTION_SOURCE_PORT_UNKNOWN` for, e.g., the `signal-wait` `timeout`
port — even though that port clearly exists on the descriptor.

**Cause.** At runtime, module steps run as activities and the graph is
re-validated inside the workflow sandbox, where a MODULE plugin's full
descriptor may be stale or absent. A non-default output port that only exists on
the descriptor (like `signal-wait`'s `timeout` port) is unknown to the
in-sandbox validator → a false `CONNECTION_SOURCE_PORT_UNKNOWN`. **Deciders are
validated with full port knowledge**, so their ports (`true`/`false`/case ports)
ARE known and safe to wire.

**Fix.** Don't depend on a module's secondary output port. For `signal-wait`
use `onTimeout: error` and route the failure through `error_handling`:

```yaml
- id: wait
  plugin_type: signal-wait
  config:
    signalName: jira-callback
    correlationKey: "${{ execution.id }}"
    timeout: "2h"
    onTimeout: error                 # FAIL the step on timeout (don't use the `timeout` port)
  error_handling:
    fallback_step: resolve_timeout   # descriptor-independent routing
```

### `error_handling.fallback_step` routes via a DECLARED edge (`condition: "false"`)

**Symptom.** The fallback step never runs, or the graph validator rejects it as
an unreachable/entry-point node.

**Cause.** A fallback target still has to be a known node in the graph; with no
incoming edge the engine treats it as a workflow entry point (or unreachable).
The fallback arrives as a **FAILED edge** at runtime, but the graph needs the
edge declared at author time.

**Fix.** Declare a never-traversed edge so the engine knows the target exists
and isn't an entry point:

```yaml
error_handling:
  fallback_step: resolve_timeout
# …
connections:
  # Permanently-false condition → success path never traverses it; the engine
  # reaches resolve_timeout via error_handling.fallback_step (a FAILED edge).
  - { from: wait, to: resolve_timeout, condition: "false" }
```

### A single resolve node can't mix a COMPLETED edge with FAILED fallback edges — use dedicated single-predecessor nodes

**Symptom.** A "final resolve" node that several paths point at (one success
path plus one or more error-handling fallbacks) never becomes ready — it hangs
under every join strategy you try.

**Cause.** The join semantics:

- `any` becomes ready only on a **`completed`** predecessor; a FAILED edge does
  not satisfy it.
- `all` waits until every non-skipped predecessor is terminal — and a FAILED
  predecessor counts as terminal — but it still **waits on any predecessor that
  is neither settled nor skipped**.
- A `condition: false` / not-reached edge is **not reliably marked skipped**
  (skip is for definitively-not-traversed connections).

So a node fed by one COMPLETED edge (a decider's `true`) *and* FAILED edges (an
error fallback): `any` ignores the failed ones but only fires if the completed
one actually completed; `all` blocks forever on the path that was neither
settled nor skipped. There's no single strategy that makes it ready in all
cases.

**Fix.** Give **each failure path its own dedicated, single-predecessor resolve
node**. One terminal incoming edge → the default `all` join is trivially
satisfied:

```yaml
- id: resolve_ok          # single COMPLETED edge from classify_ok:true
- id: resolve_fail        # single COMPLETED edge from classify_fail:true
- id: resolve_timeout     # single FAILED edge via wait.error_handling.fallback_step
- id: resolve_create_fail # single FAILED edge via create_issue.error_handling.fallback_step
```

The governance suite fans failures out to dedicated resolve nodes this way.

### Reentry/back-edge loops: the looped node needs `join_strategy: any`

**Symptom.** A keep-waiting cycle (e.g. `classify → wait` back-edge) deadlocks:
the `wait` node never re-arms.

**Cause.** The looped node has two incoming edges — the normal entry plus the
re-entry. Under the default `all` join it waits on **both**, but the re-entry
edge only exists once you've already looped, so it can never satisfy `all` on
the first pass.

**Fix.** Set `join_strategy: any` on the looped node so either incoming edge
(re-)fires it:

```yaml
- id: wait
  plugin_type: signal-wait
  join_strategy: any        # entry OR re-entry can (re)arm the wait
```

For the full streaming-pagination loop wiring see
[Loops and Streaming](../concepts/loops-and-streaming.md).

### `signal-wait` `config.timeout`: string in the schema, but the DSL normalizer turns `"2h"` into a number

**Symptom.** You author `timeout: "2h"` in YAML; after running it through the DSL
normalizer and re-uploading the JSON definition via the API, the plugin's config
validation rejects the value — the schema wants a string but it's now a number.

**Cause.** The `signal-wait` descriptor declares `timeout` as `type: 'string'`
with a duration `pattern`, but the DSL normalizer treats `timeout` as a
**duration field** and converts short forms like `"2h"` to integer milliseconds.
The normalized value (`7200000`) violates the plugin's string schema.

**Fix.** When uploading an already-normalized definition through the API, send
`timeout` as a **string** (e.g. `"2h"` or `"7200000"`), not the bare number the
normalizer produced. Authoring straight YAML is fine; the mismatch bites when
you round-trip through `normalize` then POST the JSON.

### Deploying via the API: normalize the YAML, then create + activate a NAMED alias

**Symptom.** You PUT a raw YAML-shaped object and the API rejects it, or you
save a definition and nothing triggers.

**Cause.** The REST API takes a JSON `IWorkflowDefinition`, not raw YAML, and
**activation is explicit** — saving a definition has zero side effects;
`latest` is auto-managed and triggers only register on **alias activation**
(core principle 4).

**Fix.** Normalize the YAML document to an `IWorkflowDefinition` first, POST/PUT
the definition, then create a named alias and activate it:

```ts
import { normalizeWorkflowDocument } from '@nullplatform/workflow-dsl';

const def = normalizeWorkflowDocument(parsedYamlDoc);   // YAML → IWorkflowDefinition
// POST/PUT /workflows/definitions with `def` (JSON)
// then create a NAMED alias (e.g. "prod") and activate it — `latest` is auto.
```

See the [REST API](../reference/rest-api.md) for the exact endpoints. (The
`np-workflow` CLI does all of this for you.)

---

## Plugins & Triggers

### Triggers MUST honor `handler.transient` in `start()`

**Symptom.** Single-replica works, but under multiple API replicas inbound
webhooks intermittently 503 with "trigger not started".

**Cause.** Webhook dispatch is **stateless**: the node handling an inbound
request is not necessarily the node that activated the trigger. The webhook
router builds a **transient** plugin instance per request, calls `start(handler)`
purely to hand the plugin its handler reference, then `destroy()`s it. The
handler is constructed with `transient: true`. If a trigger's `start()` performs
activation side-effects (registering/persisting webhook paths, creating external
resources), the transient lifecycle's `start()`/`destroy()` pair will delete the
**permanent** registration mid-flight and break every subsequent request.

**Fix.** In `start()`, check `handler.transient` and skip all activation
side-effects — just bind the handler and return:

```ts
async start(handler: ITriggerEventHandler): Promise<void> {
  this.handler = handler;
  if (handler.transient) return;        // per-request dispatch: no side effects
  // activation-only work below (register webhook paths, create NP channel, …)
  await handler.registerWebhookPath(/* … */);
}
```

(All the `np-*-trigger` plugins follow this; the router sets `transient: true`
on the per-request handler.)

### Workflow-sandbox code must stay deterministic and dependency-light

**Symptom.** Works under the local executor, but the hosted-runtime bundle fails
to build, or the workflow non-deterministically diverges on replay.

**Cause.** The hosted runtime runs the workflow **body** in a deterministic
sandbox. It must not import node-only modules (`node:async_hooks`, `ajv`, etc.)
or use non-deterministic host calls (`Date.now()`, `Math.random()`) inside the
workflow body. This is core principle 9.

**Fix.** Keep host I/O in **plugins** (which run as activities), and use the
deterministic helpers (`ctx.helpers.now/random/uuid`) or DSL primitives inside
the workflow body.

### `validateConfig()` runs before `execute()` — its errors don't reach `ctx.log`

**Symptom.** A plugin config error appears as a step log you didn't emit, and
your `ctx.log` calls in `execute()` never ran.

**Cause.** The engine calls `validateConfig()` **before** `execute()`. At that
point there is no execution context / `ctx.log`; the engine emits a **synthetic**
step log for the validation failure and never invokes `execute()`.

**Fix.** Don't rely on `ctx.log` for config problems — return precise,
user-readable messages from `validateConfig()`. Save `ctx.log` for runtime
diagnostics inside `execute()`.

---

## Platform / Runtime / Observability

### User-actionable failures must be a NON-retryable error, never an uncaught throw

**Symptom.** A bad input or validation error causes a workflow to retry forever,
and the shared runtime degrades for *every* workflow (poison-pill).

**Cause.** An uncaught throw inside the workflow body is treated as an
infrastructure fault and **retried indefinitely**. On a shared multi-tenant
runtime this poison-pills the task queue for everyone. The engine deliberately
wraps engine/graph errors as **non-retryable application failures** so they
surface once with an actionable message.

**Fix.** For anything the user must fix (bad config, validation, business-rule
rejection), raise a **non-retryable** failure with an informative `type` +
`message` (and, for graph errors, structured `issues`) — never let a raw
`Error`/`TypeError` escape the workflow body. That message is what the user
sees.

### `execution.error` surfaces the underlying cause, not "Workflow execution failed"

**Symptom.** You expected an opaque "Workflow execution failed" wrapper and were
going to dig through runtime logs.

**Cause / Fix.** Good news — you don't have to. The runtime unwraps the failure
`cause` and surfaces the **real** error `type` + `message`, and for a
`GraphValidationError` it stitches the structured `issues` into the message. So
`GET /executions/:id` shows the actionable error directly. Make your error
`type` + `message` informative — that's what the user sees.

### Stateless webhooks: any API replica can dispatch — deploy the runtime AND api from the SAME commit

**Symptom.** A workflow "passes submit" (create-time validation OK) but "fails
at runtime" with errors that make no sense for the definition you uploaded.

**Cause.** Webhooks are storage-routed: the webhook router looks up the
registration in shared storage and any API replica dispatches via the executor.
The actual graph validation + execution happens in the runtime sandbox. If the
runtime is executing stale code (older descriptors/engine) while the API is
newer, you get validate-at-create / fail-at-runtime skew — exactly the false
`CONNECTION_SOURCE_PORT_UNKNOWN` class above.

**Fix.** Deploy the **runtime and the api from the same commit**. Treat them as a
single release unit. When you see "passes submit, fails at runtime," suspect
version skew between api and runtime first.

---

## See also

- [Expressions](../concepts/expressions.md) — expression syntax & accessible scope roots.
- [Loops and Streaming](../concepts/loops-and-streaming.md) — streaming pagination, reentry ports, fan-out.
- [REST API](../reference/rest-api.md) — deploying & activating definitions.
