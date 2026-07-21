# YAML and DSL

Workflows can be authored in three formats that all compile to the same `IWorkflowDefinition` shape:

1. **YAML** -- declarative, human-readable, version-control friendly
2. **TypeScript DSL** -- programmatic, with type safety and IDE support
3. **JSON** -- what the API accepts and returns

## YAML Format

### Complete Example

```yaml
id: hello-http
name: Hello HTTP
description: |
  Simple 3-step example: fetch a public URL, log the response
  status, then store it in a variable.

metadata:
  author: workflow-system-demo
  tags: [example, http]

inputs:
  url:
    type: string
    description: URL to fetch
    default: "https://httpbin.org/get"

variables:
  statusCode:
    initialValue: 0

steps:
  - id: fetch
    type: module
    pluginType: http-request
    name: Fetch URL
    inputs:
      url: "${{ workflow.inputs.url }}"
      method: GET

  - id: log_status
    type: module
    pluginType: log
    name: Log status code
    inputs:
      message: "HTTP response status: ${{ steps.fetch.outputs.statusCode }}"
      level: info
    dependsOn: [fetch]

  - id: store_status
    type: module
    pluginType: set-variable
    name: Store status code
    inputs:
      name: statusCode
      value: "${{ steps.fetch.outputs.statusCode }}"
    dependsOn: [log_status]

connections:
  - {id: c1, from: fetch, to: log_status}
  - {id: c2, from: log_status, to: store_status}

outputs:
  statusCode: "${{ variables.statusCode }}"
  body: "${{ steps.fetch.outputs.body }}"
```

### YAML Field Reference

#### Top-Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Workflow identifier. Must be unique. |
| `name` | string | Yes | Human-readable name. |
| `description` | string | No | Markdown description. |
| `semanticVersion` | string | No | Semver string (e.g., `"1.0.0"`). |
| `metadata` | object | No | Free-form metadata (author, tags, etc.). |
| `inputs` | map | No | Workflow input declarations. |
| `variables` | map | No | Mutable workflow variables with initial values. |
| `triggers` | array | No | Trigger definitions. |
| `steps` | array/map | Yes | Step definitions (array with `id` fields or map keyed by id). |
| `connections` | array | Yes | Directed edges between steps. |
| `outputs` | map | No | Named output expressions resolved on completion. |

#### Input Declarations

```yaml
inputs:
  url:
    type: string              # string | number | integer | boolean | object | array
    description: "Target URL"
    required: true             # default: false
    default: "https://example.com"
    schema: {}                 # optional JSON Schema for validation
```

#### Variable Declarations

```yaml
variables:
  counter:
    type: number
    initialValue: 0
    description: "Running counter"
```

#### Step Definitions

```yaml
steps:
  - id: my_step                # Required. Must match [A-Za-z_][A-Za-z0-9_]*
    name: My Step              # Optional display name
    description: "Does stuff"  # Optional
    type: module               # module | decider | trigger | passthrough | subworkflow | wait
    pluginType: http-request   # Plugin name (required for module, decider, trigger)
    config:                    # Static configuration passed to plugin.configure()
      url: "https://api.example.com"
      method: GET
    inputs:                    # Runtime inputs (may contain expressions)
      url: "${{ workflow.inputs.url }}"
    dependsOn: [other_step]    # Shorthand for connections (generates them)
    joinStrategy: all          # all | any | allSettled | count
    joinCount: 2               # Only for joinStrategy: count
    condition: "steps.check.outputs.valid == true"  # Boolean expression gate
    timeout: "30s"             # Step timeout
    errorHandling:             # Error handling policy
      retryPolicy:
        maxRetries: 3
        backoff: exponential
        initialInterval: "1s"
```

**Important:** Step IDs must match `[A-Za-z_][A-Za-z0-9_]*`. Hyphens are forbidden because the expression evaluator parses them as subtraction. Use underscores instead.

#### Connection Definitions

```yaml
connections:
  - id: c1                     # Unique connection identifier
    from: step_a               # Source step ID
    to: step_b                 # Target step ID
    sourcePort: default        # Output port on source (default: 'default')
    targetPort: default        # Input port on target (default: 'default')
    condition: "steps.step_a.outputs.valid == true"  # Optional gate
    label: "On success"        # Optional display label
```

#### Trigger Definitions

```yaml
triggers:
  - id: webhook_trigger
    pluginType: webhook
    mode: start                # 'start' or 'signal'
    config:
      path: "my-endpoint"
      method: POST
    description: "Incoming webhook"
```

## TypeScript DSL

The DSL provides a fluent builder API with full type safety.

### Complete Example

