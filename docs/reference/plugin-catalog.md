# Plugin Catalog

> **Auto-generated** from the live plugin registry. The canonical, always-current source is `GET /workflows/plugins` on your engine.

This page lists every plugin shipped with the workflow engine. For each entry you get:
- Type, category, and a one-line description.
- A summary of the `configSchema` so you know what the YAML `config:` block accepts.
- One concrete example pulled from the plugin's `examples` field when available.

The same information is available at runtime via `GET /workflows/plugins` and `GET /workflows/plugins/:name` — see [REST API](./rest-api.md).

**Total plugins registered:** 55.

---


## Index

| Name | Type | Category | Description |
|---|---|---|---|
| [`manual`](#manual) | trigger | control-flow | Manual start trigger |
| [`on-error`](#on-error) | trigger | control-flow | Triggers when a workflow step fails |
| [`slack-trigger`](#slack-trigger) | trigger | integration | Start a workflow from a Slack mention, message, reaction, or slash command. |
| [`webhook`](#webhook) | trigger | integration | HTTP webhook trigger |
| [`np-action-item-trigger`](#np-action-item-trigger) | trigger | nullplatform | Trigger workflows on Nullplatform action item events via audit webhooks |
| [`np-checklist-trigger`](#np-checklist-trigger) | trigger | nullplatform | Trigger workflows on Nullplatform checklist:item:dispatched notifications |
| [`np-deployment-trigger`](#np-deployment-trigger) | trigger | nullplatform | Receives NP deployment lifecycle events. Start events open a workflow execution; follow-up |
| [`np-scope-trigger`](#np-scope-trigger) | trigger | nullplatform | Trigger workflows on Nullplatform scope lifecycle events (create, configure, update, pause |
| [`execution-failed-trigger`](#execution-failed-trigger) | trigger | observability | Fires when any workflow execution terminates in failed status |
| [`cron`](#cron) | trigger | scheduling | Cron schedule trigger |
| [`agent`](#agent) | module | ai | Run an LLM agent with a reasoning loop |
| [`claude-code-agent`](#claude-code-agent) | module | ai | Generic LLM agent super-module powered by Claude Agent SDK |
| [`slack-ask`](#slack-ask) | module | communication | Ask a question in Slack with buttons and wait for the answer |
| [`slack-send-message`](#slack-send-message) | module | communication | Send a message to a Slack channel via chat.postMessage |
| [`slack-wait-message`](#slack-wait-message) | module | communication | Wait for the next human reply in a Slack thread |
| [`delay`](#delay) | module | control-flow | Wait for a duration |
| [`fail`](#fail) | module | control-flow | Terminates the workflow with an error |
| [`signal-wait`](#signal-wait) | module | control-flow | Wait for a signal |
| [`split-in-batches`](#split-in-batches) | module | control-flow | Splits input items into batches and processes them in a loop |
| [`sub-workflow`](#sub-workflow) | module | control-flow | Invoke a child workflow |
| [`set-variable`](#set-variable) | module | data | Set a workflow variable under `variables.*`. |
| [`http-request`](#http-request) | module | integration | Make an HTTP request and return the response. |
| [`paginated-fetch`](#paginated-fetch) | module | integration | Fetches all pages from a paginated API. |
| [`webhook-wait`](#webhook-wait) | module | integration | Return a unique webhook URL and wait for a POST |
| [`jira-create-issue`](#jira-create-issue) | module | integrations | Create a Jira issue (Atlassian Cloud) via REST API v3 |
| [`jira-find-issue`](#jira-find-issue) | module | integrations | Search Jira issues with JQL (Atlassian Cloud, REST API v3) |
| [`jira-get-issue`](#jira-get-issue) | module | integrations | Fetch a Jira issue by key (Atlassian Cloud, REST API v3) |
| [`jira-wait-transition`](#jira-wait-transition) | module | integrations | Wait until a Jira issue reaches one of the expected statuses |
| [`np-action-item-add-comment`](#np-action-item-add-comment) | module | nullplatform | Add a comment to a Nullplatform action item |
| [`np-action-item-category-list`](#np-action-item-category-list) | module | nullplatform | List action item categories under an NRN |
| [`np-action-item-create`](#np-action-item-create) | module | nullplatform | Create a new Nullplatform action item |
| [`np-action-item-find`](#np-action-item-find) | module | nullplatform | Query action items with filters, or search by metadata for idempotency checks |
| [`np-action-item-get`](#np-action-item-get) | module | nullplatform | Get a single Nullplatform action item by id |
| [`np-action-item-raw`](#np-action-item-raw) | module | nullplatform | Generic Nullplatform governance HTTP escape hatch |
| [`np-action-item-suggestion-create`](#np-action-item-suggestion-create) | module | nullplatform | Create a suggestion (proposed fix) on a Nullplatform action item |
| [`np-action-item-suggestion-find-approved`](#np-action-item-suggestion-find-approved) | module | nullplatform | Find approved suggestions waiting for an executor agent to process |
| [`np-action-item-suggestion-update`](#np-action-item-suggestion-update) | module | nullplatform | Update a suggestion lifecycle state (approve/reject/mark-applied/mark-failed/retry) |
| [`np-action-item-update`](#np-action-item-update) | module | nullplatform | Update or transition a Nullplatform action item |
| [`np-action-item-wait`](#np-action-item-wait) | module | nullplatform | Wait for action item resolution or suggestion approval |
| [`np-agent-command`](#np-agent-command) | module | nullplatform | Dispatch a command (ping/logs/exec/mcp-exec/refresh-sources) to a Nullplatform agent and r |
| [`np-api-call`](#np-api-call) | module | nullplatform | Call any Nullplatform REST API endpoint with auth handled for you. |
| [`np-build-context`](#np-build-context) | module | nullplatform | Builds the nullplatform execution context (scope, deployment, application, build, release, |
| [`np-checklist-create`](#np-checklist-create) | module | nullplatform | Create a Nullplatform checklist template (and associate it with an approval action) or att |
| [`np-checklist-item-progress`](#np-checklist-item-progress) | module | nullplatform | Push a progress heartbeat to a checklist external item without resolving it. |
| [`np-checklist-item-resolve`](#np-checklist-item-resolve) | module | nullplatform | Resolve a checklist external item by PATCHing the approval-api callback URL |
| [`np-checklist-wait`](#np-checklist-wait) | module | nullplatform | Wait for a Nullplatform approval-checklist to reach a terminal outcome (approve, fail, can |
| [`np-deployment-wait`](#np-deployment-wait) | module | nullplatform | Wait for an NP deployment follow-up action (switch-traffic, rollback, ...) |
| [`np-entity-paginated-fetch`](#np-entity-paginated-fetch) | module | nullplatform | Paginates through a nullplatform entity listing endpoint |
| [`np-lake-query`](#np-lake-query) | module | nullplatform | Run a SQL query against the Nullplatform Customer Lake. |
| [`log`](#log) | module | observability | Emit a structured log entry scoped to this execution. |
| [`code-exec`](#code-exec) | module | transform | Runs inline JavaScript to transform inputs into outputs. |
| [`no-op`](#no-op) | module | utility | Do nothing; pass inputs through as outputs. |
| [`case`](#case) | decider | control-flow | Multi-branch switch: route execution by matching an expression against a list of cases. |
| [`conditional`](#conditional) | decider | control-flow | Branches execution based on a boolean expression. |
| [`np-action-reporter`](#np-action-reporter) | observer | nullplatform | Reports workflow lifecycle events back to a Nullplatform service-action callback URL. |

---


## `manual`

- **Type:** `trigger`
- **Category:** control-flow
- **Execute mode:** each
- **Inputs:** _default_
- **Outputs:** `undefined`

Manual start trigger

> Starts workflow manually via API or UI

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `description` | string | no | Optional description of when this workflow should be started. |
| `inputs` | object | no | Declared inputs for manual execution. The UI renders a form with these fields. E |

### Example

Entry point for manually started workflows.

---

## `on-error`

- **Type:** `trigger`
- **Category:** control-flow
- **Execute mode:** each
- **Inputs:** _default_
- **Outputs:** `undefined`

Triggers when a workflow step fails

> Starts an error-handling workflow on failure

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `listenFor` | enum("step" | "workflow") | no | Whether to trigger on individual step failures or workflow-level failures. |

### Example

Trigger when any workflow execution fails.
```yaml
- id: on-error-example
  type: trigger
  pluginType: on-error
  config:
    listenFor: workflow
```

---

## `slack-trigger`

- **Type:** `trigger`
- **Category:** integration
- **Execute mode:** each
- **Inputs:** _default_
- **Outputs:** `undefined`

Start a workflow from a Slack mention, message, reaction, or slash command.

> Receives Slack Events API deliveries and slash commands on a token-bearing webhook, verifies the request signature, and starts a workflow (and fans out thread replies).

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `event` | enum("mention" | "message" | "reaction" | "slash_command") | **yes** | Which Slack event starts the workflow. "mention": an @mention of your bot (app_m |
| `signingSecret` | string | **yes** | Your Slack app's Signing Secret, used to verify every request. Get it from https |
| `channel` | string | no | Optional channel-id filter — only fire for events in this channel. Get the id fr |
| `pattern` | string | no | Optional regular-expression (JavaScript regex source, no slashes) matched agains |
| `command` | string | no | The slash command to match, including the leading slash. REQUIRED when event is  |
| `reaction` | string | no | The emoji name to match (no colons). REQUIRED when event is "reaction". Use the  |
| `include_thread_replies` | boolean | no | For "message" events: also fire the trigger on replies inside a thread (thread_t |

### Example

Start when the bot is @mentioned (the agent-loop entry point).
```yaml
- id: slack-trigger-example
  type: trigger
  pluginType: slack-trigger
  config:
    event: mention
    signingSecret: ${{ secrets.SLACK_SIGNING_SECRET }}
```

---

## `webhook`

- **Type:** `trigger`
- **Category:** integration
- **Execute mode:** each
- **Inputs:** _default_
- **Outputs:** `undefined`

HTTP webhook trigger

> Starts or signals workflows on incoming HTTP requests

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | string | **yes** | Path at which to register the webhook, relative to the engine's webhook root. |
| `method` | enum("GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "ANY") | no | HTTP method to accept. Use ANY to accept all methods. |
| `mode` | enum("start" | "signal") | **yes** | start: each request starts a new execution. signal: each request signals an exis |
| `signalName` | string | no | Name of the signal emitted on each incoming request. Used in signal mode. |
| `correlationKeyPath` | string | no | Dot-path into the request body that yields the correlation key. Used in signal m |
| `secret` | string | no | HMAC-SHA256 secret for payload verification. Expression allowed. |
| `payloadSchema` | object | no | Optional JSON Schema for validating the incoming request body. |

### Example

Start a new execution for every POST to /hooks/orders.
```yaml
- id: webhook-example
  type: trigger
  pluginType: webhook
  config:
    path: /hooks/orders
    method: POST
    mode: start
```

---

## `np-action-item-trigger`

- **Type:** `trigger`
- **Category:** nullplatform
- **Execute mode:** each
- **Inputs:** _default_
- **Outputs:** `undefined`, `undefined`, `undefined`, `undefined`, `undefined`, `undefined`, `undefined`, `undefined`, `undefined`, `undefined`, `undefined`, `undefined`, `undefined`, `undefined`

Trigger workflows on Nullplatform action item events via audit webhooks

> Receives Nullplatform action item audit webhook events and either starts a new execution (mode: start) or signals an existing one (mode: signal). Auto-creates a notification channel in NP on activation with server-side filters (entity, method, labels, priority, category). Deduces the action from the audit event URL+method: created, updated, deleted, comment_added, suggestion_created, suggestion_updated. Also supports direct event payloads for backward compatibility.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `pathPrefix` | string | **yes** | URL path the trigger registers (must be globally unique) |
| `method` | string | no |  |
| `mode` | enum("start" | "signal") | **yes** | start: each event begins a new execution; signal: each event wakes a wait |
| `source` | enum("action-item" | "suggestion" | "all") | no | Which direct event source to accept (for backward compat payloads) |
| `npApiToken` | string | no | Bearer token for NP API. When provided with nrn, auto-creates a notification cha |
| `npApiBaseUrl` | string | no | NP API base URL |
| `nrn` | string | no | NRN scope for the notification channel (e.g. organization=X:account=Y) |
| `labelFilters` | object | no | Label key=value pairs to filter at channel level. Only action items with ALL mat |
| `priorityFilter` | array | no | Priority filter applied at channel level |
| `categorySlugFilter` | string | no | Category slug filter applied at channel level |
| `channelMethods` | array | no | HTTP methods to accept at channel level. Defaults to ["POST", "PATCH"]. |
| `actions` | array | no | Only process these derived actions from audit events. Omit to accept all. |
| `eventTypes` | array | no | Event type filter for direct (non-audit) payloads. |
| `nrnFilter` | string | no | Optional regex matching action_item.nrn |
| `ownerFilter` | string | no | Optional regex matching suggestion.owner (suggestion source only) |

### Example

```yaml
- id: np-action-item-trigger-example
  type: trigger
  pluginType: np-action-item-trigger
  config:
    pathPrefix: /np/ai-cost
    mode: start
    npApiToken: {{secrets.np_api_token}}
    nrn: organization=1
    labelFilters: {"workflow_type":"cost-review"}
    actions: ["created","updated"]
```

---

## `np-checklist-trigger`

- **Type:** `trigger`
- **Category:** nullplatform
- **Execute mode:** each
- **Inputs:** _default_
- **Outputs:** `undefined`

Trigger workflows on Nullplatform checklist:item:dispatched notifications

> Receives Nullplatform notifications from the `checklist` source. On activation, registers a local webhook path AND auto-creates a notification_channel in NP filtering on `source=checklist`, the configured `action`, and `context.kind`. Each dispatch becomes a new execution (mode: `start`) or a signal (mode: `signal`). Outputs the parsed dispatch payload so downstream steps can read `callbackUrl`, `callbackToken`, and `inputs` without touching HTTP themselves — pair with `np-checklist-item-resolve` to close the loop.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `pathPrefix` | string | **yes** | URL path the trigger registers (must be globally unique). |
| `method` | string | no |  |
| `mode` | enum("start" | "signal") | **yes** | start: each dispatch begins a new execution; signal: each dispatch wakes a wait. |
| `kind` | string | **yes** | Filter on `context.kind` — only dispatches with this kind reach the workflow. Ea |
| `action` | string | no | Notification action to subscribe to. Defaults to `checklist:item:dispatched`; se |
| `channelActions` | array | no | When set, the channel filter accepts ANY of these actions (overrides `action`).  |
| `npApiToken` | string | no | DEPRECATED and IGNORED for activation — channel create/verify/delete now run wit |
| `npApiKey` | string | no | DEPRECATED and IGNORED for activation — see npApiToken. API keys belong to the w |
| `npApiBaseUrl` | string | no | NP API base URL. |
| `nrn` | string | no | NRN scope for the notification channel (e.g. organization=1). |
| `signalName` | string | no | Signal name used in signal-mode dispatches. |
| `correlationKeyPath` | string | no | Dot-path into the notification body that yields the correlation key (signal mode |

### Example

```yaml
- id: np-checklist-trigger-example
  type: trigger
  pluginType: np-checklist-trigger
  config:
    pathPrefix: /np/checklist/validate-jira-epic
    mode: start
    kind: validate-jira-epic
    nrn: organization=1
```

---

## `np-deployment-trigger`

- **Type:** `trigger`
- **Category:** nullplatform
- **Execute mode:** each
- **Inputs:** _default_
- **Outputs:** `undefined`, `undefined`, `undefined`

Receives NP deployment lifecycle events. Start events open a workflow execution; follow-ups (switch-traffic, rollback, finalize, ...) flow as signals.

> Subscribes to Nullplatform service:action:create notifications scoped to deployment events. Routes start-initial and start-blue-green to their named ports as new executions, and routes switch-traffic / rollback-deployment / finalize-blue-green / delete-deployment / kill-instances / diagnose-deployment to signals (np.deployment.<slug>) keyed by deploymentKey(scope_id, deployment_id) so an in-flight workflow can wait on them. Manual mode is also supported for sub-workflow dispatch without external NP wiring.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `mode` | enum("subscriber" | "manual") | **yes** | subscriber: register an NP notification channel + webhook path; manual: no NP wi |
| `npApiKey` | string | no | Bearer token for NP API. Required in subscriber mode. |
| `npApiBaseUrl` | string | no | NP API base URL. |
| `nrn` | string | no | NRN scope for the notification channel. Required in subscriber mode. |
| `filters` | object | no | Channel-level filters reducing webhook traffic at the NP side. All filters compo |
| `emitRaw` | boolean | no | When true, also emit on the onRaw port for every accepted event. |
| `autoReport` | boolean | no | Attach the np-action-reporter companion observer to spawned executions so step e |

### Example

```yaml
- id: np-deployment-trigger-example
  type: trigger
  pluginType: np-deployment-trigger
  config:
    mode: subscriber
    npApiKey: {{secrets.np_api_token}}
    nrn: organization=1
    filters: {"scopeProvider":"kubernetes-custom"}
```

---

## `np-scope-trigger`

- **Type:** `trigger`
- **Category:** nullplatform
- **Execute mode:** each
- **Inputs:** _default_
- **Outputs:** `undefined`, `undefined`, `undefined`, `undefined`, `undefined`, `undefined`, `undefined`, `undefined`, `undefined`, `undefined`

Trigger workflows on Nullplatform scope lifecycle events (create, configure, update, pause/resume, delete, diagnose, restart-pods, set-desired-instance-count) via service-action audit webhooks.

> Subscriber-only trigger that listens to NP service:action notifications and routes scope events to per-action ports. Each scope event creates a new workflow execution; signal-mode is intentionally omitted because scope actions are short-lived. Auto-creates a notification channel on activation filtered by the scope provider/environment, and auto-attaches an `np-action-reporter` companion observer so the spawned execution reports progress back to the originating service action.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `pathPrefix` | string | no | URL path the trigger registers (must be globally unique) |
| `method` | string | no |  |
| `npApiKey` | string | **yes** | Bearer token for NP API. Required for auto channel creation and companion-observ |
| `npApiBaseUrl` | string | no | NP API base URL |
| `nrn` | string | **yes** | NRN scope for the notification channel (e.g. organization=1) |
| `filters` | object | no |  |
| `emitRaw` | boolean | no | When true, every accepted event also fans out on the `onRaw` port in addition to |
| `autoReport` | boolean | no | When true (default), the trigger attaches an `np-action-reporter` companion obse |

### Example

```yaml
- id: np-scope-trigger-example
  type: trigger
  pluginType: np-scope-trigger
  config:
    pathPrefix: /np/scope/k8s
    npApiKey: {{secrets.np_api_token}}
    nrn: organization=1
    filters: {"scopeProvider":"kubernetes-custom","environment":"stage"}
```

---

## `execution-failed-trigger`

- **Type:** `trigger`
- **Category:** observability
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`

Fires when any workflow execution terminates in failed status

> Subscribes to execution.failed events emitted by the workflow engine. Use to react to upstream failures — e.g. run a cleanup handler, notify oncall, or roll back external resources.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `workflow_id` | string | no | Optional — only fire when the failed execution belongs to this workflow id. When |
| `labels` | object | no | Optional — filter by workflow definition labels (future). Currently ignored. |

### Example

_no example_

---

## `cron`

- **Type:** `trigger`
- **Category:** scheduling
- **Execute mode:** each
- **Inputs:** _default_
- **Outputs:** `undefined`

Cron schedule trigger

> Starts workflows on a cron schedule

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `schedule` | string | **yes** | 5- or 6-field cron expression, e.g. '0 2 * * *'. |
| `timezone` | string | no | IANA timezone name, e.g. America/New_York. Defaults to UTC. |
| `catchUpMissed` | boolean | no | If true, fires once for missed schedule ticks after a restart. |

### Example

Start an execution every day at 02:00 UTC.
```yaml
- id: cron-example
  type: trigger
  pluginType: cron
  config:
    schedule: 0 2 * * *
```

---

## `agent`

- **Type:** `module`
- **Category:** ai
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`

Run an LLM agent with a reasoning loop

> Executes an LLM reasoning loop: builds a prompt, invokes a model, handles tool calls, and returns structured output conforming to a declared JSON Schema.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | no | Model identifier, e.g. "anthropic:claude-opus-4-7". Falls back to descriptor def |
| `systemPrompt` | any | **yes** | System prompt as an inline string or a reference to a declared template. |
| `userPrompt` | any | **yes** | User prompt as an inline string or a reference to a declared template. |
| `outputSchema` | object | **yes** | JSON Schema the agent must return. The reasoning loop validates its output again |
| `toolsEnabled` | array | no | Allow-list of tool names. Omit to enable all built-in tools. |
| `skillsEnabled` | array | no | Skill names to enable. Each skill contributes tools and prompt fragments. |
| `maxIterations` | integer | no |  |
| `maxTokensTotal` | integer | no |  |
| `maxToolErrors` | integer | no |  |
| `temperature` | number | no |  |
| `topP` | number | no |  |
| `maxTokens` | integer | no |  |
| `toolErrorStrategy` | enum("as-tool-result" | "fail-step") | no |  |

### Example

Ask the agent to produce a structured summary of a document.
```yaml
- id: agent-example
  type: module
  pluginType: agent
  config:
    systemPrompt: You are a helpful assistant that summarizes documents concisely.
    userPrompt: Please summarize the following: ${{ $item.document }}
    outputSchema: {"type":"object","required":["summary","keyPoints"],"properties":{"summary":{"type":"string"},"keyPoints":{"type":"array","items":{"type":"string"}}}}
    maxIterations: 3
```

---

## `claude-code-agent`

- **Type:** `module`
- **Category:** ai
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`

Generic LLM agent super-module powered by Claude Agent SDK

> Run a Claude agent reasoning loop inside a workflow step. Supports configurable system prompt, model, and JSON output schema. Exposes other workflows and registered module plugins as tools via the unified `tools` list. Persists conversation in nodeContext within the execution. Supports re-entry via signals (waitForSignal between turns) for conversational workflows. Sandboxed: deny-by-default network egress, isolated cwd, no subprocess by default.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `conversationId` | string | no | Conversation id within this execution. Defaults to step id. Two agent steps with |
| `resumeSession` | boolean | no | Reuse the paused sandbox and `claude --resume` across loop iterations within one |
| `systemPrompt` | string | **yes** | System prompt. May contain ${{ ... }} expressions. |
| `userPrompt` | string | **yes** | User prompt for this turn. May reference $item, steps.*.outputs, etc. |
| `model` | enum("claude-opus-4-8" | "claude-opus-4-7" | "claude-sonnet-4-6" | "claude-sonnet-4-5" | "claude-haiku-4-5") | no | Model to use for the agent reasoning loop. |
| `maxIterations` | integer | no |  |
| `maxTokensTotal` | integer | no |  |
| `temperature` | number | no |  |
| `topP` | number | no |  |
| `tools` | array | no | Tools the agent can call during its reasoning loop. Each entry is EITHER another |
| `skillsEnabled` | array | no | Skills to enable (one per row). |
| `mcpServersEnabled` | array | no | MCP servers to enable (one per row). |
| `env` | object | no | Environment variables made available to the agent (E2B sandbox). Use for caller  |
| `outputSchema` | object | no | Optional. JSON Schema the agent output should conform to. When omitted, the agen |
| `allowedHosts` | array | no | Extra hosts the agent may reach (e.g. github.com). One per row. |
| `reentry` | object | no | Enable conversational re-entry via signals |

### Example

Extract findings from logs and create action items via tools
```yaml
- id: claude-code-agent-example
  type: module
  pluginType: claude-code-agent
  config:
    systemPrompt: You are a security finding extractor. For each finding in the logs, FIRST call np-action-item-find to check for duplicates. If the search returns no match, propose a new action item. Output an array of findings.
    userPrompt: ${{ steps.fetch_logs.outputs.body }}
    outputSchema: {"type":"object","properties":{"findings":{"type":"array","items":{"type":"object","properties":{"cve_id":{"type":"string"},"severity":{"type":"string"}}}}}}
    tools: [{"type":"plugin","plugin":"np-action-item-find","presetInputs":{"nrn":"organization=1"}},{"type":"plugin","plugin":"np-action-item-create","presetInputs":{"nrn":"organization=1"}}]
```

---

## `slack-ask`

- **Type:** `module`
- **Category:** communication
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`, `undefined`

Ask a question in Slack with buttons and wait for the answer

> Posts a prompt with up to 25 buttons and pauses until a human clicks one (two-phase wait). Returns the clicked button value/label and who clicked. Updates the message in place on resolution. Replaces slack-approve with generic buttons.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `channel` | string | **yes** | Slack channel to post the question to: a channel id (e.g. C01234ABC) or name (e. |
| `prompt` | string | **yes** | The question, in Slack mrkdwn. Shown above the buttons. |
| `buttons` | array | **yes** | The buttons to offer (1–25). Each button’s `value` is returned to the workflow w |
| `thread_ts` | string | no | Optional parent message `ts` to post the question in-thread (e.g. ${{ steps.noti |
| `timeout` | string | no | How long to wait for a click before timing out, e.g. '24h'. Omit to wait forever |
| `onTimeout` | enum("error" | "continue") | no | What to do on timeout: `error` fails the step (default), `continue` activates th |
| `botToken` | string | **yes** | Bot User OAuth token (xoxb-…). Store it as a config entry and reference it here. |
| `apiBaseUrl` | string | no | Slack API base URL. Override only for testing or an on-prem proxy. |

### Example

Approve or abort a deploy; fail the step if unanswered in 24h.
```yaml
- id: slack-ask-example
  type: module
  pluginType: slack-ask
  config:
    channel: #deploys
    prompt: Deploy *${{ workflow.inputs.version }}* to production?
    buttons: [{"label":"Ship it","value":"approve","style":"primary"},{"label":"Abort","value":"reject","style":"danger"}]
    timeout: 24h
    onTimeout: error
    botToken: ${{ secrets.SLACK_BOT_TOKEN }}
```

---

## `slack-send-message`

- **Type:** `module`
- **Category:** communication
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`

Send a message to a Slack channel via chat.postMessage

> Posts a mrkdwn or Block Kit message to a Slack channel or thread. The bot token comes from a config entry (${{ secrets.SLACK_BOT_TOKEN }}). Outputs the message timestamp so downstream steps can thread onto it or wait for a reply.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `channel` | string | no | Slack channel to post to: a channel id (e.g. C01234ABC, copy it from the channel |
| `message` | string | no | Message text in Slack mrkdwn (e.g. *bold*, `code`, <@U123>). Provide either `mes |
| `blocks` | array | no | Slack Block Kit blocks (https://api.slack.com/block-kit). When present, takes pr |
| `thread_ts` | string | no | Timestamp (`ts`) of a parent message to reply in-thread. Use a trigger output ($ |
| `botToken` | string | **yes** | Bot User OAuth token (xoxb-…) from the app's Install App page. Store it as a con |
| `unfurl_links` | boolean | no | Whether Slack should show link previews (unfurls). Defaults to Slack's behavior  |
| `apiBaseUrl` | string | no | Slack API base URL. Override only for testing or an on-prem proxy. |

### Example

Post a heads-up message to a channel.
```yaml
- id: slack-send-message-example
  type: module
  pluginType: slack-send-message
  config:
    channel: #deploys
    message: Deploy of *${{ workflow.inputs.service }}* starting in 5 minutes
    botToken: ${{ secrets.SLACK_BOT_TOKEN }}
```

---

## `slack-wait-message`

- **Type:** `module`
- **Category:** communication
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`, `undefined`

Wait for the next human reply in a Slack thread

> Pauses until someone replies in the given Slack thread. Computes the slack:<team_id>:<channel>:<thread_ts> correlation key and waits on the slack-message signal the slack-trigger fans out. Runs inline in the sandbox (zero I/O).

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `team_id` | string | **yes** | Slack workspace (team) id, e.g. T01234ABC. Comes straight from the trigger outpu |
| `channel` | string | **yes** | Channel id the thread lives in, e.g. C01234ABC. From the trigger or a send step  |
| `thread_ts` | string | **yes** | Thread root timestamp to listen on. Use the trigger’s thread_ts, or a send step’ |
| `timeout` | string | no | How long to wait for a reply before timing out, e.g. '2h'. Omit to wait forever. |
| `onTimeout` | enum("error" | "continue") | no | On timeout: `error` fails the step (default); `continue` activates the `timeout` |

### Example

Block until the human replies in the thread, failing after 2h.
```yaml
- id: slack-wait-message-example
  type: module
  pluginType: slack-wait-message
  config:
    team_id: ${{ workflow.inputs.team_id }}
    channel: ${{ workflow.inputs.channel }}
    thread_ts: ${{ workflow.inputs.thread_ts }}
    timeout: 2h
    onTimeout: error
```

---

## `delay`

- **Type:** `module`
- **Category:** control-flow
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`

Wait for a duration

> Pauses the workflow for the given duration

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `duration` | any | **yes** |  |

### Example

Wait 30 seconds before making the next call.
```yaml
- id: delay-example
  type: module
  pluginType: delay
  config:
    duration: 30s
```

---

## `fail`

- **Type:** `module`
- **Category:** control-flow
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** _default_

Terminates the workflow with an error

> Fails the workflow with a structured error message

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `message` | string | **yes** | Error message describing why the workflow failed. |
| `code` | string | no | Machine-readable error code. Defaults to WORKFLOW_FAILED. |
| `metadata` | object | no | Optional structured metadata attached to the error. |

### Example

Abort workflow when input validation fails.
```yaml
- id: fail-example
  type: module
  pluginType: fail
  config:
    message: Invalid input: missing required field "email"
    code: VALIDATION_FAILED
```

---

## `signal-wait`

- **Type:** `module`
- **Category:** control-flow
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`, `undefined`

Wait for a signal

> Pauses until the named signal arrives

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `signalName` | any | **yes** | Single signal name or array of candidates. Any match resumes the wait. |
| `correlationKey` | string | **yes** | Correlation key for routing. Usually derived from an expression. |
| `timeout` | string | no | Duration before timing out. Omit for indefinite wait. E.g. '24h'. |
| `onTimeout` | enum("error" | "continue") | no | On timeout: activate the `timeout` port and continue, or fail the step. |
| `defaultValue` | any | no | Optional default value returned on timeout (informational). |

### Example

Block until an external system sends an approval signal.
```yaml
- id: signal-wait-example
  type: module
  pluginType: signal-wait
  config:
    signalName: external-approval
    correlationKey: ${{ workflow.inputs.ticketId }}
    timeout: 48h
    onTimeout: error
```

---

## `split-in-batches`

- **Type:** `module`
- **Category:** control-flow
- **Execute mode:** all
- **Inputs:** _default_
- **Outputs:** `undefined`, `undefined`

Splits input items into batches and processes them in a loop

> Loop over items in configurable batch sizes. Outputs batches one at a time via the loop port, then all processed items via the done port.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `batchSize` | number | no | Number of items per batch |
| `reset` | boolean | no | Reset iteration state on re-entry |
| `arrayPath` | string | no | Optional dot path to read the array-to-iterate from the FIRST upstream item. Use |

### Example

_no example_

---

## `sub-workflow`

- **Type:** `module`
- **Category:** control-flow
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`

Invoke a child workflow

> Runs another workflow as a sub-execution and returns its outputs

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `workflowId` | string | **yes** | The ID of the workflow to invoke as a child execution. This is the workflow defi |
| `alias` | string | no | Alias of the child workflow to invoke. Defaults to 'latest'. Mutually exclusive  |
| `revision` | integer | no | Explicit revision number to invoke. Overrides alias. Prefer aliases for deployme |
| `waitForCompletion` | boolean | no | If true (default), the parent step blocks until the child workflow finishes and  |
| `inheritCorrelationKey` | boolean | no | If true, the child execution inherits the parent correlation key. Defaults to fa |
| `iterateItems` | boolean | no | When true (default), each input item triggers a separate child execution. When f |
| `maxParallelism` | integer | no | Maximum number of concurrent child executions when iterateItems is true. Items b |

### Example

Run a dedicated user-lookup sub-workflow and use its outputs downstream.
```yaml
- id: sub-workflow-example
  type: module
  pluginType: sub-workflow
  config:
    workflowId: user-lookup
    alias: production
```

---

## `set-variable`

- **Type:** `module`
- **Category:** data
- **Execute mode:** all
- **Inputs:** `undefined`
- **Outputs:** `undefined`

Set a workflow variable under `variables.*`.

> Writes a value into a workflow variable

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | string | no | Single-variable mode: the variable key under `variables.*` to write. Mutually ex |
| `value` | any | no | Single-variable mode: the new value. Any JSON-serializable value is accepted. |
| `assignments` | object | no | Batch mode: a map of `{ variableName: value }` pairs to write in a single step.  |

### Example

Write many variables in a single step — useful after a sub-workflow returns an object whose fields need to live at the top level.
```yaml
- id: set-variable-example
  type: module
  pluginType: set-variable
  config:
    assignments: {"scopeId":"${{ steps.deploy.outputs.scopeId }}","deploymentId":"${{ steps.deploy.outputs.deploymentId }}","namespace":"${{ steps.deploy.outputs.namespace }}","backends":"${{ steps.deploy.outputs.backends }}"}
```

---

## `http-request`

- **Type:** `module`
- **Category:** integration
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`

Make an HTTP request and return the response.

> Sends an HTTP request and returns the response

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | string | **yes** | Fully-qualified target URL; may include expressions. |
| `method` | enum("GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS") | no | HTTP verb. |
| `headers` | object | no | Request headers. Header values are coerced to strings. |
| `body` | any | no | Request body. Objects and arrays are JSON-encoded unless the `Content-Type` head |
| `timeout` | string | no | Duration string, e.g. '30s', '5m', '500ms'. Applied as both the headers timeout  |
| `followRedirects` | boolean | no | Whether 3xx redirects are followed automatically. |
| `verifySsl` | boolean | no | Whether TLS certificates are verified (HTTPS only). |

### Example

Fetch a user record by id with a JSON accept header.
```yaml
- id: http-request-example
  type: module
  pluginType: http-request
  config:
    url: https://api.example.com/users/42
    method: GET
    headers: {"Accept":"application/json"}
```

---

## `paginated-fetch`

- **Type:** `module`
- **Category:** integration
- **Execute mode:** each
- **Inputs:** `undefined`, `undefined`
- **Outputs:** `undefined`, `undefined`, `undefined`

Fetches all pages from a paginated API.

> Iterates through a paginated API collecting all items

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | string | **yes** | Base URL for the paginated API; may include expressions. |
| `method` | enum("GET" | "POST") | no | HTTP verb (GET or POST). |
| `mode` | enum("accumulate" | "stream") | no | Pagination mode. `accumulate` (default, backwards-compatible): fetch ALL pages i |
| `paginationStrategy` | enum("page" | "offset" | "cursor") | no | How pages are addressed: `page` (1, 2, 3...), `offset` (0, limit, 2*limit...), o |
| `pageParam` | string | no | Query parameter name for the page number / offset value (used by `page` and `off |
| `limitParam` | string | no | Query parameter name for the page size. |
| `limit` | number | no | Number of items per page. |
| `cursorRequestParam` | string | no | Query parameter name to send the next-cursor on subsequent requests (cursor stra |
| `cursorResponsePath` | string | no | Dot-path to the next-cursor token in each response body (cursor strategy). Pagin |
| `dataPath` | string | no | Dot-separated path to the items array in each response. |
| `hasMorePath` | string | no | Dot-path to a boolean "has more pages" flag in each response. When set and falsy |
| `totalPath` | string | no | Optional dot-path to the total record count in the response. When set, paginatio |
| `stopWhenShortPage` | boolean | no | When true, stop paginating once a page returns fewer items than `limit`. Useful  |
| `maxPages` | number | no | Maximum number of pages to fetch (safety limit). |
| `headers` | object | no | Request headers. Header values are coerced to strings. |

### Example

Paginate through a REST user listing endpoint.
```yaml
- id: paginated-fetch-example
  type: module
  pluginType: paginated-fetch
  config:
    url: https://api.example.com/users
    method: GET
    pageParam: page
    limitParam: limit
    limit: 50
    dataPath: data
    hasMorePath: hasMore
```

---

## `webhook-wait`

- **Type:** `module`
- **Category:** integration
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`, `undefined`

Return a unique webhook URL and wait for a POST

> Waits for an HTTP callback on a one-time URL

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `timeout` | string | no | Maximum time to wait for the callback. |
| `onTimeout` | enum("error" | "continue") | no | On timeout: fail the step or activate the 'timeout' port. |
| `urlPrefix` | string | no | Optional human-readable path segment used in the URL (for observability; securit |
| `correlationKey` | string | no | Optional explicit correlation key. When omitted, the plugin generates a UUID tok |

### Example

Generate a URL for form submission and block until submitted.
```yaml
- id: webhook-wait-example
  type: module
  pluginType: webhook-wait
  config:
    timeout: 24h
    onTimeout: error
```

---

## `jira-create-issue`

- **Type:** `module`
- **Category:** integrations
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`

Create a Jira issue (Atlassian Cloud) via REST API v3

> Creates a Jira Cloud issue with summary, description, labels, assignee, and arbitrary custom fields. Uses HTTP basic auth (email + API token). The description is automatically wrapped in Atlassian Document Format (ADF). Outputs the issue key, internal id, REST self link, and a browser-friendly URL of the form `${JIRA_BASE_URL}/browse/{key}`.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `baseUrl` | string | no | Jira base URL, e.g. https://yourorg.atlassian.net |
| `email` | string | no | Jira user email used for HTTP basic auth |
| `apiToken` | string | no | Jira API token (avoid; use secret JIRA_API_TOKEN) |
| `project_key` | string | **yes** | Jira project key, e.g. ENG |
| `issue_type` | string | **yes** | Issue type name (Task, Bug, Story, ...) |
| `summary` | string | **yes** | One-line summary (issue title) |
| `description` | string | no | Issue description (plain text; auto-wrapped in ADF) |
| `labels` | array | no | Labels to apply |
| `assignee_email` | string | no | Email of the user to assign. Plugin looks up the accountId via /rest/api/3/user/ |
| `custom_fields` | object | no | Map of customfield_XXXXX -> value, merged into the request fields |
| `timeoutMs` | number | no |  |

### Example

```yaml
- id: jira-create-issue-example
  type: module
  pluginType: jira-create-issue
  config:
    project_key: ENG
    issue_type: Task
    summary: Investigate stale background workers
    description: Workers in cluster prod-a have not heartbeated for 6h.
    labels: ["ops","autocreated"]
```

---

## `jira-find-issue`

- **Type:** `module`
- **Category:** integrations
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`

Search Jira issues with JQL (Atlassian Cloud, REST API v3)

> Runs a JQL query via `POST /rest/api/3/search` and returns the matching issues with the most useful fields lifted to the top level. Each issue carries `{ key, id, issuetype, status, priority, summary, assignee, reporter, labels, createdAt, updatedAt }` plus the full `fields` map. Auth comes ONLY from explicit config — no env-var fallback — so each workflow has to declare its own Jira credentials.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `baseUrl` | string | **yes** | Jira base URL, e.g. https://yourorg.atlassian.net |
| `email` | string | **yes** | Jira user email (pass via secret expression). |
| `apiToken` | string | **yes** | Jira API token. Marked secret so the UI redacts it and the API can omit it on re |
| `maxResults` | number | no | Maximum number of issues to return (Jira caps at 100 per page). |
| `fields` | array | no | Optional list of field IDs to fetch (default: a sensible subset). |
| `expand` | string | no | Optional `expand` query value (comma-separated). |
| `timeoutMs` | number | no |  |

### Example

```yaml
- id: jira-find-issue-example
  type: module
  pluginType: jira-find-issue
  config:
    baseUrl: https://yourorg.atlassian.net
    email: ${{ secrets.jira_email }}
    apiToken: ${{ secrets.jira_api_token }}
    maxResults: 25
```

---

## `jira-get-issue`

- **Type:** `module`
- **Category:** integrations
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`

Fetch a Jira issue by key (Atlassian Cloud, REST API v3)

> Calls `GET /rest/api/3/issue/{issueIdOrKey}` and returns the parsed issue with the most useful fields lifted to the top level (`key`, `issuetype`, `status`, `priority`, `summary`, `assignee`, `reporter`, `labels`, `createdAt`, `updatedAt`). The raw response is still available under `raw`. Auth comes ONLY from explicit config fields (`baseUrl`, `email`, `apiToken`) — no env-var fallback — so each workflow declares which Jira account it talks to.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `baseUrl` | string | **yes** | Jira base URL, e.g. https://yourorg.atlassian.net |
| `email` | string | **yes** | Jira user email used for HTTP basic auth (pass via secret expression). |
| `apiToken` | string | **yes** | Jira API token. Marked secret so the UI redacts it and the API can omit it on re |
| `expand` | string | no | Optional `expand` query parameter (comma-separated). |
| `fields` | array | no | Optional list of field IDs to fetch (default: all standard fields). |
| `timeoutMs` | number | no |  |

### Example

```yaml
- id: jira-get-issue-example
  type: module
  pluginType: jira-get-issue
  config:
    baseUrl: https://yourorg.atlassian.net
    email: ${{ secrets.jira_email }}
    apiToken: ${{ secrets.jira_api_token }}
```

---

## `jira-wait-transition`

- **Type:** `module`
- **Category:** integrations
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`, `undefined`

Wait until a Jira issue reaches one of the expected statuses

> Pauses the workflow until a Jira Cloud issue reaches one of `expected_statuses` (e.g. ["Done","Closed"]). Default mode polls `GET /rest/api/3/issue/{key}` at `poll_interval`. When `webhook_mode: true`, the plugin instead pauses on a Jira webhook signal — register a Jira webhook that POSTs `jira:issue_updated` events to `<host>/api/webhooks/jira`. Outputs the matched status, transition timestamp, current assignee, and last comment if available.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `baseUrl` | string | no |  |
| `email` | string | no |  |
| `apiToken` | string | no |  |
| `issue_key` | string | **yes** | Issue key to watch (e.g. ENG-123). Templated values welcome. |
| `expected_statuses` | array | **yes** | Status names that complete the wait (e.g. ["Done","Closed","Cancelled"]) |
| `poll_interval` | string | no | Duration string between polls (e.g. "30s", "2m", "5m") |
| `timeout` | string | no | Total duration before giving up (e.g. "24h", "7d") |
| `webhook_mode` | boolean | no | When true, wait for a Jira webhook signal instead of polling. Requires the `/api |
| `timeoutMs` | number | no |  |

### Example

```yaml
- id: jira-wait-transition-example
  type: module
  pluginType: jira-wait-transition
  config:
    issue_key: ENG-123
    expected_statuses: ["Done","Closed","Cancelled"]
    poll_interval: 30s
    timeout: 24h
```

---

## `np-action-item-add-comment`

- **Type:** `module`
- **Category:** nullplatform
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`

Add a comment to a Nullplatform action item

> Adds a free-form comment to an action item. Useful for agents to record progress, context, or hold/abort instructions.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `apiBaseUrl` | string | no | Nullplatform API base URL |
| `apiToken` | string | no | Bearer access token. Used as-is. Prefer `apiKey` for long-running workflows — be |
| `apiKey` | string | no | Nullplatform API key. Exchanged for a short-lived bearer token at `POST /token`  |
| `apiTokenSecretKey` | string | no | Secret name to resolve when `apiToken` is omitted |
| `apiKeySecretKey` | string | no | Secret name to resolve when `apiKey` is omitted |
| `secretKey` | string | no | DEPRECATED: alias for `apiTokenSecretKey`. New workflows should use `apiTokenSec |
| `timeoutMs` | number | no |  |
| `actionItemId` | string | **yes** |  |
| `author` | string | **yes** |  |
| `content` | string | **yes** |  |

### Example

```yaml
- id: np-action-item-add-comment-example
  type: module
  pluginType: np-action-item-add-comment
  config:
    actionItemId: ai_abc
    author: agent:executor
    content: Started work; ETA 1 hour
```

---

## `np-action-item-category-list`

- **Type:** `module`
- **Category:** nullplatform
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`

List action item categories under an NRN

> Lists categories with optional filters by parent_id and status. Emits results as items[].

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `apiBaseUrl` | string | no | Nullplatform API base URL |
| `apiToken` | string | no | Bearer access token. Used as-is. Prefer `apiKey` for long-running workflows — be |
| `apiKey` | string | no | Nullplatform API key. Exchanged for a short-lived bearer token at `POST /token`  |
| `apiTokenSecretKey` | string | no | Secret name to resolve when `apiToken` is omitted |
| `apiKeySecretKey` | string | no | Secret name to resolve when `apiKey` is omitted |
| `secretKey` | string | no | DEPRECATED: alias for `apiTokenSecretKey`. New workflows should use `apiTokenSec |
| `timeoutMs` | number | no |  |
| `nrn` | string | **yes** |  |
| `parentId` | string | no |  |
| `status` | enum("active" | "inactive") | no |  |

### Example

```yaml
- id: np-action-item-category-list-example
  type: module
  pluginType: np-action-item-category-list
  config:
    nrn: organization=1
    status: active
```

---

## `np-action-item-create`

- **Type:** `module`
- **Category:** nullplatform
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`

Create a new Nullplatform action item

> Create a new action item under a specific NRN and category. WARNING: callers MUST ensure idempotency before calling — use np-action-item-find with metadataKey/metadataValue first to check for duplicates by a unique metadata key (e.g. cve_id, resource_arn).

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `apiBaseUrl` | string | no | Nullplatform API base URL |
| `apiToken` | string | no | Bearer access token. Used as-is. Prefer `apiKey` for long-running workflows — be |
| `apiKey` | string | no | Nullplatform API key. Exchanged for a short-lived bearer token at `POST /token`  |
| `apiTokenSecretKey` | string | no | Secret name to resolve when `apiToken` is omitted |
| `apiKeySecretKey` | string | no | Secret name to resolve when `apiKey` is omitted |
| `secretKey` | string | no | DEPRECATED: alias for `apiTokenSecretKey`. New workflows should use `apiTokenSec |
| `timeoutMs` | number | no |  |
| `nrn` | string | **yes** |  |
| `title` | string | **yes** |  |
| `categorySlug` | string | no |  |
| `categoryId` | string | no |  |
| `description` | string | no |  |
| `priority` | enum("critical" | "high" | "medium" | "low") | no |  |
| `value` | number | no |  |
| `metadata` | object | no |  |
| `userMetadata` | object | no |  |
| `affectedResources` | array | no |  |
| `references` | array | no |  |
| `labels` | object | no |  |
| `dueDate` | string | no |  |
| `createdBy` | string | **yes** |  |
| `config` | object | no | Per-item config override |

### Example

Detector creates a CVE-tracking item with idempotency metadata
```yaml
- id: np-action-item-create-example
  type: module
  pluginType: np-action-item-create
  config:
    nrn: organization=1
    title: CVE-2024-1234 in lodash
    categorySlug: security-vulnerability
    priority: critical
    createdBy: agent:vuln-scanner
    metadata: {"cve_id":"CVE-2024-1234","cvss_score":8.5}
```

---

## `np-action-item-find`

- **Type:** `module`
- **Category:** nullplatform
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`

Query action items with filters, or search by metadata for idempotency checks

> Query the Nullplatform Governance API for action items in a given NRN scope. Supports filters by status, category, priority, metadata, labels, value, due date. When metadataKey and metadataValue are provided, performs an idempotency search (returns firstMatch). Emits results as items[] for downstream per-item processing via splitInBatches.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `apiBaseUrl` | string | no | Nullplatform API base URL |
| `apiToken` | string | no | Bearer access token. Used as-is. Prefer `apiKey` for long-running workflows — be |
| `apiKey` | string | no | Nullplatform API key. Exchanged for a short-lived bearer token at `POST /token`  |
| `apiTokenSecretKey` | string | no | Secret name to resolve when `apiToken` is omitted |
| `apiKeySecretKey` | string | no | Secret name to resolve when `apiKey` is omitted |
| `secretKey` | string | no | DEPRECATED: alias for `apiTokenSecretKey`. New workflows should use `apiTokenSec |
| `timeoutMs` | number | no |  |
| `nrn` | string | **yes** | NRN scope, e.g. "organization=1" |
| `status` | array | no | Filter by status (open, deferred, resolved, ...) |
| `categoryId` | string | no |  |
| `categorySlug` | string | no |  |
| `priority` | enum("critical" | "high" | "medium" | "low") | no |  |
| `createdBy` | string | no |  |
| `metadata` | object | no | Filter by metadata.* fields |
| `labels` | object | no | Filter by labels.* fields |
| `dueDateBefore` | string | no |  |
| `dueDateAfter` | string | no |  |
| `minValue` | number | no |  |
| `maxValue` | number | no |  |
| `limit` | number | no |  |
| `cursor` | string | no |  |
| `metadataKey` | string | no | Metadata key for idempotency search (e.g. cve_id) |
| `metadataValue` | string | no | Expected metadata value for idempotency search |
| `includeResolved` | boolean | no | When metadataKey/metadataValue are set, also search resolved/closed/rejected ite |
| `includePending` | boolean | no | When metadataKey/metadataValue are set, include pending states |

### Example

Useful as the first step of a reconciler workflow
```yaml
- id: np-action-item-find-example
  type: module
  pluginType: np-action-item-find
  config:
    nrn: organization=1
    status: ["open"]
    priority: critical
    limit: 100
```

---

## `np-action-item-get`

- **Type:** `module`
- **Category:** nullplatform
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`

Get a single Nullplatform action item by id

> Fetch the full state of one action item by its id, including comments references, suggestions, and config.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `apiBaseUrl` | string | no | Nullplatform API base URL |
| `apiToken` | string | no | Bearer access token. Used as-is. Prefer `apiKey` for long-running workflows — be |
| `apiKey` | string | no | Nullplatform API key. Exchanged for a short-lived bearer token at `POST /token`  |
| `apiTokenSecretKey` | string | no | Secret name to resolve when `apiToken` is omitted |
| `apiKeySecretKey` | string | no | Secret name to resolve when `apiKey` is omitted |
| `secretKey` | string | no | DEPRECATED: alias for `apiTokenSecretKey`. New workflows should use `apiTokenSec |
| `timeoutMs` | number | no |  |
| `actionItemId` | string | **yes** | Action item id |

### Example

Refresh an action item before deciding next step
```yaml
- id: np-action-item-get-example
  type: module
  pluginType: np-action-item-get
  config:
    actionItemId: ai_abc123
```

---

## `np-action-item-raw`

- **Type:** `module`
- **Category:** nullplatform
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`

Generic Nullplatform governance HTTP escape hatch

> Make an arbitrary HTTP request to /governance/* endpoints. Covers action_item, action_item_category, and suggestions endpoints. Use this for endpoints not covered by the granular plugins (audit logs, listing comments, rare lifecycle ops). Prefer the granular plugins when one matches.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `apiBaseUrl` | string | no | Nullplatform API base URL |
| `apiToken` | string | no | Bearer access token. Used as-is. Prefer `apiKey` for long-running workflows — be |
| `apiKey` | string | no | Nullplatform API key. Exchanged for a short-lived bearer token at `POST /token`  |
| `apiTokenSecretKey` | string | no | Secret name to resolve when `apiToken` is omitted |
| `apiKeySecretKey` | string | no | Secret name to resolve when `apiKey` is omitted |
| `secretKey` | string | no | DEPRECATED: alias for `apiTokenSecretKey`. New workflows should use `apiTokenSec |
| `timeoutMs` | number | no |  |
| `method` | enum("GET" | "POST" | "PATCH" | "DELETE") | **yes** |  |
| `path` | string | **yes** | Path relative to /governance/, e.g. /action_item/ai_123/audit-logs or /action_it |
| `body` | object,array,null | no |  |
| `query` | object | no |  |

### Example

```yaml
- id: np-action-item-raw-example
  type: module
  pluginType: np-action-item-raw
  config:
    method: GET
    path: /action_item/ai_abc/audit-logs
```

---

## `np-action-item-suggestion-create`

- **Type:** `module`
- **Category:** nullplatform
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`

Create a suggestion (proposed fix) on a Nullplatform action item

> Creates a Suggestion attached to an action item. Suggestions follow their own lifecycle (pending → approved → applied/failed). The detector agent creates the suggestion; humans (or auto-approval) move it to approved; an executor agent owning this suggestion processes approved ones and reports back via mark-applied/mark-failed.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `apiBaseUrl` | string | no | Nullplatform API base URL |
| `apiToken` | string | no | Bearer access token. Used as-is. Prefer `apiKey` for long-running workflows — be |
| `apiKey` | string | no | Nullplatform API key. Exchanged for a short-lived bearer token at `POST /token`  |
| `apiTokenSecretKey` | string | no | Secret name to resolve when `apiToken` is omitted |
| `apiKeySecretKey` | string | no | Secret name to resolve when `apiKey` is omitted |
| `secretKey` | string | no | DEPRECATED: alias for `apiTokenSecretKey`. New workflows should use `apiTokenSec |
| `timeoutMs` | number | no |  |
| `actionItemId` | string | **yes** |  |
| `createdBy` | string | **yes** | Detector agent identifier |
| `owner` | string | **yes** | Executor agent identifier (e.g. executor:pr-creator) |
| `confidence` | number | no |  |
| `description` | string | no |  |
| `metadata` | object | no |  |
| `userMetadata` | object | no |  |
| `userMetadataConfig` | object | no |  |
| `expiresAt` | string | no |  |

### Example

```yaml
- id: np-action-item-suggestion-create-example
  type: module
  pluginType: np-action-item-suggestion-create
  config:
    actionItemId: ai_abc
    createdBy: agent:vuln-scanner
    owner: executor:pr-creator
    confidence: 0.95
    metadata: {"action_type":"dependency_upgrade","package":"lodash","to_version":"4.17.21"}
    userMetadata: {"target_branch":"main","auto_merge":false}
```

---

## `np-action-item-suggestion-find-approved`

- **Type:** `module`
- **Category:** nullplatform
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`

Find approved suggestions waiting for an executor agent to process

> Lists action items in the given NRN, then for each one, fetches its approved suggestions matching the configured owner. Returns a flat items[] of {actionItem, suggestion} pairs ready for downstream per-pair execution. The polling source for executor workflows.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `apiBaseUrl` | string | no | Nullplatform API base URL |
| `apiToken` | string | no | Bearer access token. Used as-is. Prefer `apiKey` for long-running workflows — be |
| `apiKey` | string | no | Nullplatform API key. Exchanged for a short-lived bearer token at `POST /token`  |
| `apiTokenSecretKey` | string | no | Secret name to resolve when `apiToken` is omitted |
| `apiKeySecretKey` | string | no | Secret name to resolve when `apiKey` is omitted |
| `secretKey` | string | no | DEPRECATED: alias for `apiTokenSecretKey`. New workflows should use `apiTokenSec |
| `timeoutMs` | number | no |  |
| `nrn` | string | **yes** |  |
| `owner` | string | **yes** | Executor identifier to filter by |
| `limit` | number | no |  |

### Example

```yaml
- id: np-action-item-suggestion-find-approved-example
  type: module
  pluginType: np-action-item-suggestion-find-approved
  config:
    nrn: organization=1
    owner: executor:pr-creator
    limit: 25
```

---

## `np-action-item-suggestion-update`

- **Type:** `module`
- **Category:** nullplatform
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`

Update a suggestion lifecycle state (approve/reject/mark-applied/mark-failed/retry)

> Update a suggestion's lifecycle state. Supports approve, reject, mark-applied, mark-failed, and retry. Patches /governance/action_item/:id/suggestions/:sId with the mapped status and optional fields.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `apiBaseUrl` | string | no | Nullplatform API base URL |
| `apiToken` | string | no | Bearer access token. Used as-is. Prefer `apiKey` for long-running workflows — be |
| `apiKey` | string | no | Nullplatform API key. Exchanged for a short-lived bearer token at `POST /token`  |
| `apiTokenSecretKey` | string | no | Secret name to resolve when `apiToken` is omitted |
| `apiKeySecretKey` | string | no | Secret name to resolve when `apiKey` is omitted |
| `secretKey` | string | no | DEPRECATED: alias for `apiTokenSecretKey`. New workflows should use `apiTokenSec |
| `timeoutMs` | number | no |  |
| `actionItemId` | string | **yes** | Parent action item ID |
| `suggestionId` | string | **yes** | Suggestion ID to update |
| `action` | enum("approve" | "reject" | "mark-applied" | "mark-failed" | "retry") | **yes** | Lifecycle action to perform |
| `reason` | string | no | For reject: reason for rejection |
| `executionResult` | object | no | For mark-applied and mark-failed: execution result details |
| `actor` | string | no | Actor performing the update |

### Example

```yaml
- id: np-action-item-suggestion-update-example
  type: module
  pluginType: np-action-item-suggestion-update
  config:
    actionItemId: ai_abc
    suggestionId: sug_1
    action: approve
    actor: user:admin
```

---

## `np-action-item-update`

- **Type:** `module`
- **Category:** nullplatform
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`

Update or transition a Nullplatform action item

> Update an existing action item. In patch mode (no action set), sends a PATCH with partial fields like title, priority, description, metadata, labels, dueDate, value. In transition mode (action set), performs a lifecycle transition: defer, resolve, reject, close, or reopen by POSTing to /governance/action_item/:id/:action with actor, until, reason fields.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `apiBaseUrl` | string | no | Nullplatform API base URL |
| `apiToken` | string | no | Bearer access token. Used as-is. Prefer `apiKey` for long-running workflows — be |
| `apiKey` | string | no | Nullplatform API key. Exchanged for a short-lived bearer token at `POST /token`  |
| `apiTokenSecretKey` | string | no | Secret name to resolve when `apiToken` is omitted |
| `apiKeySecretKey` | string | no | Secret name to resolve when `apiKey` is omitted |
| `secretKey` | string | no | DEPRECATED: alias for `apiTokenSecretKey`. New workflows should use `apiTokenSec |
| `timeoutMs` | number | no |  |
| `actionItemId` | string | **yes** | ID of the action item to update or transition |
| `title` | string | no |  |
| `priority` | enum("critical" | "high" | "medium" | "low") | no |  |
| `description` | string | no |  |
| `metadata` | object | no |  |
| `userMetadata` | object | no |  |
| `labels` | object | no |  |
| `dueDate` | string | no |  |
| `value` | number | no |  |
| `action` | enum("defer" | "resolve" | "reject" | "close" | "reopen") | no | Lifecycle action to perform. When set, switches to transition mode. |
| `actor` | string | no | Actor performing the transition (required in transition mode) |
| `until` | string | no | For defer: date until which to defer (ISO8601) |
| `reason` | string | no | For defer and reject: reason for the transition |

### Example

```yaml
- id: np-action-item-update-example
  type: module
  pluginType: np-action-item-update
  config:
    actionItemId: ai_abc
    priority: critical
```

---

## `np-action-item-wait`

- **Type:** `module`
- **Category:** nullplatform
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`, `undefined`

Wait for action item resolution or suggestion approval

> Pauses the workflow until an action item reaches a terminal state or a suggestion is approved/rejected. Uses deterministic correlation keys and signal names to match incoming webhook events. When waitFor="resolution", waits for np.action_item.<status> signals; when waitFor="suggestion-approval", waits for np.suggestion.<status> signals.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `waitFor` | enum("resolution" | "suggestion-approval") | **yes** | What to wait for: action item resolution or suggestion approval |
| `actionItemId` | string | **yes** | Action item ID |
| `suggestionId` | string | no | Suggestion ID (required when waitFor="suggestion-approval") |
| `terminalStates` | array | no | Terminal states that trigger resume (defaults depend on waitFor) |
| `timeout` | string | no | ISO8601 duration |
| `onTimeout` | enum("error" | "continue" | "resolve-with-default") | no |  |

### Example

```yaml
- id: np-action-item-wait-example
  type: module
  pluginType: np-action-item-wait
  config:
    waitFor: resolution
    actionItemId: ai_abc
    timeout: PT24H
```

---

## `np-agent-command`

- **Type:** `module`
- **Category:** nullplatform
- **Execute mode:** each
- **Inputs:** _default_
- **Outputs:** `undefined`, `undefined`

Dispatch a command (ping/logs/exec/mcp-exec/refresh-sources) to a Nullplatform agent and return its result.

> Synchronous one-shot to `/controlplane/agent_command`. For deployment pipelines build a shell `cmdline` upstream and call this with `command_type: exec`. There is no helm/kubectl catalog — the agent runs allowlisted binaries.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `agent_id` | string | no | Direct UUID of the agent to dispatch to. Mutually exclusive with `agent_selector |
| `agent_selector` | object | no | List + filter active agents and pick one. Use this when you do not have a stable |
| `command_type` | enum("ping" | "logs" | "exec" | "mcp-exec" | "refresh-sources") | **yes** | Which agent command to dispatch. Selects the body shape under `data`. NOT a cata |
| `cmdline` | string | no | The shell-style command to execute on the agent host. Required when `command_typ |
| `env` | object | no | String key/value pairs merged into the exec process environment. Supports `${{ s |
| `inject_workflow_env` | boolean | no | When true (default), the engine adds `WORKFLOW_EXECUTION_ID`, `WORKFLOW_STEP_ID` |
| `mcp` | object | no | JSON-RPC request body forwarded to the agent's MCP runtime. |
| `apikey` | string | no | When set, used directly. Otherwise resolved from the `NP_API_KEY` secret (config |
| `apikey_secret_key` | string | no | Secret name to resolve when `apikey` is omitted. |
| `api_base_url` | string | no | Override the controlplane endpoint. Default is `https://api.nullplatform.com`. |
| `timeout_seconds` | integer | no | Max time to wait for the synchronous controlplane response. Long-running exec co |
| `fetch_logs_on_failure` | boolean | no | When the primary command fails, send a follow-up `logs` command to capture the a |
| `fail_on_nonzero_exit` | boolean | no | When true (default), a non-zero exec exit code causes the step to fail with `COM |

### Example

Cheapest health check. Useful as a smoke test in onboarding workflows.
```yaml
- id: np-agent-command-example
  type: module
  pluginType: np-agent-command
  config:
    agent_id: 66b8a198-de5a-4bf6-887a-0916ac02d42f
    command_type: ping
```

---

## `np-api-call`

- **Type:** `module`
- **Category:** nullplatform
- **Execute mode:** all
- **Inputs:** `undefined`
- **Outputs:** `undefined`

Call any Nullplatform REST API endpoint with auth handled for you.

> Generic authenticated request to the Nullplatform API. Use this for any read or write that does not have a dedicated node — e.g. GET /deployment?scope_id=..., GET /release/:id, GET /application/:id, PATCH /scope/:id. Auth is resolved automatically from an API key/token or workflow secrets. Set paginate:true to follow result pages and collect them into items[]. Prefer a dedicated np-* node when one exactly matches your operation.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `apiBaseUrl` | string | no | Nullplatform API base URL |
| `apiToken` | string | no | Bearer access token. Used as-is. Prefer `apiKey` for long-running workflows — be |
| `apiKey` | string | no | Nullplatform API key. Exchanged for a short-lived bearer token at `POST /token`  |
| `apiTokenSecretKey` | string | no | Secret name to resolve when `apiToken` is omitted |
| `apiKeySecretKey` | string | no | Secret name to resolve when `apiKey` is omitted |
| `secretKey` | string | no | DEPRECATED: alias for `apiTokenSecretKey`. New workflows should use `apiTokenSec |
| `timeoutMs` | number | no |  |
| `method` | enum("GET" | "POST" | "PUT" | "PATCH" | "DELETE") | no |  |
| `path` | string | **yes** | Path relative to the API base URL. Leading slash optional. Examples: /deployment |
| `query` | object | no | Key/value pairs appended to the URL query string. |
| `body` | object,array,string,number,boolean,null | no | JSON body for POST/PUT/PATCH. |
| `headers` | object | no | Additional headers. Authorization is added automatically. |
| `paginate` | boolean | no | When true, follow the `next` link in each response and collect every `results[]` |
| `failOnHttpError` | boolean | no | When true (default) a non-2xx response fails the step. Set false to receive the  |

### Example

Find the most recent deployment of a scope (its release_id points at what is live).
```yaml
- id: np-api-call-example
  type: module
  pluginType: np-api-call
  config:
    method: GET
    path: /deployment
    query: {"scope_id":"123","sort":"created_at:desc","limit":1}
```

---

## `np-build-context`

- **Type:** `module`
- **Category:** nullplatform
- **Execute mode:** each
- **Inputs:** _default_
- **Outputs:** _default_

Builds the nullplatform execution context (scope, deployment, application, build, release, asset)

> Fetches all nullplatform entities in parallel and builds a unified context. On first call, fetches everything. On subsequent calls (same execution), only refreshes the deployment entity.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `npApiKey` | string | no | Nullplatform API key |
| `npApiBaseUrl` | string | no | Nullplatform API base URL |
| `contextVariable` | string | no | Variable name to store/read the context from |

### Example

Placed after np-deployment-trigger. Reads scope_id and deployment_id from $item.
```yaml
- id: np-build-context-example
  type: module
  pluginType: np-build-context
  config:
    npApiKey: ${{ secrets.NP_API_KEY }}
```

---

## `np-checklist-create`

- **Type:** `module`
- **Category:** nullplatform
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`

Create a Nullplatform checklist template (and associate it with an approval action) or attach to an existing approval request.

> Two modes: (A) when only `approvalRequestId` is provided, fetches the current checklist run state for that approval; (B) when `template` and `actionId` are provided, creates a new checklist template (POST /approval/checklist/template), associates it with the action (POST /approval/action/{id}/checklist-template), and resolves the resulting approval_request_id when the action has already produced one.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `apiBaseUrl` | string | no | Approval API base URL. Defaults to NP_APPROVAL_API_BASE env or https://api.nullp |
| `apiToken` | string | no | Bearer access token. Used as-is. Prefer `apiKey` for long-running workflows — be |
| `apiKey` | string | no | Nullplatform API key. Exchanged for a short-lived bearer token at `POST /token`  |
| `apiTokenSecretKey` | string | no | Secret name to resolve when `apiToken` is omitted |
| `apiKeySecretKey` | string | no | Secret name to resolve when `apiKey` is omitted |
| `secretKey` | string | no | DEPRECATED: alias for `apiTokenSecretKey`. New workflows should use `apiTokenSec |
| `timeoutMs` | number | no |  |
| `approvalRequestId` | string,number | no | Existing approval_request_id. When provided WITHOUT `template`, the plugin only  |
| `actionId` | string | no | Approval-action id to associate the new template with. Required in Mode B. |
| `nrn` | string | no | NRN scope for the new template (Mode B). |
| `template` | object | no | Inline checklist template definition (Mode B). When omitted, the plugin runs in  |

### Example

Surface the current checklist run for a known approval_request_id.
```yaml
- id: np-checklist-create-example
  type: module
  pluginType: np-checklist-create
  config:
    approvalRequestId: 1
```

---

## `np-checklist-item-progress`

- **Type:** `module`
- **Category:** nullplatform
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`

Push a progress heartbeat to a checklist external item without resolving it.

> Emits a non-terminal progress update (`in_progress` status + message) to the approval-api via `POST <callbackUrl>/progress` with the signed callback token. Append-only: every call adds a chronological entry to the item, visible to the deployer as they wait. Use between long-running steps (Jira lookup, paginated NP fetch, k8s rollout poll) so the checklist UI shows live activity instead of static `pending`. The terminal outcome still comes from `np-checklist-item-resolve` at the end of the workflow.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `timeoutMs` | number | no |  |
| `retries` | number | no | Attempts on retryable failures (5xx, network). Initial attempt is not counted. |

### Example



---

## `np-checklist-item-resolve`

- **Type:** `module`
- **Category:** nullplatform
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`

Resolve a checklist external item by PATCHing the approval-api callback URL

> Marks a checklist external item as `passed`, `failed`, `skipped`, or `in_progress` by issuing `PATCH <callbackUrl>` with the signed `Authorization: Bearer <callbackToken>` from the dispatch notification. Pair with `np-checklist-trigger`: the trigger exposes `callbackUrl` and `callbackToken`, this plugin closes the loop. No NP API token needed — the callback token is the credential. Retries on transient errors (5xx, network) with exponential backoff up to `retries` attempts.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `timeoutMs` | number | no |  |
| `retries` | number | no | Attempts on retryable failures (5xx, network). Initial attempt is not counted. |

### Example



---

## `np-checklist-wait`

- **Type:** `module`
- **Category:** nullplatform
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`, `undefined`, `undefined`, `undefined`, `undefined`, `undefined`, `undefined`

Wait for a Nullplatform approval-checklist to reach a terminal outcome (approve, fail, cancelled, expired).

> Polls the Approval API every `pollInterval` for checklist events. Resolves when a `checklist.aggregated` or `action.outcome_resolved` event arrives (or when GET /checklist returns a non-null `final_outcome`). Polling cursor is persisted in `nodeContext.afterSequence` so each tick only reads new events. The pause between polls uses the signal-wait timeout primitive — replay-safe on both the local and hosted runtimes.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `apiBaseUrl` | string | no | Approval API base URL. Defaults to NP_APPROVAL_API_BASE env or https://api.nullp |
| `apiToken` | string | no | Bearer access token. Used as-is. Prefer `apiKey` for long-running workflows — be |
| `apiKey` | string | no | Nullplatform API key. Exchanged for a short-lived bearer token at `POST /token`  |
| `apiTokenSecretKey` | string | no | Secret name to resolve when `apiToken` is omitted |
| `apiKeySecretKey` | string | no | Secret name to resolve when `apiKey` is omitted |
| `secretKey` | string | no | DEPRECATED: alias for `apiTokenSecretKey`. New workflows should use `apiTokenSec |
| `timeoutMs` | number | no |  |
| `approvalRequestId` | string,number | **yes** | The approval_request_id whose checklist run to wait for. |
| `pollInterval` | string | no | Duration string between polls (e.g. "15s", "1m"). Default 15s. Tune to balance l |
| `timeout` | string | no | Maximum wall-clock duration before failing. Default 7d. |
| `terminalOutcomes` | array | no | Outcomes that resolve the wait. Default: approve, approve_with_override, fail, c |
| `onTimeout` | enum("fail" | "branch") | no | `fail`: emit failure with NP_CHECKLIST_TIMEOUT. `branch`: succeed on the `timeou |

### Example

```yaml
- id: np-checklist-wait-example
  type: module
  pluginType: np-checklist-wait
  config:
    approvalRequestId: 1
    pollInterval: 30s
    timeout: 7d
```

---

## `np-deployment-wait`

- **Type:** `module`
- **Category:** nullplatform
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`, `undefined`, `undefined`, `undefined`, `undefined`, `undefined`, `undefined`, `undefined`

Wait for an NP deployment follow-up action (switch-traffic, rollback, ...)

> Pauses an in-flight deployment workflow until one of the configured NP deployment follow-up actions is dispatched against the deployment. The plugin awaits np.deployment.<slug> signals correlated by deploymentKey(scopeId, deploymentId) and emits on the matching slug-named port (e.g. onSwitchTraffic) when the first signal arrives. Configure waitFor to declare which actions are expected; declare onTimeout to either fail the step or branch to onTimeout when the timeout fires.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `scopeId` | string | **yes** | NP scope id (typically an expression like ${{ variables.scopeId }}). |
| `deploymentId` | string | **yes** | NP deployment id. |
| `waitFor` | array | **yes** | Deployment follow-up action slugs to wait on. The first matching signal resumes  |
| `timeout` | string | no | Timeout duration (e.g. '3h'). Defaults to '3h'. |
| `onTimeout` | enum("fail" | "branch") | no | On timeout: 'fail' fails the step (non-retryable); 'branch' activates the onTime |

### Example

```yaml
- id: np-deployment-wait-example
  type: module
  pluginType: np-deployment-wait
  config:
    scopeId: ${{ variables.scopeId }}
    deploymentId: ${{ variables.deploymentId }}
    waitFor: ["switch-traffic"]
    timeout: 3h
```

---

## `np-entity-paginated-fetch`

- **Type:** `module`
- **Category:** nullplatform
- **Execute mode:** each
- **Inputs:** `undefined`, `undefined`
- **Outputs:** `undefined`, `undefined`, `undefined`

Paginates through a nullplatform entity listing endpoint

> Fetches all records of an NP entity (scope, application, release, deployment, action_item, etc.) honoring NP pagination conventions (offset/limit, results, total). Author supplies entity + filter map; plugin returns the full list.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `apiBaseUrl` | string | no | NP API base URL. |
| `apiToken` | string | no | Bearer token. Prefer `apiKey` for long-running workflows — bearer tokens expire  |
| `apiKey` | string | no | Nullplatform API key. Exchanged for a short-lived bearer token at `POST /token`  |
| `entity` | string | **yes** | NP entity name (URL path segment under the API root). E.g. `scope`, `application |
| `filters` | object | no | Query parameters to send on every page. Keys/values are URL-encoded. E.g. `{appl |
| `limit` | number | no | Page size. NP typically caps at 100. |
| `maxPages` | number | no | Safety cap on number of pages. |
| `mode` | enum("accumulate" | "stream") | no | Pagination mode (forwarded to underlying paginated-fetch). `accumulate`: one ste |

### Example

```yaml
- id: np-entity-paginated-fetch-example
  type: module
  pluginType: np-entity-paginated-fetch
  config:
    entity: scope
    filters: {"application":1923038887,"status":"active"}
```

---

## `np-lake-query`

- **Type:** `module`
- **Category:** nullplatform
- **Execute mode:** all
- **Inputs:** `undefined`
- **Outputs:** `undefined`

Run a SQL query against the Nullplatform Customer Lake.

> Execute a read-only SQL query against the Nullplatform Customer Lake (ClickHouse) and get rows back as items[]. Use this when one query is simpler than chaining REST calls — cross-entity joins, bulk state, audit analysis. Organization scoping is automatic; never add WHERE organization_id. For the audit_events table ALWAYS filter by date. Each returned row becomes one item.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `sql` | string | **yes** | A read-only SQL query. Org scoping is automatic (do not add organization_id). Ou |
| `apiBaseUrl` | string | no | Nullplatform API base URL |
| `apiToken` | string | no | Bearer access token. Used as-is. Prefer `apiKey` for long-running workflows — be |
| `apiKey` | string | no | Nullplatform API key. Exchanged for a short-lived bearer token at `POST /token`  |
| `apiTokenSecretKey` | string | no | Secret name to resolve when `apiToken` is omitted |
| `apiKeySecretKey` | string | no | Secret name to resolve when `apiKey` is omitted |
| `secretKey` | string | no | DEPRECATED: alias for `apiTokenSecretKey`. New workflows should use `apiTokenSec |
| `timeoutMs` | number | no |  |

### Example

Most recent deployment of a scope joined to its release (Core Entities domain).
```yaml
- id: np-lake-query-example
  type: module
  pluginType: np-lake-query
  config:
    sql: SELECT d.id AS deployment_id, d.release_id, d.status, d.created_at
FROM core_entities_deployment AS d FINAL
WHERE d._deleted = 0 AND d.scope_id = 123
ORDER BY d.created_at DESC
LIMIT 1
```

---

## `log`

- **Type:** `module`
- **Category:** observability
- **Execute mode:** all
- **Inputs:** `undefined`
- **Outputs:** `undefined`

Emit a structured log entry scoped to this execution.

> Logs a message at the given level

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `level` | enum("debug" | "info" | "warn" | "error") | no | Log level. Defaults to `info` when omitted. |
| `message` | string | **yes** | Log message; resolved with expressions before execute. |
| `metadata` | object | no | Optional key/value metadata attached to the log entry. |

### Example

Read fields from the predecessor step directly via `$item`.
```yaml
- id: log-example
  type: module
  pluginType: log
  config:
    level: info
    message: Received request ${{ $item.requestId }} for user ${{ $item.userId }}
```

---

## `code-exec`

- **Type:** `module`
- **Category:** transform
- **Execute mode:** all
- **Inputs:** `undefined`
- **Outputs:** `undefined`, `undefined`

Runs inline JavaScript to transform inputs into outputs.

> Evaluates an inline JavaScript fragment inside a sandbox and returns its value

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `code` | string | **yes** | Source code to evaluate inside the sandbox. May contain top-level `await`. Expre |
| `language` | enum("javascript" | "typescript") | no | Source language. 'javascript' is evaluated as-is; 'typescript' is transpiled (ty |
| `mode` | enum("each" | "all") | no | How to handle multiple input items: 'each' runs the code once per item (inputs = |
| `network` | object | no | Hosts this code needs to reach. Declaring any host means the step runs in an iso |
| `libraries` | array | no | Extra npm libraries the code needs, as 'name@range' entries (e.g. 'uuid@^9'). In |
| `executionConfig` | object | no | DEPRECATED — resource limits are platform policy. Accepted for previously stored |
| `runtime` | object | no | DEPRECATED — where a step runs is a platform decision (placement). Accepted for  |

### Example

Map incoming order rows into a compact summary shape.
```yaml
- id: code-exec-example
  type: module
  pluginType: code-exec
  config:
    code: return $item.orders.map(o => ({ id: o.id, total: o.items.reduce((s, i) => s + i.price * i.qty, 0) }));
```

---

## `no-op`

- **Type:** `module`
- **Category:** utility
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`

Do nothing; pass inputs through as outputs.

> Returns inputs as outputs without any side effect

### Config

_no config_

### Example

A TBD step in a workflow skeleton under construction.

---

## `case`

- **Type:** `decider`
- **Category:** control-flow
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`

Multi-branch switch: route execution by matching an expression against a list of cases.

> Evaluates an expression and routes execution to the first case whose `match` value equals the result (===), falling through to the configured default port if none matched.

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `expression` | string | **yes** | Value-producing expression evaluated against the workflow context. May be a bare |
| `cases` | array | **yes** |  |
| `default` | string | no | Name of the catch-all port activated when no case matches. Must not collide with |

### Example

Branch on a string field of the immediate predecessor.
```yaml
- id: case-example
  type: decider
  pluginType: case
  config:
    expression: $item.action
    cases: [{"match":"start-initial","port":"onInitial"},{"match":"start-blue-green","port":"onBlueGreen"}]
    default: onOther
```

---

## `conditional`

- **Type:** `decider`
- **Category:** control-flow
- **Execute mode:** each
- **Inputs:** `undefined`
- **Outputs:** `undefined`, `undefined`

Branches execution based on a boolean expression.

> Branches execution based on a boolean expression

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `expression` | string | **yes** | Boolean expression evaluated against the workflow context. May be a bare express |
| `truePort` | string | no | Output port activated when the expression is truthy. |
| `falsePort` | string | no | Output port activated when the expression is falsy. |

### Example

Route based on a field of the immediate predecessor — the most common case.
```yaml
- id: conditional-example
  type: decider
  pluginType: conditional
  config:
    expression: $item.statusCode == 200
```

---

## `np-action-reporter`

- **Type:** `observer`
- **Category:** nullplatform
- **Execute mode:** each
- **Inputs:** _default_
- **Outputs:** _default_

Reports workflow lifecycle events back to a Nullplatform service-action callback URL.

> PATCH workflow lifecycle into NP action callback

### Config

| Field | Type | Required | Description |
|---|---|---|---|
| `callbackUrl` | string | **yes** | NP service-action callback URL receiving PATCH updates. |
| `auth` | object | no |  |
| `verbosity` | enum("minimal" | "normal" | "verbose") | no | `verbose` enables step:started + log:emitted forwarding; `minimal` skips per-ste |
| `rateLimitMs` | integer | no | Minimum interval between buffered PATCH flushes, in milliseconds. |
| `reportStepEvents` | boolean | no | When false, skips step:started/step:completed forwarding regardless of verbosity |

### Example

Reports lifecycle events back to the callback URL injected by the trigger.
```yaml
- id: np-action-reporter-example
  type: observer
  pluginType: np-action-reporter
  config:
    callbackUrl: ${{ variables.callback_url }}
    auth: {"bearer":"${{ secrets.NP_API_TOKEN }}"}
```

---
