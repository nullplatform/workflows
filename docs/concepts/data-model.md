# Data Model

How data moves through a workflow: every step receives and emits arrays of items, and `executeMode` decides whether a plugin sees one item at a time or the whole batch.

## The Items Model

The workflow system uses an n8n-style data flow where every node receives and emits arrays of **items**. An item is a plain key-value object:

```typescript
type WorkflowItem = Record<string, unknown>;
```

There is no wrapper object. Binaries are regular fields (e.g., `{ content: "base64...", mimeType: "application/pdf" }`).

### Step Outputs

When a step completes, its outputs are stored as:

```typescript
interface IStepOutputs {
  status: StepStatus;
  items: WorkflowItem[];          // Array of output items
  outputs: Record<string, unknown>; // Backward compat: alias for items[0] ?? {}
  activePorts?: readonly string[];
  error?: { message: string; code?: string; retryable?: boolean };
  inputs?: Record<string, unknown>;
  startedAt: string;
  completedAt?: string;
  iterationIndex?: number;
}
```

The `items` field is the canonical output. The `outputs` field is a backward-compatible shorthand that always equals `items[0] ?? {}`. This means existing expressions like `${{ steps.X.outputs.Y }}` continue to work as a shorthand for `${{ steps.X.items[0].Y }}`.

## How Data Flows Between Steps

When step B has an incoming connection from step A:

1. The engine reads `context.steps['A'].items` -- the array of output items from step A.
2. If step B has multiple incoming connections (join), items are merged according to the join strategy.
3. The items array becomes step B's input.
4. Step B processes them (per-item or all-at-once, depending on `executeMode`).
5. Step B's output items are stored in `context.steps['B'].items`.

```
Step A                    Step B                    Step C
+--------+              +--------+               +--------+
| items: |  connection  | items: |  connection   | items: |
| [{a:1}]| ----------> | [{b:2}]| ----------->  | [{c:3}]|
| [{a:2}]|              | [{b:3}]|               | [{c:4}]|
+--------+              +--------+               +--------+
```

## executeMode: 'each' vs 'all'

Plugins declare an `executeMode` in their descriptor that controls how the engine invokes them.

### Per-Item Mode (`executeMode: 'each'` -- default)

The engine calls `execute()` once per input item. The plugin sees a single item's data in `ctx.inputs` and returns outputs for that item. The engine collects results into the output array.

```
Input: items = [{name: "Alice"}, {name: "Bob"}, {name: "Charlie"}]

Engine loops:
  i=0: ctx.inputs = {name: "Alice"},   ctx.itemIndex = 0 -> {greeting: "Hi Alice"}
  i=1: ctx.inputs = {name: "Bob"},     ctx.itemIndex = 1 -> {greeting: "Hi Bob"}
  i=2: ctx.inputs = {name: "Charlie"}, ctx.itemIndex = 2 -> {greeting: "Hi Charlie"}

Output: items = [{greeting: "Hi Alice"}, {greeting: "Hi Bob"}, {greeting: "Hi Charlie"}]
```

Most plugins use this mode. The plugin code is simple because it only handles one item at a time:

```typescript
async execute(ctx: IStepExecutionContext): Promise<IStepResult> {
  const url = ctx.inputs.url as string;
  const resp = await fetch(url);
  return { status: 'success', outputs: { body: await resp.json() } };
}
```

If this step receives 5 items with different `url` values, `execute()` is called 5 times.

### All-Items Mode (`executeMode: 'all'`)

The engine calls `execute()` once with all items. The plugin receives `ctx.items` (the full array) and returns an array.

```
Input: items = [{score: 10}, {score: 20}, {score: 30}]

Engine calls once:
  ctx.items = [{score: 10}, {score: 20}, {score: 30}]
  Plugin returns: items = [{total: 60, avg: 20}]

Output: items = [{total: 60, avg: 20}]
```

Use this mode for aggregation, batching, and loop control nodes:

```typescript
async execute(ctx: IStepExecutionContext): Promise<IStepResult> {
  const allItems = ctx.items;
  const total = allItems.reduce((sum, item) => sum + (item.value as number), 0);
  return { status: 'success', items: [{ total, count: allItems.length }] };
}
```

Plugins that use `executeMode: 'all'` include `split-in-batches`, `paginated-fetch`, and any custom aggregation nodes.

