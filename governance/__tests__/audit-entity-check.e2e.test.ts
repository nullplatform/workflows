/**
 * @file E2E for `audit-entity-check` (audit-coverage checklist gate).
 *
 * The deterministic logic lives in `code-exec` steps (signals / gather /
 * resolve / resolve_carryover) — network access to GitHub and the NP APIs — so
 * these tests stub `code-exec` BY STEP ID and assert the graph routing the
 * design relies on, plus the payload each resolve receives:
 *
 *   - gather → mode=carry_over  → resolve_carryover, agent NEVER runs.
 *   - gather → mode=analyze     → claude-code-agent → resolve.
 *   - the lake queries and signals always run before gather.
 *   - a lake query failure lands on `signals` instead of failing the run.
 *   - each `error_handling.fallback_step` resolves the item on its own node.
 *
 * The bodies of those `code-exec` steps are covered separately, against the
 * source in the YAML, by `audit-entity-check.logic.test.ts`.
 *
 * Stubs:
 *   - `np-checklist-trigger` passthrough (workflow inputs flow through).
 *   - `np-lake-query` returns canned rows.
 *   - `code-exec` switched on ctx step id; captures the resolve inputs.
 *   - `claude-code-agent` returns a canned verdict.
 *   - `np-checklist-item-progress` / `np-checklist-item-resolve` passthrough.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { IStepResult, IWorkflowContextSnapshot } from '@nullplatform/workflow-kit/test';

import { runWorkflowE2E } from '@nullplatform/workflow-kit/test';

const WF_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'audit-entity-check.yaml');

const TRIGGER_OUTPUTS = {
  kind: 'audit-entity-check',
  runId: 'crun_test',
  itemId: 'audit_entity_check',
  callbackUrl: 'https://approval-api.test/approval/9001/checklist/items/audit_entity_check',
  callbackToken: 'tok_signed_xxx',
  inputs: {
    application_id: 924036609,
    release_id: 734671234,
    check_id: 'audit_entity_check',
  },
  approvalRequestId: 9001,
  applicationId: 924036609,
  build: { branch: 'main', commit: { id: 'cccc3333cccc3333cccc3333cccc3333cccc3333' } },
  nrn: 'organization=<org-id>:account=<account-id>:namespace=<ns-id>:application=924036609',
};

const LAKE_ROWS = [
  {
    entity: 'runbook',
    first_seen: '2026-08-01',
    writes: 12,
    methods: ['POST'],
    sample_entity_id: 'rb_1',
  },
];

const SIGNALS_CLEAN = {
  data_flags: [],
  degraded_sources: [],
  entity_config_keys: ['user', 'application', 'notification'],
  entity_config_trusted: true,
  new_entities: LAKE_ROWS,
  degraded_entities: [],
  probes: [],
  signals_view: '### Data flags (0)\n(none)',
};

const GATHER_CARRY_OVER = {
  mode: 'carry_over',
  repo: 'nullplatform/some-api',
  branch: 'main',
  analyzed_sha: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111',
  prev: {
    approval_id: 8000,
    sha: 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222',
    status: 'passed',
    findings: [],
    entities: [{ entity: 'runbook', verdict: 'ok' }],
    markdown: '### Audit coverage — PASSED',
  },
  changed_count: 2,
};

const GATHER_ANALYZE = {
  mode: 'analyze',
  scope: 'diff',
  repo: 'nullplatform/some-api',
  branch: 'main',
  analyzed_sha: 'cccc3333cccc3333cccc3333cccc3333cccc3333',
  prev: null,
  changed_count: 3,
  total_files: 12,
  prev_findings_view: '(none)',
  llm_view: '## Repository: nullplatform/some-api …',
};

const AGENT_VERDICT = {
  status: 'failed',
  summary: 'A new write route emits an entity missing from the enhancer entityConfig.',
  findings: [
    {
      area: 'missing_entity_config',
      entity: 'runbook',
      file: 'src/routes/runbook.ts',
      issue: 'POST /runbook emits entity "runbook" with no entityConfig entry',
      fix: 'Add a STANDARD entityConfig entry for "runbook" in the enhancer app.js',
    },
  ],
  resolved_findings: [],
  entities: [{ entity: 'runbook', source: 'POST /runbook', verdict: 'misconfigured' }],
  fix_instructions_md: 'Add `runbook` to entityConfig in app.js.',
};

interface StepCtx {
  stepId?: string;
  step?: { id?: string };
}

interface CapturedResolves {
  resolve?: Record<string, unknown>;
  resolve_carryover?: Record<string, unknown>;
  signalsRan: boolean;
  agentRan: boolean;
  snapshot: IWorkflowContextSnapshot;
}

function stepRan(snapshot: IWorkflowContextSnapshot, id: string): boolean {
  return snapshot.steps[id] !== undefined;
}

/** Step ids left in an error state — nothing but a fallback source may be. */
function erroredSteps(snapshot: IWorkflowContextSnapshot): string[] {
  return Object.entries(snapshot.steps)
    .filter(([, s]) => (s as { error?: unknown } | undefined)?.error !== undefined)
    .map(([id]) => id);
}

