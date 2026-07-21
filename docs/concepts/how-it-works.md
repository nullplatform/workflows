# How the workflow system works

The mental model in one page: what a workflow IS, how it gets a version, how
it starts running, and what you can observe while it runs.

## Definitions: a graph of steps

A workflow definition is a directed graph:

- **Steps** are nodes. Each step runs a **plugin** (`plugin_type:`) with a
  `config:` block (the node's own fields, resolved with `${{ … }}`
  expressions) and optional declared `inputs:` (data handed to the step).
- **Connections** are edges. Each edge leaves a step through an **output
  port** (`default` unless the plugin declares more — deciders route through
  author-defined ports) and enters the next step's input port.
- **Data flows as arrays of items.** Every step receives `items[]` and emits
  `items[]`; `outputs` is shorthand for `items[0]`. Fan-out over items is an
  engine concern (`executeMode`, `forEach`), not plugin code.
- A step with several incoming edges has a **join strategy** (`all`, `any`,
  `allSettled`, `count`) deciding when it becomes ready. Cycles are allowed
  (loops are real edges back into a re-entry port), with a hard per-node
  execution cap as a runaway guard.

Authoring is YAML (see [reference/yaml.md](../reference/yaml.md)); the API
stores the normalized JSON form. Validation happens when you save AND again
at runtime with the same knowledge — a definition that saves cleanly runs
cleanly.

## Revisions are immutable, aliases are mutable

Every save creates a **new revision** (N+1). Revisions are never edited or
deleted — an execution always points at the exact revision it ran.

**Aliases** are named pointers to revisions (`live`, `staging`, …). `latest`
is automatic and always tracks the highest revision. Deploying a workflow
means repointing an alias — and rolling back means pointing it back.

## Activation is explicit — saving has zero side effects

Saving a definition never touches the outside world. **Triggers (crons,
webhooks, event subscriptions) register only when you ACTIVATE an alias**,
and deactivating removes them atomically. This is what makes uploading and
iterating safe: nothing fires until you say so.

```
upload definition  →  revision N        (no side effects)
alias "live" → N                        (still no side effects)
activate "live"    →  crons scheduled, webhook URLs minted, events wired
```

## Executions

`POST /workflows/definitions/:id/execute` (or a trigger firing) creates an
**execution** of one revision. The engine walks the graph: resolves each
ready step's expressions, dispatches its plugin, routes the result's active
ports, joins, loops, fans out. Terminal states: `completed`, `failed`,
`cancelled`.

Retried starts stay safe with an **idempotency key**: pass
`"idempotencyKey": "<unique-per-logical-event>"` and the engine guarantees
one execution per `(workflow, key)` — the first call creates it, repeats
return the same execution marked `deduplicated`.

While it runs (and after), everything is observable:

- `GET /workflows/executions/:id/state` — live per-step status, outputs,
  variables. Same shape on every runtime.
- `GET /workflows/executions/:id/logs` — step logs, including plugin
  `ctx.log` output.
- Failures carry the REAL cause on `execution.error` (plugin error codes,
  graph-validation issues) — never an opaque "failed".

## Where state lives

| You need to remember… | Use | Lifetime |
|---|---|---|
| A value across steps of one run | `variables` (+ `set-variable`) | the execution |
| Loop/iteration state of one node | `nodeContext` (plugin-internal) | the execution |
| Durable state on a platform entity | catalog metadata instance | forever |
| Work items with lifecycle + UI | governance action items | until closed |
| Org/folder config and credentials | config entries (`${{ secrets.* }}` / `${{ vars.* }}`) | until changed |

The system deliberately has no user tables — production suites compose these
primitives (see the cost suite for the full pattern, and
[config-entries.md](./config-entries.md) for scoping rules).

## Pauses are signals — one primitive

Anything that waits (an approval, a webhook callback, a nightly window, a
human answering on a thread) waits on a **signal**. Waiting parks the
execution durably — no compute burns while parked, and waits survive
restarts. See [signals-and-waits.md](./signals-and-waits.md).

## Local and hosted are the same engine

The `@nullplatform/workflow-kit` runs your workflow on the same engine code
and validates with the same rules as the hosted platform — what passes
`np-workflow validate` and your local tests is what runs hosted. The test
harness stubs plugins (the I/O edge), never the engine.
