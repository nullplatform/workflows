# Loops, Cycles, and Streaming Pagination

How to iterate over data in a workflow: the streaming-pagination pattern for bulk scanners, engine fan-out and `executeMode`, back-edge loops, and the `split-in-batches` / `forEach` / `sub-workflow` iteration mechanisms.

## Pick the Right Tool First

Most "iterate every X of Y" workflows fall into one of these patterns. Pick before you start wiring:

| Pattern | Use when… | Plugin |
|---|---|---|
| **Streaming pagination + accumulator** | You're paging through a data source and dispatching a sub-workflow per item, with a final aggregate. The canonical pattern for cost scanners and similar bulk operations. | See [Streaming Pagination Pattern](#streaming-pagination-pattern) below |
| **`forEach` on step** | You already have an array in scope and want per-item processing without spawning child executions. | step `forEach:` |
| **`split-in-batches`** | You need batched processing with explicit `loop`/`done` ports (custom batching strategies). | `split-in-batches` |
| **`sub-workflow` with `iterateItems`** | One-shot fan-out per item (no paging). | `sub-workflow` |
| **`loop.while` / `loop.forEach` on step** | Step-level polling or simple iteration. | step `loop:` |

The streaming-pagination pattern is wired explicitly out of four nodes (`paginated-fetch` + sub-workflow + `set-variable` accumulator + `code-exec` summary). It's verbose on purpose: the visual decomposition IS the documentation. The validator (`npx np-workflow validate`) catches the common wiring mistakes.

## Engine Fan-out and `executeMode`

When a step's upstream emits multiple items, the engine *may* invoke the plugin once per item (fan-out) or once with the whole batch in `$items` (join). Plugin descriptors declare the default; workflow authors can override per step.

### Plugin defaults

| Plugin | `executeMode` | Why |
|---|---|---|
| `code-exec`, `log`, `set-variable` | `'all'` | Aggregations are the common case; per-item code is opt-in. |
| `sub-workflow` | `'each'` (via `iterateItems: true`) | One child execution per item is almost always what you want. |
| `http-request` | `'each'` (default) | One request per item is usually correct. |
| Most others | `'each'` (default) | Engine fans out unless declared otherwise. |

### Per-step override

```yaml
- id: track
  type: module
  pluginType: code-exec
  metadata:
    fanOutPerItem: true     # forces per-item dispatch even though code-exec defaults to 'all'
  config:
    code: |
      var r = $item || {};
      return { ...r, processed: true };
```

`metadata.fanOutPerItem: false` does the inverse — suppresses fan-out for a plugin that would otherwise fan out.

### Single-producer rule

The engine only fans out when **a single upstream edge** contributes the items. If multiple incoming edges each carry items, that's treated as a join — the plugin gets one invocation with `$items` = concatenation of all upstream items. This is what makes re-entry loops work (the `start` step's `items` linger forever in the snapshot; without this rule, every callback would double-trigger fan-out).

### Per-item payload diet: `$items` is unavailable in fan-out

Per-item (fan-out) dispatch gives each invocation exactly `$item`, `$itemIndex`, and `$itemsLength` (the upstream batch size, as a number). **`$items` — the full upstream batch — is never shipped to a per-item invocation and cannot be resolved there.** Only a single dispatch that owns the whole batch (`executeMode: 'all'`, or `metadata.fanOutPerItem: false`) receives `$items`.

This isn't a convenience restriction — it's a hard payload-size limit. If the engine copied the *entire* upstream batch into `$items` for *every* per-item invocation, a fan-out over N items would ship O(N²) bytes in aggregate, and each per-item dispatch would carry a per-invocation payload that the runtime caps. In production a large page of items echoed back into every item's payload blew past that cap and terminated the run mid-sweep. Capping the page size only masks the bug (a small page stays under the cap) without fixing the O(N²) mechanism.

