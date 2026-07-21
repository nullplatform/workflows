# Expressions

## Syntax

Expressions are embedded in workflow definitions using the `${{ ... }}` delimiter:

```yaml
inputs:
  message: "Status code is ${{ steps.fetch.outputs.statusCode }}"
  url: "${{ workflow.inputs.baseUrl }}"
```

The expression engine supports two modes:

### Whole-Value Substitution

When the entire string is a single expression, the result retains its original type (number, boolean, object, array):

```yaml
value: "${{ steps.compute.outputs.count }}"  # Result is a number, not a string
```

### Embedded Substitution

When expressions are mixed with literal text, everything is concatenated as a string:

```yaml
message: "Found ${{ steps.compute.outputs.count }} items in ${{ variables.region }}"
# Result: "Found 42 items in us-east-1"
```

## Expression Roots

Expressions can access these top-level namespaces:

### `workflow.inputs`

The workflow's input values, provided at execution start.

```yaml
url: "${{ workflow.inputs.baseUrl }}"
count: "${{ workflow.inputs.limit }}"
```

### `variables`

Mutable workflow variables. Updated by the `set-variable` plugin or DSL. Available as both `${{ variables.X }}` and `${{ workflow.variables.X }}`.

```yaml
current: "${{ variables.counter }}"
```

### `steps`

Outputs from completed steps, keyed by step ID.

```yaml
# Access the first item's field (backward-compatible shorthand)
code: "${{ steps.fetch.outputs.statusCode }}"
body: "${{ steps.fetch.outputs.body }}"

# Access specific items
first_name: "${{ steps.generate.items[0].name }}"
all_items: "${{ steps.generate.items }}"

# Access step metadata
status: "${{ steps.fetch.outputs.status }}"
```

### `execution`

Execution-level metadata.

```yaml
exec_id: "${{ execution.id }}"
workflow_id: "${{ execution.workflowId }}"
revision: "${{ execution.revision }}"
started_at: "${{ execution.startedAt }}"
correlation_key: "${{ execution.correlationKey }}"
organization_id: "${{ execution.organizationId }}"
```

### `signal`

The most recently resolved signal payload. Only available for the step immediately following a `waitForSignal` resumption.

```yaml
approved: "${{ signal.payload.approved }}"
signal_name: "${{ signal.name }}"
delivered_at: "${{ signal.deliveredAt }}"
```

### `trigger`

Trigger context, present only for trigger-initiated executions.

```yaml
source: "${{ trigger.source }}"
payload: "${{ trigger.payload }}"
received_at: "${{ trigger.receivedAt }}"
webhook_body: "${{ trigger.payload.body }}"
```

## Items Expressions

The items model adds these expression variables:

| Expression | Resolves To | Available In |
|------------|-------------|--------------|
| `$item` | Current item object | `each` mode |
| `$item.fieldName` | Field from current item | `each` mode |
| `$items` | Full input items array | Both modes |
| `$items.length` | Item count | Both modes |
| `$itemIndex` | Current item index (0-based) | `each` mode |
| `steps.X.items` | Output items array from step X | Both modes |
| `steps.X.items[0].field` | Specific item field from step X | Both modes |

### Examples

```yaml
# Access current item (in 'each' mode)
greeting: "${{ 'Hello ' + $item.name }}"

# Access items from a specific step
first_user: "${{ steps.generate.items[0].name }}"
item_count: "${{ steps.generate.items.length }}"

# Backward-compatible (alias for items[0])
status: "${{ steps.fetch.outputs.statusCode }}"
```

## Operators

The expression evaluator supports standard operators:

### Arithmetic
- `+` (addition / string concatenation)
- `-` (subtraction)
- `*` (multiplication)
- `/` (division)
- `%` (modulo)

### Comparison
- `==` (equality)
- `!=` (inequality)
- `>`, `>=`, `<`, `<=`

### Logical
- `&&` (logical AND)
- `||` (logical OR)
- `!` (logical NOT)

### Member Access
- `.` (property access: `steps.fetch.outputs.body`)
- `[]` (index access: `steps.generate.items[0]`)

### Ternary
- `condition ? valueIfTrue : valueIfFalse`

## Truthiness Rules

The expression evaluator's truthiness rules (used by the `conditional` plugin and `condition` gates):

| Value | Truthy? |
|-------|---------|
| `null` | No |
| `undefined` | No |
| `false` | No |
| `0` | No |
| `NaN` | No |
| `""` (empty string) | No |
| `[]` (empty array) | **Yes** |
| `{}` (empty object) | **Yes** |
| Everything else | Yes |

Empty arrays and empty objects are truthy (matching JavaScript semantics). Use explicit comparisons for collection-content checks: `steps.X.items.length > 0`.

## Built-in Functions

Note: the expression evaluator ships a small set of built-in functions. Common functions include:

- `len(array)` -- array length
- String operations accessible via property access (`.length`, `.trim()`, etc.)

## Expression Examples

### Simple field access
```yaml
url: "${{ workflow.inputs.apiUrl }}"
```

### String concatenation
```yaml
message: "User ${{ steps.lookup.outputs.name }} has score ${{ steps.lookup.outputs.score }}"
```

### Conditional expression
```yaml
label: "${{ steps.check.outputs.score > 80 ? 'pass' : 'fail' }}"
```

### Cross-step data access
```yaml
# Step 1 produces { value: 100 }
# Step 2 reads it
prev: "${{ steps.step1.outputs.value }}"

# Step 2 produces { doubled: 200 }
# Step 3 reads it
result: "${{ steps.step2.outputs.doubled }}"
```

### Conditional branching
```yaml
- id: check
  type: decider
  pluginType: conditional
  config:
    expression: "steps.fetch.outputs.statusCode == 200"
```

### Nested property access
```yaml
city: "${{ steps.fetch.outputs.body.address.city }}"
first_item: "${{ steps.list.outputs.items[0].name }}"
```

## Common Patterns

### Pass workflow input to a step
```yaml
inputs:
  url: "${{ workflow.inputs.targetUrl }}"
```

### Chain step outputs
```yaml
# Step B reads from Step A
inputs:
  data: "${{ steps.stepA.outputs.result }}"
```

### Use signal payload after wait
```yaml
# After a signal-wait step
inputs:
  approved: "${{ signal.payload.approved }}"
  reviewer: "${{ signal.payload.reviewerName }}"
```

### Conditional connection
```yaml
connections:
  - id: c1
    from: process
    to: notify
    condition: "steps.process.outputs.changed == true"
```

## Common pitfalls

- Bare `inputs.X` is the **step's** resolved inputs, not workflow inputs (use `workflow.inputs.X`); and the parser has **no array/object literals** (lift arrays into `variables`). See [Authoring Gotchas § Workflow YAML](../guides/gotchas.md#workflow-yaml).
