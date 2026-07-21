# Built-in Plugins

A conceptual overview of the built-in plugin families. For the complete, always-current inventory of every shipped plugin with its config schema, see the [Plugin Catalog](./plugin-catalog.md).

The system ships with built-in plugins registered by the engine. They are grouped by category below. Most plugins declare an `executeMode` (`'each'` or `'all'`) that controls whether the engine fans them out per upstream item — see [Loops and Streaming § Engine fan-out and `executeMode`](../concepts/loops-and-streaming.md#engine-fan-out-and-executemode) for the rules.

## Control Flow

### log
**module** | control-flow -- Emit a structured log entry. Never fails the step.
```yaml
config: { level: info, message: "Status: ${{ steps.fetch.outputs.statusCode }}" }
```
**Outputs:** `{ level, message, timestamp }`

---

### no-op
**module** | utility -- Do nothing; pass inputs through as outputs. Useful as a placeholder.

---

### delay
**module** | control-flow -- Wait for a duration using the signal wait mechanism.
```yaml
config: { duration: "30s" }  # '500ms', '30s', '5m', '2h', '1d' (max 30 days)
```

---

### conditional
**decider** | control-flow -- Branches on a boolean expression. Activates `true` or `false` port.
```yaml
config: { expression: "steps.fetch.outputs.statusCode == 200" }
```
Wire branches with `sourcePort`:
```yaml
connections:
  - {id: c1, from: check, to: success_step, sourcePort: "true"}
  - {id: c2, from: check, to: failure_step, sourcePort: "false"}
```
**Outputs:** `{ matchedPort, result }`

---

### fail
**module** | control-flow -- Terminates the workflow with an error.
```yaml
config: { message: "Validation failed", code: "VALIDATION_ERROR" }
```

---

### set-variable
**module** | data -- Set a workflow variable under `variables.*`.
```yaml
inputs: { name: statusCode, value: "${{ steps.fetch.outputs.statusCode }}" }
```

---

### split-in-batches
**module** (`executeMode: 'all'`) | control-flow -- Splits items into batches for loop processing. Two output ports: `loop` (current batch) and `done` (all processed). See [Loops and Streaming](../concepts/loops-and-streaming.md).
```yaml
config: { batchSize: 3, reset: false }
```

---

### sub-workflow
**module** | control-flow -- Invoke a child workflow. Supports item iteration with configurable parallelism.
```yaml
config:
  workflowId: "user-lookup"
  alias: "production"       # default: 'latest'
  waitForCompletion: true   # default: true
  iterateItems: true        # default: true (one child per item)
  maxParallelism: 5         # default: 5
```

---

### manual (trigger)
**trigger** | control-flow -- Manual start trigger. Marks the workflow as startable via API or UI.
```yaml
- id: start
  type: trigger
  pluginType: manual
  config: {}
```

---

### on-error (trigger)
**trigger** | control-flow -- Triggers when a workflow step or execution fails.
```yaml
config: { scope: "step" }  # 'step' or 'workflow'
```

Both `on-error` and [`execution-failed-trigger`](./plugin-catalog.md#execution-failed-trigger)
are dispatched **storage-routed**, exactly like inbound webhooks. When an
execution fails, the executor invokes an `onExecutionFailed` hook wired to the
`FailureDispatcher`, which scans the active aliases of the failed execution's
organization (via `listActiveAliases(orgId)` — the same absolute org-isolation
boundary the rest of the system uses) and fires each failure trigger through a
**transient** plugin instance. This is why the trigger fires even when the
replica that observed the failure is not the one that activated the alias — and
why it still fires when the awaiter process restarted and the
`reconcileExecution` backstop is the only observer of the failure.

Every recovery execution is started with `idempotencyKey =
"onerror:<failedExecutionId>"`. Two roles:

- **Dedupe.** Two observers of the same failure (the live awaiter *and* the
  reconciler, or two replicas) collapse to **one** recovery execution per handler
  workflow at the storage unique constraint. The in-process single-node bus path
  stamps the same key, so a deployment running both mechanisms never
  double-dispatches.
- **Cascade guard.** A recovery run that itself fails carries an `onerror:`
  idempotencyKey; the dispatcher refuses to re-dispatch it, so an always-failing
  handler cannot loop forever (single level only).

## Integration

### http-request

| Field | Value |
|-------|-------|
| **Type** | module |
| **Category** | integration |
| **Description** | Make an HTTP request. |

Full-featured HTTP client using undici. Supports all HTTP methods, custom headers, body encoding, timeouts, SSL verification, and redirect following.

```yaml
- id: fetch
  type: module
  pluginType: http-request
  config:
    url: "https://api.example.com/data"
    method: GET                    # GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS
    headers:
      Authorization: "Bearer ${{ secrets.api_token }}"
    body:                           # auto JSON-encoded for objects
      key: value
    timeout: "30s"                  # duration string or milliseconds
    followRedirects: true           # default: true
    verifySsl: true                 # default: true
```

**Outputs:** `{ statusCode, statusText, headers, body }`

**Error codes:** `HTTP_INVALID_URL`, `HTTP_TIMEOUT`, `HTTP_NETWORK_ERROR`, `HTTP_4XX`, `HTTP_5XX`

---

### paginated-fetch

| Field | Value |
|-------|-------|
| **Type** | module |
| **Category** | integration |
| **Description** | Fetches all pages from a paginated API. |

Iterates through a paginated API collecting all items until there are no more pages or `maxPages` is reached.

```yaml
- id: fetch_all
  type: module
  pluginType: paginated-fetch
  config:
    url: "https://api.example.com/users"
    method: GET
    pageParam: page              # query param for page number (default: 'page')
    limitParam: limit            # query param for page size (default: 'limit')
    limit: 50                    # items per page (default: 50)
    dataPath: data               # path to items array in response (default: 'data')
    hasMorePath: hasMore         # path to "has more" flag (default: 'hasMore')
    maxPages: 100                # safety limit (default: 100)
    headers:
      Authorization: "Bearer token"
```

**Outputs:** `{ items, totalFetched, pages }`

---

### webhook (trigger)

| Field | Value |
|-------|-------|
| **Type** | trigger |
| **Category** | integration |
| **Description** | HTTP webhook trigger. |

Registers an HTTP endpoint that starts or signals executions when called.

```yaml
- id: webhook
  type: trigger
  pluginType: webhook
  config:
    path: "my-webhook"          # registered at /workflows/webhooks/my-webhook
    method: POST                # POST, GET, PUT, or ANY
```

---

### webhook-wait

| Field | Value |
|-------|-------|
| **Type** | module |
| **Category** | integration |
| **Description** | Wait for an HTTP callback. |
| **Capabilities** | `awaits-signal`, `awaits-webhook` |

Pauses execution and generates a one-time callback URL. Resumes when the URL receives a POST.

```yaml
- id: wait_callback
  type: module
  pluginType: webhook-wait
  config:
    timeout: "24h"
    onTimeout: "continue"       # 'continue' or 'error'
```

**Outputs:** `{ waitUrl, body, headers, receivedAt }`

**Output ports:** `default`, `timeout`

**How to use in production:**

1. A step BEFORE the wait constructs the signal URL using `${{ execution.id }}` and sends it somewhere (email, Slack, ticket system)
2. The wait step pauses the workflow
3. An external system POSTs to the signal URL to resume
4. The frontend shows the signal info and curl command when the step is waiting

**Sending the signal:**
```bash
POST /workflows/executions/{execId}/signals/{signalName}
Content-Type: application/json
{"payload": {...}, "correlationKey": "{correlationKey}"}
```

## Signals

### signal-wait

| Field | Value |
|-------|-------|
| **Type** | module |
| **Category** | control-flow |
| **Description** | Wait for a named signal. |
| **Capabilities** | `awaits-signal` |

Pauses execution until a signal with the specified name is delivered to this execution.

```yaml
- id: wait_approval
  type: module
  pluginType: signal-wait
  config:
    signalName: "approval"          # or array: ["approve", "reject"]
    correlationKey: "${{ execution.correlationKey }}"  # optional
    timeout: "24h"                  # optional duration
    onTimeout: "continue"           # 'continue' or 'error'
```

Deliver the signal via the API:

```bash
curl -X POST http://localhost:3000/workflows/executions/<id>/signals/approval \
  -H "Content-Type: application/json" \
  -d '{"payload": {"approved": true}}'
```

**Outputs:** The signal payload

**Output ports:** `default`, `timeout`

## Scheduling

### cron (trigger)

| Field | Value |
|-------|-------|
| **Type** | trigger |
| **Category** | scheduling |
| **Description** | Cron schedule trigger. |

Starts executions on a cron schedule.

```yaml
- id: schedule
  type: trigger
  pluginType: cron
  config:
    schedule: "0 2 * * *"          # 5- or 6-field cron expression
    timezone: "America/New_York"   # IANA timezone (default: UTC)
```

**Where the schedule actually runs depends on the executor:**

- **Hosted runtime (production):** activation creates a **durable schedule**
  that survives API redeploys and fires exactly once cluster-wide. Each tick
  starts a small workflow that re-enters the engine via
  `POST /definitions/:id/execute` presenting a **trigger-fire token** (minted at
  activation, scoped to that one workflow+alias+org). Deactivating the alias
  deletes the schedule.
- **Local executor (dev, single process):** an in-process timer, exactly as
  before. Nothing durable — dev is one process.

Every fire carries `idempotencyKey: cron:<triggerId>:<tick>` (tick floored
to the second), so a duplicated fire — schedule replaced mid-tick, retry
after a timeout — collapses into ONE execution at the storage
idempotency constraint. The execution's inputs are
`{ firedAt: <tick ISO>, schedule: "<expression>" }`.

> Note: on the hosted runtime the cron expression must be one the hosted
> scheduler accepts (standard 5-field plus `@every`-style macros). An
> unsupported expression fails **at activation** — loudly, not silently.

## Transform

### code-exec

| Field | Value |
|-------|-------|
| **Type** | module |
| **Category** | transform |
| **Description** | Runs inline JavaScript to transform inputs into outputs. |

Evaluates JavaScript (or TypeScript) inside a sandbox. The code must return an object; arrays and primitives are wrapped as `{ result: <value> }`; `undefined` becomes `{}`.

#### Sandbox globals

| Global | What it is | Notes |
|---|---|---|
| `inputs` | Frozen copy of the step's resolved inputs | Use `inputs.xxx` to read resolved expression values. |
| `log.debug(msg, meta?)` / `log.info(msg, meta?)` / `log.warn(msg, meta?)` / `log.error(msg, meta?)` | Structured logger | Entries appear in the execution's **LOG tab**. `meta` must be a plain object. |
| `console.log(...args)` / `.info` / `.warn` / `.error` / `.debug` | Familiar `console` shim | Routes to the step logger. `console.log` is an alias for `log.info`. Multi-arg calls are joined with spaces. |
| `JSON`, `Math`, `Promise`, `Date`, `Array`, `Object`, … | Standard ECMAScript built-ins | Available unchanged. |

**Not available** (for determinism/replay safety — principle 9): `require`, `process`, `fs`, `fetch`, `setTimeout`, `setInterval`, `Buffer`, `globalThis.crypto`. `Date.now()` and `Math.random()` are available but using them makes the step non-replayable. For timestamps/random values prefer expression-resolved inputs or dedicated plugins.

```yaml
- id: transform
  type: module
  pluginType: code-exec
  config:
    code: |
      const items = inputs.data || [];
      log.info('processing batch', { size: items.length });
      console.log('first item:', items[0]);
      return {
        total: items.reduce((sum, i) => sum + i.value, 0),
        count: items.length,
      };
    language: javascript           # 'javascript' (default) or 'typescript'
    executionConfig:                # optional resource limits
      timeoutMs: 5000
      maxMemoryMb: 128
```

Every `log.*` and `console.*` call above appears in the LOG tab next to the step exactly as if you had written `ctx.log.*` from a module plugin.

**Error codes:** `SANDBOX_TIMEOUT`, `SANDBOX_MEMORY`, `SANDBOX_RUNTIME`, `SANDBOX_NOT_AVAILABLE`

## AI

### agent

| Field | Value |
|-------|-------|
| **Type** | module |
| **Category** | ai |
| **Description** | Run an LLM agent with a reasoning loop. |

Executes a reasoning loop: builds a prompt, invokes a model, handles tool calls, and returns structured output conforming to a declared JSON Schema.

```yaml
- id: analyze
  type: module
  pluginType: agent
  config:
    model: "anthropic:claude-opus-4-7"    # optional, defaults to descriptor default
    systemPrompt: "You are a helpful assistant."
    userPrompt: "Analyze this data: ${{ steps.fetch.outputs.body }}"
    outputSchema:
      type: object
      required: [summary, score]
      properties:
        summary: { type: string }
        score: { type: number }
    maxIterations: 10
    toolsEnabled: []               # tool allow-list (omit for all)
    temperature: 0.7
```

**Supported models:** `anthropic:claude-opus-4-7`, `anthropic:claude-sonnet-4-6`, `anthropic:claude-haiku-4-5`

**Error codes:** `AGENT_MAX_ITERATIONS`, `AGENT_TOKEN_BUDGET_EXCEEDED`, `AGENT_OUTPUT_SCHEMA_ERROR`, `AGENT_LLM_ERROR`

## nullplatform

### np-agent-command

| Field | Value |
|-------|-------|
| **Type** | module |
| **Category** | nullplatform |
| **Description** | Executes an agent command via the nullplatform Agent Command Execute API. |

Sends a command to a nullplatform agent and optionally polls for completion.

```yaml
- id: run_command
  type: module
  pluginType: np-agent-command
  config:
    apiBaseUrl: "https://api.nullplatform.com"
    command: "kubectl-apply"
    agentId: "agent-123"
    parameters:
      namespace: "production"
    waitForCompletion: true
    timeoutMs: 300000
```

**Outputs:** `{ commandId, status, result, logs }`

---

### np-action-item

| Field | Value |
|-------|-------|
| **Type** | module |
| **Category** | nullplatform |
| **Description** | Creates and manages action items via the nullplatform Opportunities API. |

Full action item lifecycle: `create`, `get`, `list`, `update`, `add-suggestion`, `approve-suggestion`, `defer`, `resolve`, `reject`, `close`, `reopen`.

```yaml
- id: create_item
  type: module
  pluginType: np-action-item
  config:
    action: create
    title: "Review infrastructure costs"
    categoryId: "cost-optimization"
    priority: medium              # low | medium | high | critical
    nrn: "nrn:nullplatform:scope:123"
    metadata:
      source: workflow
```

**Outputs (create):** `{ actionItemId, status, result }`
**Outputs (list):** `{ items, count, result }` -- also emits `items` as workflow items for downstream processing

## Summary Table

| Plugin | Type | Category | executeMode |
|--------|------|----------|-------------|
| `log` | module | control-flow | each |
| `no-op` | module | utility | each |
| `set-variable` | module | data | each |
| `delay` | module | control-flow | each |
| `signal-wait` | module | control-flow | each |
| `webhook-wait` | module | integration | each |
| `sub-workflow` | module | control-flow | each |
| `http-request` | module | integration | each |
| `code-exec` | module | transform | each |
| `conditional` | decider | control-flow | each |
| `webhook` | trigger | integration | -- |
| `cron` | trigger | scheduling | -- |
| `manual` | trigger | control-flow | -- |
| `on-error` | trigger | control-flow | -- |
| `fail` | module | control-flow | each |
| `paginated-fetch` | module | integration | each |
| `agent` | module | ai | each |
| `split-in-batches` | module | control-flow | **all** |
| `np-agent-command` | module | nullplatform | each |
| `np-action-item-create` | module | nullplatform | each |
| `np-action-item-get` | module | nullplatform | each |
| `np-action-item-list` | module | nullplatform | each |
| `np-action-item-update` | module | nullplatform | each |
| `np-action-item-defer` | module | nullplatform | each |
| `np-action-item-resolve` | module | nullplatform | each |
| `np-action-item-reject` | module | nullplatform | each |
| `np-action-item-close` | module | nullplatform | each |
| `np-action-item-reopen` | module | nullplatform | each |