The fix is structural, not a size cap: `$items` simply doesn't exist in a per-item invocation's scope. Referencing it there is a design mistake, not a runtime edge case, so it's caught at graph-validation time (`FANOUT_ITEMS_UNAVAILABLE`, checked against every module step's `inputs`/`config` for a step that would dispatch per-item) — the same category of catch as the `$items`-collapse watch-out below, just enforced before the workflow can even be saved. A stale definition that predates this check (or a hand-crafted invocation) still fails loudly at runtime with the same message instead of silently resolving `$items` to nothing.

If a step genuinely needs the whole batch, that's what `executeMode: 'all'` (or `metadata.fanOutPerItem: false`) is for — see the [Streaming Pagination Pattern](#streaming-pagination-pattern) below, whose accumulator step relies on exactly this: `set-variable` defaults to `executeMode: 'all'`, so it runs once per page with the full page in `$items`, not once per item.

A plugin's `executeMode` reaches the fan-out decision through a pinned-descriptor snapshot stored on the definition (`IWorkflowDefinition.pinnedDescriptors`) at save time, because the in-sandbox runner has no live plugin registry to ask — only whatever was pinned into the definition. A revision saved before `executeMode` was added to the pin behaves exactly as it did before (fans out unless `metadata.fanOutPerItem: false` says otherwise); re-saving the workflow re-pins it with `executeMode` included.

### Watch-outs (the validator catches these)

- `code-exec` with `metadata.fanOutPerItem: true` *and* `$items` in its body — this is now a `FANOUT_ITEMS_UNAVAILABLE` graph-validation error (see above), not silent data loss.
- A `code-exec` summary connected to a `:done` port without `inputs:` reading from `variables.X` — streaming sources emit an empty envelope on `done`, so `$items` will always be `[]`.
- Re-entry loops (callback edges) without an accumulator (`set-variable` or equivalent) on the loop tail — per-iteration data won't survive the next re-fire.

## Streaming Pagination Pattern

The canonical wiring for "page through a data source, dispatch a sub-workflow per item, aggregate the results". Each of the four nodes is visible on the canvas — there's no hidden iteration logic to dig out of a JSON config.

```yaml
variables:
  app_results:
    initialValue: []

steps:
  # 1. Fetch one page per invocation (mode: stream).
  - id: fetch_applications
    type: module
    pluginType: np-entity-paginated-fetch
    config:
      entity: application
      filters: { namespace_id: "${{ workflow.inputs.namespace_id }}" }
      mode: stream

  # 2. Sub-workflow fans out per item (engine handles it because
  #    sub-workflow defaults to executeMode='each').
  - id: scan_application
    type: module
    pluginType: sub-workflow
    config: { workflowId: cost_action_items }
    inputs: { application_id: "${{ $item.id }}" }

  # 3. Accumulator: appends this page's results into a workflow variable.
  #    Runs once per page (set-variable defaults to executeMode='all').
  - id: acc_apps
    type: module
    pluginType: set-variable
    metadata: { flipPorts: true }
    config:
      path: app_results
      value: "${{ concat(variables.app_results, $items) }}"

  # 4. Summary reads the accumulator (NOT $items — the :done envelope is empty).
  - id: summary
    type: module
    pluginType: code-exec
    inputs:
      results: "${{ variables.app_results }}"
    config:
      code: |
        var items = inputs.results || [];
        return { apps_scanned: items.length };

connections:
  - { from: start,              to: fetch_applications }
  - { from: fetch_applications, to: scan_application,    sourcePort: loop }
  - { from: scan_application,   to: acc_apps }
  - { from: acc_apps,           to: fetch_applications,  targetPort: callback }   # back-edge
  - { from: fetch_applications, to: summary,             sourcePort: done }
```

Key invariants (the validator checks these — `npx np-workflow validate`):