const OK_STUB = () => ({
  status: 'success' as const,
  outputs: { ok: true, statusCode: 200 },
  activePorts: ['default'],
});

const TRIGGER_STUB = {
  handler: () => ({ status: 'success' as const, outputs: {}, activePorts: ['default'] }),
  registryType: 'trigger' as const,
};

const LAKE_STUB = () => ({
  status: 'success' as const,
  outputs: { rows: LAKE_ROWS, rowCount: LAKE_ROWS.length },
  items: LAKE_ROWS,
  activePorts: ['default'],
});

/** A step stub that fails, so `error_handling.fallback_step` takes over. */
const failure = (message: string): IStepResult => ({
  status: 'failure',
  error: { message, code: 'CODE_EXEC_ERROR', retryable: false },
});

interface RunOptions {
  gatherOutput?: Record<string, unknown>;
  /** Step id whose stub must fail (`signals`, `gather` or `audit_agent`). */
  failStep?: string;
  lakeStub?: () => IStepResult;
}

async function run(options: RunOptions = {}): Promise<CapturedResolves> {
  const { gatherOutput = GATHER_ANALYZE, failStep, lakeStub = LAKE_STUB } = options;
  const captured: Partial<CapturedResolves> = { signalsRan: false, agentRan: false };
  const result = await runWorkflowE2E({
    yamlPath: WF_PATH,
    inputs: TRIGGER_OUTPUTS,
    pluginStubs: {
      'np-checklist-trigger': TRIGGER_STUB,
      'np-checklist-item-progress': OK_STUB,
      'np-checklist-item-resolve': OK_STUB,
      'np-lake-query': lakeStub,
      // `set-variable` is left unstubbed on purpose: the real plugin runs, so
      // the degraded-source variable is asserted against real behaviour.
      'code-exec': (ctx: StepCtx): IStepResult => {
        const stepId = ctx.stepId ?? ctx.step?.id;
        if (stepId === failStep) return failure(`boom ${stepId}`);
        if (stepId === 'signals') {
          captured.signalsRan = true;
          return { status: 'success', outputs: SIGNALS_CLEAN, activePorts: ['default'] };
        }
        if (stepId === 'gather') {
          return { status: 'success', outputs: gatherOutput, activePorts: ['default'] };
        }
        // resolve / resolve_carryover: keep the resolved inputs for assertions.
        captured[stepId as 'resolve' | 'resolve_carryover'] =
          (ctx as { inputs?: Record<string, unknown> }).inputs ?? {};
        return { status: 'success', outputs: { resolved: true }, activePorts: ['default'] };
      },
      'claude-code-agent': (ctx: StepCtx): IStepResult => {
        if ((ctx.stepId ?? ctx.step?.id) === failStep) return failure('boom audit_agent');
        captured.agentRan = true;
        return { status: 'success', outputs: AGENT_VERDICT, activePorts: ['default'] };
      },
    },
  });
  return { ...(captured as CapturedResolves), snapshot: result.finalSnapshot };
}

