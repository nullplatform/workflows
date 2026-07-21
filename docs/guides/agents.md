# Building Agents with `claude-code-agent`

This guide covers the agent-specific features that turn workflows into
conversational, tool-using agents: resumable sessions, plugins and
workflows as tools, and how tool execution works when the agent runs
inside an E2B microVM. For the Slack conversational loop (trigger → agent
→ wait for a human reply → loop), see [Slack](./slack.md) — this
guide covers the agent step itself.

## The agent step in one example

```yaml
- id: agent
  type: module
  plugin_type: claude-code-agent
  join_strategy: any            # required when a loop re-enters this node
  config:
    conversationId: support-thread    # fixed id → turns share one conversation
    resumeSession: true               # reuse the SAME Claude session across turns
    model: claude-sonnet-4-5
    systemPrompt: |
      You are a commercial assistant. For ANY price quote you MUST use the
      cotizador-interno tool — never compute the formula yourself.
    userPrompt: "${{ inputs.userMessage }}"
    tools:
      - type: workflow
        workflow: cotizador-interno   # wf_ id or client key
        alias: latest
        timeoutMs: 120000
    outputSchema:
      type: object
      properties:
        reply: { type: string }
        done:  { type: boolean }
      required: [reply, done]
```

`outputSchema` forces a structured final answer — the idiomatic way to let
downstream steps branch on the agent's decision (`conditional` on
`$item.done`).

## Resumable sessions (`resumeSession: true`)

Within one execution, a fixed `conversationId` plus `resumeSession: true`
keeps ONE Claude session alive across every visit to the node (loop
iterations, signal re-entries):

- On the E2B runner the sandbox is **paused** (filesystem + memory frozen,
  storage-only cost) after each turn and **resumed** on the next; the
  transcript lives in the VM's `~/.claude` and continuity comes from
  `claude --resume <sessionId>`. The compact state that crosses turns
  (`lastSessionId`, `sandboxId`, a capped exchange log) travels in the
  step's `nodeContext` — it survives worker restarts because it is part of
  workflow state.
- **Degradation is automatic**: if the paused VM expired or the session is
  gone, the agent starts a fresh session seeded with a summary built from
  the exchange log, instead of failing the step.
- **Cleanup is automatic**: the sandbox is registered as an execution
  resource and killed by the engine's finalizer when the execution reaches
  a terminal state. A forced runtime termination skips finalizers; the VM
  then auto-pauses and expires per E2B retention (bounded storage cost,
  never an orphan running forever).
- Cross-execution conversations are out of scope: each Slack message
  starting a NEW execution starts a new conversation. The conversational
  pattern is the loop-within-one-execution of guide 17.

## Tools: the unified `tools` list

One list exposes callable tools to the agent's reasoning loop; each entry
picks a `type`. The tool spec — name, description, JSON argument schema —
is derived from the target's metadata, so a well-documented plugin or
workflow is automatically a well-described tool.

```yaml
tools:
  # Another workflow as a tool: runs as a child execution, awaited.
  - type: workflow
    workflow: deploy-service   # wf_ id or client key
    alias: live                # pins the revision line (default: latest)
    name: deploy_service       # optional tool-name override
    timeoutMs: 600000          # per-call cap (default 10 min)
    presetInputs: { env: prod }
  # A registry plugin as a tool: executed host-side.
  - type: plugin
    plugin: np-api-call
    presetInputs: { method: GET }   # pinned; hidden from the model
```

> Migration note: the former `toolPlugins`/`toolWorkflows` keys are
> rejected by config validation with a hint — rewrite each entry as a
> `tools` item with `type: plugin` / `type: workflow`.

- The tool's argument schema comes from the workflow's `inputs`
  declarations (type/description/required/default per field). Document
  your workflow inputs well — the agent reads those descriptions.
- Calling the tool launches a **child execution** through the sub-workflow
  launcher: recursion caps, a child-scoped service token, and parent/child
  audit links all apply. The call is visible as a normal execution.
- **Synchronous**: the agent waits for the child's outputs (up to
  `timeoutMs`). On child failure or timeout the MODEL receives an error
  tool-result and can react — the agent step itself never fails because a
  tool misbehaved. On timeout the child keeps running; the result carries
  its executionId.
- `presetInputs` pin author-controlled arguments the model cannot see or
  override.

### Security model (why tools are safe to hand to a model)

- The model only emits tool calls with business arguments. Tool execution
  happens **host-side** in the worker (or brokered to it — see below);
  service tokens and credentials never enter the model's context.
- Credentials a tool-workflow needs internally (`${{ secrets.X }}`) are
  resolved by the CHILD execution at its own config-entries scope — the
  agent never sees them.
- ⚠️ **Tool outputs enter the model's context.** Don't return secrets in a
  tool-workflow's `outputs`.

## How tools work when the agent runs in E2B (production)

In production the agent runs inside an E2B microVM. Tools still execute
host-side, bridged by the **Engine Call Channel**:

- The E2B template ships a guest supervisor that registers an MCP stub with
  the `claude` CLI. Tool specs are computed host-side and handed to the
  stub as a static list; each tool call becomes an `engine_call` frame on
  the run's channel; the worker executes the tool (same adapters as the
  in-process runner) and returns only the serialized result to the VM.
- Authorization is host-side: the guest can only invoke tools the step's
  config declares (`ENGINE_CALL_DENIED` otherwise), capped at 4 in-flight
  calls and 256KB per payload/result.
- Placement targets can restrict which engine-call kinds an environment
  allows (`WORKFLOW_PLACEMENT_CONFIG` → `targets.<t>.engineCalls.kinds`).

### Ops notes

- **Template**: agent tools require the `nullplatform-agent` sandbox template
  version that carries the guest supervisor. The template is republished after
  an engine upgrade. Agents WITHOUT tools are unaffected by the template
  version (the raw CLI path is unchanged).
- Agent activity timeout: long tool-workflows count against the agent
  step's activity timeout (default 30 min; override per step with
  `metadata.executionTimeoutMs`). Keep tool-workflows short-running — a
  workflow with a human-approval wait makes a poor synchronous tool.

## Limits (v1, by design)

- Tool calls are synchronous; no fire-and-forget mode yet.
- A tool-call timeout does not cancel the child execution.
- Tool results are capped at 16KB (truncated with a marker).
- `type: plugin` tools run host-side with the plugin's own config
  requirements; test them with `createPluginTest` like any plugin.