1. **Items flow on `loop` every page, including the last** — `done` carries an empty terminal envelope only.
2. **The `summary` node connects to `:done` but reads from `variables.X`**, not from `$items`. The `:done` envelope is empty by design.
3. **The accumulator (`set-variable`) sits between scan and the back-edge** — without it, per-iteration data is lost when the loop re-fires.
4. **The `concat` builtin** in expressions is the canonical way to grow a list across iterations: `concat(variables.results, $items)`.

## Graph Cycles

The workflow system allows directed cycles in the graph (unlike pure DAG-based engines). This enables n8n-style loop patterns where a node's output connects back to an earlier node.

### Execution Model with Cycles

The runner uses an execution stack (not topological order):

1. Runner maintains a `nodeExecutionStack`.
2. After a node executes, the runner pushes downstream nodes onto the stack.
3. If a downstream node was already executed (back-edge), it is pushed again -- creating the loop.
4. Nodes with persistent state (like SplitInBatches) detect re-entry via their stored context.

### Loop Safety: MAX_NODE_EXECUTIONS

To prevent infinite loops, a global limit of **1000 executions per node** applies per workflow run. If any node exceeds this count, the execution fails with `LOOP_LIMIT_EXCEEDED`.

## SplitInBatches Plugin

The primary loop mechanism is the `split-in-batches` plugin. It splits input items into batches and iterates via back-connections, similar to n8n's SplitInBatches node.

### How It Works

The plugin has `executeMode: 'all'` and two output ports:
- **`loop`** -- emits the current batch for downstream processing
- **`done`** -- emits all processed items when iteration is complete

**Lifecycle:**

1. **First execution:** Stores all input items in `nodeContext.remaining`. Extracts the first batch. Outputs batch to `loop` port.
2. **Subsequent executions:** Pulls the next batch from `nodeContext.remaining`. Accumulates processed items in `nodeContext.processed`. Outputs batch to `loop` port.
3. **Final execution:** `nodeContext.remaining` is empty. Outputs all processed items to `done` port.

The `loop` port connects to downstream processing nodes, which eventually connect back to SplitInBatches (creating a cycle). On re-entry, SplitInBatches detects `nodeContext.remaining !== undefined` and continues from where it left off.

### Node Context (Persistent State)

SplitInBatches uses `nodeContext` -- a persistent key-value store scoped to a single node within a workflow execution. The context survives across re-executions of the same node within the same run, enabling stateful loop behavior.

### Example: Process Items in Batches

```yaml
id: split-in-batches-loop
name: SplitInBatches Loop Demo
description: |
  Generates 10 items, processes them in batches of 3 using a
  back-connection loop, then logs the final result.

steps:
  - id: start
    type: trigger
    pluginType: manual
    name: Manual Start

  - id: generate
    type: module
    pluginType: code-exec
    name: Generate 10 Items
    inputs:
      code: |
        return {
          items: Array.from({ length: 10 }, (_, i) => ({
            index: i,
            value: (i + 1) * 10,
            processed: false
          }))
        };
    dependsOn: [start]

  - id: splitter
    type: module
    pluginType: split-in-batches
    name: Split In Batches
    config:
      batchSize: 3
    dependsOn: [generate]

  - id: process_batch
    type: module
    pluginType: code-exec
    name: Process Batch
    inputs:
      code: |
        const items = inputs.items || [];
        return {
          items: items.map(item => ({
            ...item,
            processed: true,
            processedAt: new Date().toISOString()
          }))
        };
      items: "${{ steps.splitter.outputs.items }}"
    dependsOn: [splitter]

  - id: log_done
    type: module
    pluginType: log
    name: Log Done
    inputs:
      level: info
      message: "All batches processed"
    dependsOn: [splitter]

connections:
  - {id: c1, from: start, to: generate}
  - {id: c2, from: generate, to: splitter}
  - {id: c3, from: splitter, to: process_batch, sourcePort: loop}
  - {id: c4, from: process_batch, to: splitter}           # Back-edge: creates the loop
  - {id: c5, from: splitter, to: log_done, sourcePort: done}

outputs:
  totalProcessed: "${{ steps.splitter.outputs.items.length }}"
```

