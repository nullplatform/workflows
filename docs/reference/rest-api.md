# REST API

Two parts: a hands-on **Quickstart** that publishes, triggers, and inspects a workflow against a deployed engine using only `curl` + a token, followed by the full **Reference** of endpoints, authentication, and error shapes.

The engine base path is `/workflows`. Use the public API domain (`https://api.nullplatform.com`) when the engine is deployed inside Nullplatform.

---

# Quickstart (Remote)

This is for **authors who already have a deployed workflow API URL and a bearer token** and want to publish, trigger, and inspect workflows over plain HTTP.

## Prerequisites

You need:

- A workflow API base URL (e.g. `https://workflows.example.com`). Stored below as `$NP_WORKFLOW_URL`.
- A bearer token. When the engine is deployed inside Nullplatform the `NP_TOKEN` (or `NP_API_KEY` exchanged into a token) is accepted directly. Stored below as `$TOKEN`.
- `curl`, `jq`, and `yq` installed locally.

```bash
export NP_WORKFLOW_URL="https://workflows.example.com"
export TOKEN="$NP_TOKEN"   # or your local HS256/RS256 token
```

## 1. Sanity ping — `GET /workflows/metadata`

`/workflows/metadata` is anonymous and is the fastest way to confirm a URL points at a workflow engine.

```bash
curl -s "$NP_WORKFLOW_URL/workflows/metadata" | jq
```

```json
{
  "apiVersion": "0.0.0",
  "pluginCount": 51,
  "supportedPluginTypes": ["trigger", "module", "decider"],
  "maxNodeExecutions": 1000,
  "topology": "distributed",
  "features": { "rbac": true, "multiOrg": true }
}
```

If the response is something other than this JSON shape, the URL is not a workflow engine (or you mistyped the path).

## 2. Identity

The workflow engine does **not** expose its own `/whoami`. Identity is
carried by the bearer token — and resolved by the Nullplatform auth layer,
which is the single source of truth. To inspect the active identity:

- Decode the JWT payload (`base64decode($TOKEN.split('.')[1])`) — contains
  `sub`, the organization claim, roles, etc.