```typescript
import { workflow } from '@nullplatform/workflow-dsl';

const def = workflow('hello-http', (wf) => {
  wf.name('Hello HTTP');
  wf.description('Simple 3-step example.');

  // Declare inputs and variables
  const url = wf.input('url', 'string', 'https://httpbin.org/get');
  const statusCode = wf.variable('statusCode', 0);

  // Define steps
  const fetch = wf.step('fetch', 'http-request', {
    url,
    method: 'GET',
  });

  const logStatus = wf.step('log_status', 'log', {
    message: wf.expr(`HTTP response status: \${steps.${fetch.id}.outputs.statusCode}`),
    level: 'info',
  });
  logStatus.dependsOn(fetch);

  const storeStatus = wf.step('store_status', 'set-variable', {
    name: 'statusCode',
    value: wf.expr(`steps.${fetch.id}.outputs.statusCode`),
  });
  storeStatus.dependsOn(logStatus);

  // Suppress unused-variable warnings
  void statusCode;
  void storeStatus;

  // Declare outputs
  wf.output('statusCode', wf.expr('variables.statusCode'));
  wf.output('body', wf.expr(`steps.${fetch.id}.outputs.body`));
}).build();

console.log(JSON.stringify(def, null, 2));
```

### DSL API

#### `workflow(id, builderFn)`

Creates a workflow builder and returns a chainable object with a `.build()` method.

#### Builder Methods

| Method | Description |
|--------|-------------|
| `wf.name(name)` | Set workflow name |
| `wf.description(desc)` | Set workflow description |
| `wf.input(name, type, defaultValue?)` | Declare a workflow input |
| `wf.variable(name, initialValue)` | Declare a mutable variable |
| `wf.step(id, pluginType, config)` | Add a module step |
| `wf.decider(id, pluginType, config)` | Add a decider step |
| `wf.trigger(id, pluginType, config)` | Add a trigger step |
| `wf.connect(from, to, options?)` | Add a connection |
| `wf.output(name, expression)` | Declare a workflow output |
| `wf.expr(expression)` | Create an expression string `${{ ... }}` |

#### Step Methods

| Method | Description |
|--------|-------------|
| `step.dependsOn(other)` | Add a dependency (generates a connection) |
| `step.id` | The step's string ID |

### Running DSL Scripts

```bash
npx tsx hello-http.ts
```

This prints the compiled `IWorkflowDefinition` as JSON.

## Round-Trip: YAML to JSON to DSL

All three formats produce the same `IWorkflowDefinition` object. The system supports:

- **YAML to JSON** -- Parse YAML, validate, produce `IWorkflowDefinition`
- **JSON to YAML** -- Serialize an `IWorkflowDefinition` back to YAML
- **DSL to JSON** -- Call `.build()` on the builder
- **JSON to API** -- POST to `/workflows/definitions`

### Example: Register a YAML Workflow

```bash
# Parse YAML to JSON and POST to the API
cat hello-http.yaml | yq -o json | \
  curl -X POST http://localhost:3000/workflows/definitions \
    -H "Content-Type: application/json" \
    -d @-
```

## Conditional Branching Example

```yaml
id: conditional_branch
name: Conditional Branch

steps:
  - id: start
    type: trigger
    pluginType: manual
    config: {}

  - id: check
    type: decider
    pluginType: conditional
    config:
      expression: "workflow.inputs.value > 10"
    dependsOn: [start]

  - id: high
    type: module
    pluginType: log
    config:
      level: info
      message: "Value is HIGH: ${{ workflow.inputs.value }}"

  - id: low
    type: module
    pluginType: log
    config:
      level: info
      message: "Value is LOW: ${{ workflow.inputs.value }}"

connections:
  - {id: c1, from: start, to: check}
  - {id: c2, from: check, to: high, sourcePort: "true"}
  - {id: c3, from: check, to: low, sourcePort: "false"}
```

## Signal Approval Example

```yaml
id: approval_flow
name: Approval Flow

steps:
  - id: start
    type: trigger
    pluginType: manual
    config: {}

  - id: request
    type: module
    pluginType: log
    config:
      level: info
      message: "Requesting approval..."
    dependsOn: [start]

  - id: wait
    type: module
    pluginType: signal-wait
    config:
      signalName: approval
      timeoutMs: 300000
    dependsOn: [request]

  - id: approved
    type: module
    pluginType: log
    config:
      level: info
      message: "Approved! Payload: ${{ signal.payload }}"
    dependsOn: [wait]

connections:
  - {id: c1, from: start, to: request}
  - {id: c2, from: request, to: wait}
  - {id: c3, from: wait, to: approved}
```
