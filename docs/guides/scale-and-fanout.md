# Scale Limits & Fan-out Observability

What actually bounds an org-scale run (thousands of items through a
fan-out) and how the engine keeps those runs observable. Every limit here
was hit by a real org-scale run; the mitigations all ship in the engine.

## The three runtime ceilings

The hosted (durable) runtime enforces hard limits on how much data a single
execution may carry. Each one was hit in production and has an engine-side
mitigation:

| Ceiling | Limit | What hits it | Engine mitigation |
|---|---|---|---|
| Workflow **history** size | ~50MB (hard kill) | every step-activity input used to carry the FULL context snapshot (~540KB × 97 fan-out items ≈ 52MB) | `trimContextSnapshot`: non-decider activities travel WITHOUT `steps`/`stepHistory`; deciders keep them (they evaluate raw `steps.X`) |
| Single **payload** | ~2MB | a runner result embedding the final snapshot | `IWorkflowRunnerOutput` deliberately carries outputs only; per-step data persists incrementally via step reports |
| Workflow task **message** | ~4MB | **query responses ride the workflow task message**: `getState` returning ~3MB of live state got the run TERMINATED with an oversized-message error — polling `/state` killed it | `boundStateForTransport(state, 64KB/step)` in BOTH executors' `getState`: oversized step payloads travel as `{_truncated: true, payloadBytes}` stubs; status/timestamps/error/fanOut always survive. Full payloads: `GET /executions/:id/steps/:stepId` (storage read, never touches the running workflow) |

Complementary source-side trims: per-step `outputProjection`, step output byte
caps, and `maxRows` on lake queries.

## Platform terminations are mapped, not opaque

A forced runtime termination surfaces as a structured execution error —
`HISTORY_LIMIT_EXCEEDED` (with the fan-out/projection remediation hints) or
`EXECUTION_TERMINATED` — both stating "No step failed — steps that
completed kept their results", because the canvas stays green on these.
The FE renders it as the execution error banner (observer page + editor
drawer) and as a terminal `Execution failed: <cause>` log entry.

## Fan-out observability

Two fan-out mechanisms share the same progress plumbing:
`step.forEach` (explicit, `ForEachCoordinator`) and implicit per-item
dispatch (module steps receiving N upstream items, `executeMode: 'each'`).

**Live** (while the step runs): the context tracks in-flight steps
(`markStepInFlight` / `setStepFanOutProgress(stepId, done, total, failed)`),
and `overlayInFlightSteps` merges them into every `getState` response as
`steps.X.fanOut = { done, total, failed? }` plus `currentSteps`. Without
this, the recorded per-item reports make a running fan-out read as
"completed" (last item's terminal status) for minutes.

**Terminal** (after the step settles): the aggregate persists as step
`metadata.fanOut = { done, total, failed? }` on both fan-out paths, so a
finished execution can still render "1000 of 1000 · 2 failed".
Caveat: on the hosted runtime the persisted step ROW is written by the
per-item activity reports (last-wins per `(executionId, stepId, attempt)`),
so the aggregate reaches storage only via the in-sandbox context — durable
aggregate persistence on the hosted runtime, and child sub-workflow outputs
reaching the aggregate (summary steps otherwise count 0), are known open
items.

**Child executions**: each sub-workflow fan-out item runs as its own
execution with id `parent:stepId:itemIndex:attempt`. The `itemIndex`
component is load-bearing — without it (pre-fix) all N children shared one
id and overwrote each other's rows/reports/logs.

## Fan-out parallelism knobs

| Mechanism | Knob | Default | Notes |
|---|---|---|---|
| `step.forEach` | `forEach.parallel: true` + `forEach.maxConcurrency` | sequential; 5 when parallel | a 1000-item sequential sub-workflow fan-out took ~50 min; parallel 5 ≈ 3× faster |
| Implicit per-item | `step.metadata.maxParallelism` → `config.maxParallelism` → descriptor `maxParallelism` | 5 | precedence in that order |
| Retry interplay | `error_handling.retry_policy.max_attempts > 1` **disables implicit fan-out** on that step | — | put the retry on the steps INSIDE the sub-workflow instead (e.g. the create call), with `jitter` so parallel children's retries don't re-collide |

Known gaps (deliberate, tracked): `maxConcurrency` accepts no
expressions (literal only — no per-run override without a new revision),
there is NO platform-level cap yet (a tenant can request an arbitrarily
large value against the shared multi-tenant runtime), and the FE node panel
does not expose the `forEach` section (YAML only).

## Monitoring big runs

- `/state` on a RUNNING execution is live (executor query) — safe at any
  run size once `boundStateForTransport` is deployed. Against an older
  runtime, poll `GET /executions/:id` (record only) and count children via
  `GET /executions?workflowId=<child-wf>` instead.
- Step detail (`/executions/:id/steps/:stepId`) always serves full
  payloads from storage and is safe to hammer.