- Or call the Nullplatform auth API directly (see the [NP API docs](https://docs.nullplatform.com/docs/api-getting-started)).

A quick way to confirm the engine accepts the token: hit any authenticated
endpoint. A `401` means the token is rejected; a `200` means it's good:

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  -H "Authorization: Bearer $TOKEN" \
  "$NP_WORKFLOW_URL/workflows/plugins?limit=1"
```

## 3. Plugin discovery — `GET /workflows/plugins`

Browse the catalog of installed plugins. Filter by `type` (`trigger` / `module` / `decider`) or `q` (substring search over name and description).

```bash
# Triggers only
curl -sf "$NP_WORKFLOW_URL/workflows/plugins?type=trigger" -H "Authorization: Bearer $TOKEN" \
  | jq '.data[] | {name, category}'

# Pick one and inspect its config schema + examples
curl -sf "$NP_WORKFLOW_URL/workflows/plugins/webhook-trigger" -H "Authorization: Bearer $TOKEN" \
  | jq '{name, configSchema, examples}'
```

The full descriptor (`configSchema`, `inputSchema`, `outputSchema`, `examples`, ports, `executeMode`) is what the canvas reads to render the side panel — it is also the canonical reference for authoring YAML by hand.

For a flat snapshot of every plugin shipped with this engine, see the [Plugin Catalog](./plugin-catalog.md).

## 4. Publish a workflow

There is no atomic `publish` endpoint by design — publishing is an orchestration of three idempotent REST calls. Run them in order.

```bash
# definition.yaml → JSON, save the result
DEF=$(yq -o=json definition.yaml)
EXISTING_ID=$(echo "$DEF" | jq -r '.id // empty')

# 4.1 Create or update the workflow
if [ -z "$EXISTING_ID" ] || ! curl -sf "$NP_WORKFLOW_URL/workflows/definitions/$EXISTING_ID" \
  -H "Authorization: Bearer $TOKEN" >/dev/null; then
  RESP=$(curl -sf -X POST "$NP_WORKFLOW_URL/workflows/definitions" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --argjson def "$DEF" '{definition:$def}')")
else
  RESP=$(curl -sf -X PUT "$NP_WORKFLOW_URL/workflows/definitions/$EXISTING_ID" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --argjson def "$DEF" '{definition:$def}')")
fi

ID=$(echo "$RESP" | jq -r '.id')
REVISION=$(echo "$RESP" | jq -r '.revision')

# 4.2 Point an alias at the new revision (idempotent)
curl -sf -X PUT "$NP_WORKFLOW_URL/workflows/definitions/$ID/aliases/live" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg r "$REVISION" '{revision:($r|tonumber)}')"

# 4.3 Activate the alias (registers triggers, opens webhook paths)
curl -sf -X POST "$NP_WORKFLOW_URL/workflows/definitions/$ID/aliases/live/activate" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'

echo "Published workflow $ID @ revision $REVISION on alias 'live'"
```

If the YAML fails schema validation the first POST/PUT returns **422** with a list of `errors[]`. The shape is RFC 7807 Problem Details — fix the file and retry.

> **Tip:** Skip the curl plumbing entirely by installing the [`np-workflow` skill](https://github.com/nullplatform/np-claude-skills) and running `/np-workflow publish definition.yaml`.

## 5. Discover webhook URLs after activation

The active trigger bindings carry their public webhook URLs.

```bash
curl -sf "$NP_WORKFLOW_URL/workflows/triggers?workflowId=$ID&status=active" \
  -H "Authorization: Bearer $TOKEN" \
  | jq '.data[] | select(.aliasName=="live") | {trigger:.triggerId, kind:.pluginType, url:.runtimeMetadata.webhookUrl}'
```

`runtimeMetadata.webhookUrl` is the absolute URL the world should POST to. Note that it is **alias-scoped** — `live` and `test` aliases have different URLs even for the same workflow.

## 6. Trigger and observe an execution

### Manual trigger (no webhook)

```bash
START=$(curl -sf -X POST "$NP_WORKFLOW_URL/workflows/definitions/$ID/execute" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"alias":"live","inputs":{}}')

EID=$(echo "$START" | jq -r '.executionId')
```

#### Idempotent starts (`idempotencyKey`)

When the caller retries (cron overlap, at-least-once queues, webhook
redelivery), pass an `idempotencyKey` — UNIQUE per workflow — and the engine
guarantees ONE execution per key, enforced by a storage unique constraint
(replica-agnostic):

```bash
curl -sf -X POST "$NP_WORKFLOW_URL/workflows/definitions/$ID/execute" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"alias":"live","inputs":{},"idempotencyKey":"order-4711-created"}'
```

- First call: `202` with the new execution.
- Any repeat: `200` with the SAME execution and `"deduplicated": true`.
- The key is stored on the execution record (`idempotencyKey`) and shown in
  the canvas observer, so dedupe hits are traceable.
- Triggers use this internally: the Slack trigger keys starts by
  `slack:<team_id>:<event_id>` so Slack's delivery retries never duplicate
  an execution. Custom trigger plugins can do the same via
  `ITriggerHandlerContext.idempotencyKey`.

### Via webhook

```bash
WEBHOOK_URL=$(curl -sf "$NP_WORKFLOW_URL/workflows/triggers?workflowId=$ID&status=active" \
  -H "Authorization: Bearer $TOKEN" \
  | jq -r '.data[] | select(.aliasName=="live" and .pluginType=="webhook") | .runtimeMetadata.webhookUrl' \
  | head -1)
curl -sf -X POST "$WEBHOOK_URL" -H "Content-Type: application/json" -d '{"hello":"world"}'
```

The webhook response carries no execution id by design (it's an asynchronous trigger). To follow the run:

```bash
# Latest execution for this workflow
EID=$(curl -sf "$NP_WORKFLOW_URL/workflows/executions?workflowId=$ID&limit=1" \
  -H "Authorization: Bearer $TOKEN" \
  | jq -r '.data[0].id')