## IStepExecutionContext

The execution context passed to plugins carries item-related fields:

```typescript
interface IStepExecutionContext {
  // For executeMode 'each' -- single item data (current item)
  readonly inputs: Record<string, unknown>;

  // For executeMode 'all' -- all input items
  readonly items: ReadonlyArray<Record<string, unknown>>;

  // Index of current item (0-based). Only meaningful in 'each' mode.
  readonly itemIndex: number;

  // Total number of input items.
  readonly itemCount: number;

  // Read-only snapshot of the workflow context
  readonly workflowContext: IWorkflowContextSnapshot;

  // Step and execution identifiers
  readonly stepId: string;
  readonly executionId: string;
  readonly workflowId: string;
  readonly revision: number;

  // Deterministic helpers
  readonly helpers: IStepHelpers;
  readonly log: IStepLogger;
  readonly secrets: ISecretAccessor;
  readonly signal: AbortSignal;
}
```

## IStepResult

Plugins return an `IStepResult` that the engine uses to update context:

```typescript
interface IStepResult {
  readonly status: 'success' | 'failure' | 'skipped';

  // Single item outputs (executeMode 'each')
  readonly outputs?: Record<string, unknown>;

  // Array of items (executeMode 'all', or when producing multiple items)
  readonly items?: ReadonlyArray<Record<string, unknown>>;

  readonly error?: IStepError;
  readonly activePorts?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}
```

When only `outputs` is set, the engine wraps it as `[outputs]`. When `items` is set, it takes precedence.

## Expression Access to Items

Expressions can access items data from upstream steps:

| Expression | Description | Available In |
|------------|-------------|--------------|
| `$item` | Current item object | `each` mode |
| `$item.fieldName` | Field from current item | `each` mode |
| `$items` | Full input items array | Both modes |
| `$items.length` | Item count | Both modes |
| `$itemIndex` | Current item index (0-based) | `each` mode |
| `steps.X.items` | Output items from step X | Both modes |
| `steps.X.items[0].field` | Specific field from step X | Both modes |
| `steps.X.outputs.Y` | Shorthand for `steps.X.items[0].Y` | Both modes |

### Backward Compatibility

`${{ steps.X.outputs.Y }}` continues to work as a shorthand for `${{ steps.X.items[0].Y }}`. Workflows with single-item steps work unchanged.

## Decider Per-Item Routing

Decider plugins in `each` mode evaluate per-item and route each item to a port:

```typescript
async evaluate(ctx: IStepExecutionContext): Promise<IDeciderResult> {
  const value = ctx.inputs.value as number;
  return {
    activePorts: value > 10 ? ['true'] : ['false'],
    outputs: ctx.inputs,
  };
}
```

The engine collects items per port. Items routed to `true` flow through the `true` connection; items routed to `false` flow through the `false` connection.

```
Input: [{value: 5}, {value: 15}, {value: 8}, {value: 20}]

Conditional (value > 10):
  'true'  port: [{value: 15}, {value: 20}]
  'false' port: [{value: 5}, {value: 8}]
```

## Join Strategies

When a step has multiple incoming connections, the join strategy controls when it fires:

| Strategy | Behavior |
|----------|----------|
| `all` (default) | Wait for every predecessor to complete |
| `any` | Execute on the first predecessor to complete |
| `allSettled` | Wait for all regardless of success/failure |
| `count` | Wait for at least N predecessors (via `joinCount`) |

When items arrive from multiple predecessors, they are merged (concatenated) into the input array.

## Example: Multi-Step Item Flow

```yaml
steps:
  - id: generate
    type: module
    pluginType: code-exec
    name: Generate Users
    config:
      code: |
        return {
          items: [
            {name: "Alice", age: 30},
            {name: "Bob", age: 25},
            {name: "Charlie", age: 35}
          ]
        };

  - id: transform
    type: module
    pluginType: code-exec
    name: Add Greeting
    inputs:
      users: "${{ steps.generate.outputs.items }}"
    config:
      code: |
        const users = inputs.users || [];
        return {
          items: users.map(u => ({
            ...u,
            greeting: "Hello " + u.name
          }))
        };
    dependsOn: [generate]

connections:
  - {id: c1, from: generate, to: transform}
```
