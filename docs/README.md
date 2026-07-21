# Workflow System Documentation

Reference and concept docs for authoring workflows on the Nullplatform workflow
engine — a plugin-first orchestration engine with n8n-style data flow, signals as
the single pause primitive, and a descriptor-driven canvas.

For the hands-on loop (author → validate → test → publish) start with
[../AUTHORING.md](../AUTHORING.md). Suite-specific docs (architecture, bring-up
order, decisions) live inside each suite's own directory.

## Concepts

- [How it works](./concepts/how-it-works.md) — the mental model in one page: what a workflow is, how it versions, how it runs, what you can observe.
- [Data model](./concepts/data-model.md) — items-based data flow and `executeMode` (per-item vs whole-batch).
- [Expressions](./concepts/expressions.md) — `${{ … }}` syntax, the scope roots (`workflow.inputs`, `variables`, `steps`, `$item`…), operators, and truthiness.
- [Loops and streaming](./concepts/loops-and-streaming.md) — the streaming-pagination pattern, engine fan-out, back-edge cycles, `split-in-batches`, `forEach`, sub-workflow iteration.
- [Signals and waits](./concepts/signals-and-waits.md) — the single pause primitive and the wait plugins built on it.
- [Triggers](./concepts/triggers.md) — how executions start, and the activate-on-alias rule.
- [Config entries](./concepts/config-entries.md) — folder/workflow-scoped secrets (`${{ secrets.X }}`) and shared vars (`${{ vars.X }}`), with IaC bootstrap examples.

## Reference

- [YAML & DSL](./reference/yaml.md) — the workflow definition formats and field reference.
- [REST API](./reference/rest-api.md) — a copy-paste publish/trigger/inspect quickstart, then the full endpoint reference.
- [Plugin catalog](./reference/plugin-catalog.md) — every shipped plugin with config schema and an example.
- [Built-in plugins](./reference/built-in-plugins.md) — conceptual tour of the plugin families.

## Guides

- [nullplatform integration](./guides/nullplatform-integration.md) — `np-agent-command`, `np-action-item`, and the AIOps patterns.
- [Slack](./guides/slack.md) — triggers, messages, button approvals, thread waits, and the conversational-agent loop.
- [Agents](./guides/agents.md) — the `claude-code-agent` step: resumable sessions, and plugins/workflows as tools.
- [Authoring gotchas](./guides/gotchas.md) — symptom → cause → fix for the sharp edges (expression scope, deciders & joins, error routing, deploy-time traps).
- [Scale limits & fan-out observability](./guides/scale-and-fanout.md) — the runtime ceilings on org-scale runs and their mitigations, plus fan-out progress and parallelism knobs.
- [AI suggestions that render well in the UI](./ai-suggestions-ux.md) — rules for workflows that create action-item suggestions.