```

### Inspect state

`GET /workflows/executions/:id` for the lifecycle record, `GET /workflows/executions/:id/state` for live step state:

```bash
curl -sf "$NP_WORKFLOW_URL/workflows/executions/$EID/state" \
  -H "Authorization: Bearer $TOKEN" \
  | jq '{status, steps: [.steps[] | {id, status, items}]}'
```

For a workflow that pauses on `waitForSignal`, `GET /workflows/executions/:id/pending-signals` returns the signal envelopes the engine is waiting on. Resume by `POST /workflows/signals`.

## Common errors

| Status | Likely cause | Fix |
|---|---|---|
| 401 | Token missing or invalid | Re-export `$TOKEN`; verify by hitting any authenticated endpoint (e.g. `GET /workflows/plugins?limit=1`) |
| 403 | Token is valid but the identity lacks the action's permission | Decode JWT to see roles, or check the NP auth API; review RBAC config |
| 404 | Workflow id, alias, or execution not found | List with `/workflows/definitions` or `/workflows/executions` |
| 409 | Idempotency conflict (e.g. activating an already-active alias with different revision) | Use `PUT /aliases/:alias` to repoint, then activate |
| 422 | Definition failed schema validation | Inspect `errors[]` in the response body |
| 503 | The route requires a runtime collaborator (executor/triggerManager) that isn't wired | Server is in degraded mode — check deployment logs |

---

# Reference

The workflow system exposes a REST API built on Fastify 4 with OpenAPI 3.1 documentation. The examples below use `http://localhost:3000` for a local engine; against a deployed engine substitute your base URL.

## Discovery Endpoints

### Capabilities — `GET /workflows/metadata`

Anonymous endpoint that returns the engine version, plugin count, and feature flags. Use it as a sanity ping before sending an authenticated request.

```bash
curl -s http://localhost:3000/workflows/metadata
```

```json
{
  "apiVersion": "0.0.0",
  "pluginCount": 46,
  "supportedPluginTypes": ["trigger", "module", "decider"],
  "maxNodeExecutions": 1000,
  "topology": "in-process",
  "features": { "rbac": false, "multiOrg": true }
}
```

### Health Check

```bash
curl http://localhost:3000/health
```

### OpenAPI Specification

```bash
curl http://localhost:3000/openapi.json
```

### Metrics (Prometheus)

```bash
curl http://localhost:3000/metrics
```

## Authentication

Protected routes accept `Authorization: Bearer <token>` where the token is one of:

- **User token** — issued by the deployment's `IPermissionProvider`. Local HS256 (dev RBAC) or RS256 Cognito (Nullplatform) are both supported transparently. The engine doesn't expose its own `/whoami` — to inspect the identity, decode the JWT payload or query the NP auth API.
- **Service token** — short-lived execution-scoped HMAC-SHA256 token minted by `POST /workflows/definitions/:id/execute` for worker callbacks (`{ executionId, workflowId, organizationId, scope, iat, exp }`). Verified against `WORKFLOW_INTER_SERVICE_SECRET`. Not for end-user use.

`/workflows/metadata`, `/health`, `/ready`, `/metrics`, `/openapi.json`, and `/workflows/webhooks/*` are anonymous and do not require a token even when `AUTH_REQUIRED=true`.

## Workflow Management

### Create Workflow

Creates a new workflow with revision 1 and a `latest` alias.

```bash
curl -X POST http://localhost:3000/workflows/definitions \
  -H "Content-Type: application/json" \
  -d '{
    "id": "my_workflow",
    "name": "My Workflow",
    "description": "A sample workflow",
    "steps": {
      "start": {
        "id": "start",
        "type": "trigger",
        "pluginType": "manual",
        "config": {}
      },
      "greet": {
        "id": "greet",
        "type": "module",
        "pluginType": "log",
        "config": {"level": "info", "message": "Hello!"}
      }
    },
    "connections": [
      {"id": "c1", "from": "start", "to": "greet"}
    ]
  }'
```

**Response:** `201 Created` with the workflow record including revision number.

### List Workflows

