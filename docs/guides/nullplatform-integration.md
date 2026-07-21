# nullplatform Integration

The workflow system includes built-in plugins for integrating with the nullplatform API. These plugins enable infrastructure automation, AIOps workflows, and action item management.

## Plugins Overview

| Plugin | Description | API Endpoint |
|--------|-------------|--------------|
| `np-agent-command` | Execute commands on nullplatform agents | `/agent/command` |
| `np-action-item-*` | Granular action item plugins (create, get, list, update, defer, resolve, reject, close, reopen) | `/governance/action_item` |

These plugins share common configuration:

```yaml
config:
  apiBaseUrl: "https://api.nullplatform.com"   # default
  apiToken: "your-api-token"                   # or use secrets
```

The `apiToken` can be injected via step inputs or secrets rather than hardcoded in the config.

## np-agent-command

Executes commands on nullplatform agents via the Agent Command Execute API. Supports fire-and-forget or poll-for-completion modes.

### Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `command` | string | (required) | Command name to execute |
| `agentId` | string | `""` | Target agent ID |
| `parameters` | object | `{}` | Command parameters |
| `waitForCompletion` | boolean | `true` | Poll until command completes |
| `timeoutMs` | number | `300000` | Timeout in milliseconds |

### Example: Execute a kubectl command

```yaml
- id: deploy
  type: module
  pluginType: np-agent-command
  inputs:
    command: kubectl-apply
    agentId: "${{ workflow.inputs.agentId }}"
    parameters:
      namespace: "${{ steps.create_scope.outputs.scopeId }}"
      manifest: "${{ steps.generate_manifest.outputs.yaml }}"
    waitForCompletion: true
    timeoutMs: 120000
```

### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `commandId` | string | Unique command execution ID |
| `status` | string | Final status (`submitted`, `completed`, `failed`) |
| `result` | object | Full API response |
| `logs` | array | Command execution logs |

## np-action-item

Manages action items via the nullplatform Opportunities API. Supports the full lifecycle from creation through resolution.

### Supported Actions

| Action | Description |
|--------|-------------|
| `create` | Create a new action item |
| `get` | Get action item details |
| `list` | List action items (with filters) |
| `update` | Update action item fields |
| `add-suggestion` | Attach a suggestion to an action item |
| `approve-suggestion` | Approve a suggestion |
| `defer` | Defer the action item |
| `resolve` | Mark as resolved |
| `reject` | Reject the action item |
| `close` | Close the action item |
| `reopen` | Reopen a closed action item |

### Configuration (create)

| Field | Type | Description |
|-------|------|-------------|
| `action` | string | `"create"` |
| `title` | string | Action item title |
| `categoryId` | string | Category identifier |
| `priority` | string | `low`, `medium`, `high`, `critical` |
| `nrn` | string | nullplatform Resource Name |
| `value` | number | Optional numeric value |
| `metadata` | object | Free-form metadata |

### Example: Full Action Item Lifecycle

```yaml
steps:
  # 1. Create an action item
  - id: create_item
    type: module
    pluginType: np-action-item
    inputs:
      action: create
      title: "Optimize database queries"
      categoryId: "performance"
      priority: high
      nrn: "nrn:nullplatform:app:my-app"
      metadata:
        source: "aiops-workflow"
        detectedAt: "${{ execution.startedAt }}"

  # 2. Add a suggestion
  - id: add_suggestion
    type: module
    pluginType: np-action-item
    inputs:
      action: add-suggestion
      actionItemId: "${{ steps.create_item.outputs.actionItemId }}"
      suggestion:
        type: "query-optimization"
        description: "Add index on users.email column"
        impact: "Reduce query time by 80%"
        commands:
          - "CREATE INDEX idx_users_email ON users(email)"
    dependsOn: [create_item]

  # 3. Wait for approval
  - id: wait_approval
    type: module
    pluginType: signal-wait
    config:
      signalName: "suggestion-approved"
      timeout: "48h"
    dependsOn: [add_suggestion]

  # 4. Approve and resolve
  - id: approve
    type: module
    pluginType: np-action-item
    inputs:
      action: approve-suggestion
      actionItemId: "${{ steps.create_item.outputs.actionItemId }}"
      suggestionId: "${{ steps.add_suggestion.outputs.suggestionId }}"
    dependsOn: [wait_approval]

  - id: resolve
    type: module
    pluginType: np-action-item
    inputs:
      action: resolve
      actionItemId: "${{ steps.create_item.outputs.actionItemId }}"
    dependsOn: [approve]
```

### List Action Items (Produces Workflow Items)

The `list` action emits results as both `outputs.items` and as workflow items for downstream per-item processing:

```yaml
- id: list_items
  type: module
  pluginType: np-action-item
  inputs:
    action: list
    filters:
      priority: high
      status: open

- id: process_each
  type: module
  pluginType: code-exec
  config:
    code: |
      // Each item from the list flows through here
      return { processed: true, itemId: inputs.id };
  dependsOn: [list_items]
```

## Example Workflows

Common AIOps patterns built on these plugins:

- **Cost optimization** — fetch resource usage data, analyze costs with an AI agent, create action items for optimization opportunities, and wait for approval before applying changes.
- **Security compliance** — scan infrastructure for security issues and create action items.
- **Infrastructure health** — monitor infrastructure health and trigger remediation.

The suites in this repo (for example the `cost` suite) are runnable versions of these patterns.

## Connecting to the nullplatform API

### Authentication

All np-* plugins accept an `apiToken` parameter. For production use, store the token as a secret:

```yaml
# In step inputs, reference a secret
inputs:
  apiToken: "${{ secrets.NP_API_TOKEN }}"
```

Store the value as a [config entry](../concepts/config-entries.md) and reference it as `${{ secrets.NP_API_TOKEN }}`; never hardcode the token in YAML.

### API Base URL

The default API base URL is `https://api.nullplatform.com`. Override it for testing or custom deployments:

```yaml
config:
  apiBaseUrl: "https://api.staging.nullplatform.com"
```

Or via workflow variables:

```yaml
variables:
  apiBaseUrl:
    initialValue: "https://api.nullplatform.com"

steps:
  - id: run_command
    type: module
    pluginType: np-agent-command
    inputs:
      apiBaseUrl: "${{ variables.apiBaseUrl }}"
      command: kubectl-apply
      parameters: { namespace: "default" }
```