describe('audit-entity-check — routing', () => {
  it('carry_over skips the agent and resolves via resolve_carryover', async () => {
    const captured = await run({ gatherOutput: GATHER_CARRY_OVER });
    expect(captured.signalsRan).toBe(true);
    expect(captured.resolve_carryover).toBeTruthy();
    expect(captured.resolve).toBeUndefined();
    expect(captured.agentRan).toBe(false);
    expect(erroredSteps(captured.snapshot)).toEqual([]);
  });

  it('analyze routes through the audit agent to resolve', async () => {
    const captured = await run();
    expect(captured.signalsRan).toBe(true);
    expect(captured.agentRan).toBe(true);
    expect(captured.resolve).toBeTruthy();
    expect(captured.resolve_carryover).toBeUndefined();
    expect(erroredSteps(captured.snapshot)).toEqual([]);
  });

  it('runs both lake queries before signals', async () => {
    const captured = await run();
    expect(stepRan(captured.snapshot, 'lake_new_entities')).toBe(true);
    expect(stepRan(captured.snapshot, 'lake_empty_rows')).toBe(true);
    expect(stepRan(captured.snapshot, 'signals')).toBe(true);
  });

  it('reaches signals anyway when a lake query fails', async () => {
    const captured = await run({
      lakeStub: () => failure('NP_LAKE_5XX: gateway timeout'),
    });
    expect(stepRan(captured.snapshot, 'lake_new_degraded')).toBe(true);
    expect(captured.signalsRan).toBe(true);
    expect(captured.resolve).toBeTruthy();
    expect(stepRan(captured.snapshot, 'resolve_failure_signals')).toBe(false);
    // The error survives into the execution state, and signals gets it as an
    // input so it can report the degraded source.
    expect(captured.snapshot.variables?.['lake_new_entities_error']).toBe(
      'NP_LAKE_5XX: gateway timeout',
    );
    expect(captured.snapshot.steps['signals']?.inputs?.['new_entities_error']).toBe(
      'NP_LAKE_5XX: gateway timeout',
    );
    expect(captured.snapshot.steps['signals']?.inputs?.['new_entity_rows']).toBeUndefined();
  });
});

describe('audit-entity-check — resolve payloads', () => {
  it('hands the agent verdict and the analysis scope to resolve', async () => {
    const captured = await run();
    const inputs = captured.resolve as {
      verdict?: { status?: string; findings?: unknown[] };
      scope?: string;
      analyzed_sha?: string;
      data_flags?: unknown[];
      degraded_sources?: unknown[];
      item_id?: string;
    };
    expect(inputs.verdict?.status).toBe('failed');
    expect(inputs.verdict?.findings).toHaveLength(1);
    expect(inputs.scope).toBe('diff');
    expect(inputs.analyzed_sha).toBe(GATHER_ANALYZE.analyzed_sha);
    expect(inputs.item_id).toBe('audit_entity_check');
    // Both signal channels reach the item, not just the data flags.
    expect(inputs.data_flags).toEqual([]);
    expect(inputs.degraded_sources).toEqual([]);
  });

  it('hands the previous verdict to resolve_carryover', async () => {
    const captured = await run({ gatherOutput: GATHER_CARRY_OVER });
    const inputs = captured.resolve_carryover as {
      prev?: { status?: string; sha?: string };
      changed_count?: number;
      degraded_sources?: unknown[];
    };
    expect(inputs.prev?.status).toBe('passed');
    expect(inputs.prev?.sha).toBe(GATHER_CARRY_OVER.prev.sha);
    expect(inputs.changed_count).toBe(2);
    expect(inputs.degraded_sources).toEqual([]);
  });
});

describe('audit-entity-check — failure fallbacks', () => {
  it('skips the item when signal collection crashes', async () => {
    const captured = await run({ failStep: 'signals' });
    expect(stepRan(captured.snapshot, 'resolve_failure_signals')).toBe(true);
    expect(stepRan(captured.snapshot, 'gather')).toBe(false);
    expect(captured.agentRan).toBe(false);
    expect(captured.resolve).toBeUndefined();
    expect(captured.snapshot.steps['resolve_failure_signals']?.inputs?.['status']).toBe('skipped');
    expect(String(captured.snapshot.steps['resolve_failure_signals']?.inputs?.['message'])).toContain(
      'boom signals',
    );
  });

  it('fails the item when the analysis preparation crashes', async () => {
    const captured = await run({ failStep: 'gather' });
    expect(stepRan(captured.snapshot, 'resolve_failure_gather')).toBe(true);
    expect(stepRan(captured.snapshot, 'route')).toBe(false);
    expect(captured.agentRan).toBe(false);
    expect(captured.snapshot.steps['resolve_failure_gather']?.inputs?.['status']).toBe('failed');
    expect(String(captured.snapshot.steps['resolve_failure_gather']?.inputs?.['message'])).toContain(
      'boom gather',
    );
  });

  it('fails the item when the audit agent crashes', async () => {
    const captured = await run({ failStep: 'audit_agent' });
    expect(stepRan(captured.snapshot, 'resolve_failure_agent')).toBe(true);
    expect(captured.resolve).toBeUndefined();
    expect(captured.snapshot.steps['resolve_failure_agent']?.inputs?.['status']).toBe('failed');
    expect(String(captured.snapshot.steps['resolve_failure_agent']?.inputs?.['message'])).toContain(
      'boom audit_agent',
    );
  });
});