```bash
curl "http://localhost:3000/workflows/definitions?page=1&limit=20"
```

Returns a paginated envelope:

```json
{
  "data": [...],
  "page": 1,
  "limit": 20,
  "total": 5
}
```

### Get Workflow

```bash
curl http://localhost:3000/workflows/definitions/my_workflow
```

### Update Workflow

Creates a new revision. The workflow definition is immutable per revision.

```bash
curl -X PUT http://localhost:3000/workflows/definitions/my_workflow \
  -H "Content-Type: application/json" \
  -d '{
    "id": "my_workflow",
    "name": "My Workflow (v2)",
    "steps": { ... },
    "connections": [ ... ]
  }'
```

### Delete Workflow

```bash
curl -X DELETE http://localhost:3000/workflows/definitions/my_workflow
```

### Validate Workflow Definition

Validates the graph without saving.

```bash
curl -X POST http://localhost:3000/workflows/definitions/my_workflow/validate \
  -H "Content-Type: application/json" \
  -d '{ ... workflow definition ... }'
```

Returns validation errors if any:

```json
{
  "type": "graph-invalid",
  "status": 400,
  "title": "Workflow graph validation failed",
  "errors": [
    {"path": "steps.fetch", "message": "Unknown plugin type: invalid-plugin"}
  ]
}
```

## Revisions

### List Revisions

```bash
curl http://localhost:3000/workflows/definitions/my_workflow/revisions
```

### Get Specific Revision

```bash
curl http://localhost:3000/workflows/definitions/my_workflow/revisions/1
```

## Aliases

### List Aliases

```bash
curl http://localhost:3000/workflows/definitions/my_workflow/aliases
```

### Activate Alias

Activates an alias pointing to a specific revision. Triggers register only on activation.

```bash
curl -X POST http://localhost:3000/workflows/definitions/my_workflow/aliases \
  -H "Content-Type: application/json" \
  -d '{"name": "production", "revision": 2}'
```

## Executions

### Start Execution

```bash
curl -X POST http://localhost:3000/workflows/definitions/my_workflow/execute \
  -H "Content-Type: application/json" \
  -d '{
    "inputs": {"url": "https://httpbin.org/get"},
    "correlationKey": "request-123"
  }'
```

**Response:**

```json
{
  "executionId": "exec_abc123",
  "workflowId": "my_workflow",
  "revision": 1,
  "status": "running"
}
```

### List Executions

```bash
curl "http://localhost:3000/workflows/executions?page=1&limit=20"
```

### Get Execution Record

```bash
curl http://localhost:3000/workflows/executions/exec_abc123
```

### Get Live Execution State

Returns the full execution state including step outputs, pending waits, and current steps.

```bash
curl http://localhost:3000/workflows/executions/exec_abc123/state
```

**Response:**

```json
{
  "workflowId": "my_workflow",
  "revision": 1,
  "executionId": "exec_abc123",
  "status": "completed",
  "inputs": {"url": "https://httpbin.org/get"},
  "variables": {"statusCode": 200},
  "steps": {
    "fetch": {
      "status": "completed",
      "items": [{"statusCode": 200, "body": {...}}],
      "outputs": {"statusCode": 200, "body": {...}},
      "startedAt": "2026-04-10T10:00:00Z",
      "completedAt": "2026-04-10T10:00:01Z"
    }
  },
  "execution": {
    "id": "exec_abc123",
    "workflowId": "my_workflow",
    "revision": 1,
    "startedAt": "2026-04-10T10:00:00Z"
  },
  "pendingWaits": [],
  "currentSteps": [],
  "startedAt": "2026-04-10T10:00:00Z",
  "updatedAt": "2026-04-10T10:00:02Z",
  "completedAt": "2026-04-10T10:00:02Z"
}
```

### Get Pending Signals

```bash
curl http://localhost:3000/workflows/executions/exec_abc123/pending-signals
```

### Get Step Records

```bash
curl http://localhost:3000/workflows/executions/exec_abc123/steps
```

### Get Specific Step

```bash
curl http://localhost:3000/workflows/executions/exec_abc123/steps/fetch
```