### Execution Flow Diagram

```
start -> generate -> splitter --[loop]--> process_batch
                        ^                       |
                        |                       |
                        +---------<back>--------+
                        |
                        +--[done]--> log_done
```

**Iteration sequence (batchSize: 3, 10 items):**

| Iteration | splitter receives | loop port emits | done port emits |
|-----------|-------------------|-----------------|-----------------|
| 1 | 10 items from generate | items 0-2 | (nothing) |
| 2 | 3 items from process_batch | items 3-5 | (nothing) |
| 3 | 3 items from process_batch | items 6-8 | (nothing) |
| 4 | 3 items from process_batch | item 9 | (nothing) |
| 5 | 1 item from process_batch | (nothing) | all 10 processed |

### SplitInBatches Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `batchSize` | number | 1 | Number of items per batch |
| `reset` | boolean | false | Reset iteration state on re-entry |

### SplitInBatches Outputs

| Field | Description |
|-------|-------------|
| `items` | Current batch items (loop) or all processed items (done) |
| `batchIndex` | Zero-based index of the current batch |
| `totalBatches` | Total number of batches |
| `done` | Boolean indicating if all batches are processed |

## forEach on Steps

Steps can declare a `forEach` configuration for per-item iteration without graph cycles:

```yaml
- id: process_each
  type: module
  pluginType: http-request
  forEach:
    expression: "steps.generate.outputs.items"   # Expression evaluating to an array
    itemVariable: "item"                          # Variable name for current item (default: 'item')
    indexVariable: "index"                        # Variable name for current index (default: 'index')
    parallel: true                                # Execute iterations in parallel (default: false)
    maxConcurrency: 5                             # Max concurrent iterations (default: 5)
  config:
    url: "${{ variables.item.url }}"
    method: GET
```

### forEach with Reduce

Sequential reduction (incompatible with `parallel: true`):

```yaml
- id: accumulate
  type: module
  pluginType: code-exec
  forEach:
    expression: "steps.generate.outputs.items"
    reduce:
      initialValue: 0
      accumulator: "acc"
  config:
    code: |
      return inputs.acc + inputs.item.value;
```

## Sub-Workflow Iteration

The `sub-workflow` plugin supports automatic array iteration:

```yaml
- id: process_users
  type: module
  pluginType: sub-workflow
  config:
    workflowId: "user-processor"
    iterateItems: true          # default: true (one child per input item)
    maxParallelism: 5           # max concurrent child executions (default: 5)
```

When `iterateItems: true`:
- Each input item triggers a separate child execution.
- Up to `maxParallelism` executions run concurrently.
- Output items are the collected results in order.

When `iterateItems: false`:
- A single child execution receives all items as `inputs.items`.
- Output is the child workflow's output items.

## Loop Configuration on Steps

Steps can also declare a `loop` configuration for while-based or forEach-based loops at the step level:

```yaml
- id: retry_step
  type: module
  pluginType: http-request
  loop:
    forEach: "steps.generate.outputs.urls"   # Iterable expression
    maxIterations: 100                        # Safety cap
    itemName: "currentUrl"                    # Context variable name
    indexName: "urlIndex"                     # Index variable name
  config:
    url: "${{ variables.currentUrl }}"
```

Or with a while condition:

```yaml
- id: poll_step
  type: module
  pluginType: http-request
  loop:
    while: "steps.poll_step.outputs.status != 'ready'"
    maxIterations: 50
  config:
    url: "https://api.example.com/status"
```

## Choosing a Loop Strategy

See the [Pick the Right Tool First](#pick-the-right-tool-first) table at the top of this page.

## Gotchas

- Reentry/back-edge loops deadlock under the default `all` join — the looped node needs `join_strategy: any`. See [Authoring Gotchas § Reentry/back-edge loops](../guides/gotchas.md#reentryback-edge-loops-the-looped-node-needs-join_strategy-any) and the surrounding join-semantics notes.