### Cancel Execution

```bash
curl -X POST http://localhost:3000/workflows/executions/exec_abc123/cancel \
  -H "Content-Type: application/json" \
  -d '{"reason": "No longer needed"}'
```

## Signal Delivery

### Deliver Signal to Specific Execution

```bash
curl -X POST http://localhost:3000/workflows/executions/exec_abc123/signals/approval \
  -H "Content-Type: application/json" \
  -d '{
    "payload": {"approved": true, "reviewer": "alice"},
    "idempotencyKey": "approval-001"
  }'
```

### Deliver Signal by Correlation Key

Routes to an existing execution or starts a new one (signalWithStart):

```bash
curl -X POST http://localhost:3000/workflows/signals/approval \
  -H "Content-Type: application/json" \
  -d '{
    "workflowId": "approval_flow",
    "correlationKey": "order-456",
    "payload": {"approved": true}
  }'
```

## Plugins

### List Registered Plugins

```bash
curl http://localhost:3000/workflows/plugins
```

Returns all plugin descriptors:

```json
[
  {
    "name": "log",
    "version": "1.0.0",
    "pluginType": "module",
    "description": "Emit a structured log entry...",
    "category": "control-flow",
    "configSchema": {...},
    "inputPorts": [...],
    "outputPorts": [...]
  },
  ...
]
```

## Events (SSE)

### Subscribe to Execution Events

Server-Sent Events stream for live execution updates:

```bash
curl -N http://localhost:3000/workflows/executions/exec_abc123/events
```

Events include step started, step completed, step failed, execution completed, etc.

## WebSocket Bridge

The WebSocket bridge provides real-time execution events to UI clients.

### Connect

```
ws://localhost:3000/workflows/ws
```

The bridge forwards events from the engine's event bus to all connected WebSocket clients. The UI subscribes to specific execution IDs and receives updates as they happen.

## Authentication (production)

When `AUTH_REQUIRED=true` (production mode), the API requires a Bearer JWT token:

```bash
curl -H "Authorization: Bearer <jwt-token>" \
  http://localhost:3000/workflows/definitions
```

Anonymous routes (health, ready, metrics, OpenAPI, webhooks) are always accessible.

In development mode (`AUTH_REQUIRED` not set or `false`), authentication is not enforced.

### Organization Isolation

Organization isolation is **absolute**. Every caller enters with a single-org credential — a user/session token, an execution service token, or a webhook whose registration resolves to one org. There is no cross-org header or route-level opt-in: an org mismatch collapses to `404` (existence is never disclosed).

## Error Responses

The API uses RFC 7807 Problem Details for error responses:

```json
{
  "type": "https://workflow-system/problems/not-found",
  "status": 404,
  "title": "Not Found",
  "detail": "Workflow 'unknown_id' not found",
  "instance": "/workflows/definitions/unknown_id"
}
```

Common error types:

| Type | Status | Description |
|------|--------|-------------|
| `graph-invalid` | 400 | Workflow definition validation failed |
| `not-found` | 404 | Resource not found |
| `executor-unavailable` | 503 | Executor not wired (start, cancel, state query) |
| `authentication-required` | 401 | Missing or invalid Bearer token |
| `permission-denied` | 403 | Insufficient permissions |

## Webhook Ingress

Webhooks registered by trigger plugins are accessible at:

```bash
curl -X POST http://localhost:3000/workflows/webhooks/<path> \
  -H "Content-Type: application/json" \
  -d '{"event": "push", "repo": "my-app"}'
```

The trigger manager routes the request to the appropriate trigger plugin instance.

## Where next

- [Plugin catalog](./plugin-catalog.md) — every shipped plugin with config and examples.
- [Authoring Gotchas](../guides/gotchas.md) — deploying via the API (normalize → create + activate a named alias), the `signal-wait` timeout string/number mismatch, and api/worker version-skew failures.
- [`np-workflow` skill](https://github.com/nullplatform/np-claude-skills) — Claude Code plugin that wraps this whole flow as `/np-workflow` subcommands.
