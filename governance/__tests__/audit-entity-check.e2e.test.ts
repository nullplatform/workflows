/**
 * @file E2E for `audit-entity-check` (audit-coverage checklist gate).
 *
 * The deterministic logic lives in `code-exec` steps (enhancer_config / gather /
 * resolve / resolve_carryover) — network access to GitHub and the NP APIs — so
 * these tests stub `code-exec` BY STEP ID and assert the graph routing the
 * design relies on, plus the payload each resolve receives:
 *
 *   - gather → mode=carry_over  → resolve_carryover, agent NEVER runs.
 *   - gather → mode=analyze     → claude-code-agent → resolve.
 *   - enhancer_config always runs before gather.
 *   - each `error_handling.fallback_step` resolves the item on its own node.
 *
 * The bodies of those `code-exec` steps are covered separately, against the
 * source in the YAML, by `audit-entity-check.logic.test.ts`.
 *
 * Stubs:
 *   - `np-checklist-trigger` passthrough (workflow inputs flow through).
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

const CONFIG_CLEAN = {
  degraded_sources: [],
  entity_config_keys: ['user', 'parameter', 'notification', 'nrn', 'default'],
  entity_config_trusted: true,
  entity_modes: { user: 'standard', notification: 'self_contained', nrn: 'nrn' },
  self_contained_entities: ['notification'],
  clients_keys: ['default', 'user', 'notification'],
  has_default_config: true,
  config_view: '### Enhancer entityConfig keys (5)',
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
  configRan: boolean;
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

/** A step stub that fails, so `error_handling.fallback_step` takes over. */
const failure = (message: string): IStepResult => ({
  status: 'failure',
  error: { message, code: 'CODE_EXEC_ERROR', retryable: false },
});

interface RunOptions {
  gatherOutput?: Record<string, unknown>;
  /** Step id whose stub must fail (`enhancer_config`, `gather`, `audit_agent`). */
  failStep?: string;
}

async function run(options: RunOptions = {}): Promise<CapturedResolves> {
  const { gatherOutput = GATHER_ANALYZE, failStep } = options;
  const captured: Partial<CapturedResolves> = { configRan: false, agentRan: false };
  const result = await runWorkflowE2E({
    yamlPath: WF_PATH,
    inputs: TRIGGER_OUTPUTS,
    pluginStubs: {
      'np-checklist-trigger': TRIGGER_STUB,
      'np-checklist-item-progress': OK_STUB,
      'np-checklist-item-resolve': OK_STUB,
      'code-exec': (ctx: StepCtx): IStepResult => {
        const stepId = ctx.stepId ?? ctx.step?.id;
        if (stepId === failStep) return failure(`boom ${stepId}`);
        if (stepId === 'enhancer_config') {
          captured.configRan = true;
          return { status: 'success', outputs: CONFIG_CLEAN, activePorts: ['default'] };
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
    expect(captured.configRan).toBe(true);
    expect(captured.resolve_carryover).toBeTruthy();
    expect(captured.resolve).toBeUndefined();
    expect(captured.agentRan).toBe(false);
    expect(erroredSteps(captured.snapshot)).toEqual([]);
  });

  it('analyze routes through the audit agent to resolve', async () => {
    const captured = await run();
    expect(captured.configRan).toBe(true);
    expect(captured.agentRan).toBe(true);
    expect(captured.resolve).toBeTruthy();
    expect(captured.resolve_carryover).toBeUndefined();
    expect(erroredSteps(captured.snapshot)).toEqual([]);
  });

  it('runs the enhancer config read before gather, and nothing else', async () => {
    const captured = await run();
    expect(stepRan(captured.snapshot, 'enhancer_config')).toBe(true);
    expect(stepRan(captured.snapshot, 'gather')).toBe(true);
    // The graph is exactly the static path: no lake query, no probe, no
    // re-entry node left over from the runtime signals it used to collect.
    expect(Object.keys(captured.snapshot.steps).sort()).toEqual([
      'audit_agent',
      'enhancer_config',
      'gather',
      'progress',
      'progress_analyzing',
      'resolve',
      'route',
      'trigger',
    ]);
  });
});

describe('audit-entity-check — resolve payloads', () => {
  it('hands the agent verdict and the analysis scope to resolve', async () => {
    const captured = await run();
    const inputs = captured.resolve as {
      verdict?: { status?: string; findings?: unknown[] };
      scope?: string;
      analyzed_sha?: string;
      unverified?: unknown[];
      item_id?: string;
    };
    expect(inputs.verdict?.status).toBe('failed');
    expect(inputs.verdict?.findings).toHaveLength(1);
    expect(inputs.scope).toBe('diff');
    expect(inputs.analyzed_sha).toBe(GATHER_ANALYZE.analyzed_sha);
    expect(inputs.item_id).toBe('audit_entity_check');
    // Whatever could not be read reaches the item, so the report can say so.
    expect(inputs.unverified).toEqual([]);
  });

  it('hands the previous verdict to resolve_carryover', async () => {
    const captured = await run({ gatherOutput: GATHER_CARRY_OVER });
    const inputs = captured.resolve_carryover as {
      prev?: { status?: string; sha?: string };
      changed_count?: number;
      unverified?: unknown[];
    };
    expect(inputs.prev?.status).toBe('passed');
    expect(inputs.prev?.sha).toBe(GATHER_CARRY_OVER.prev.sha);
    expect(inputs.changed_count).toBe(2);
    expect(inputs.unverified).toEqual([]);
  });
});

describe('audit-entity-check — failure fallbacks', () => {
  it('skips the item when the enhancer configuration cannot be read', async () => {
    const captured = await run({ failStep: 'enhancer_config' });
    expect(stepRan(captured.snapshot, 'resolve_failure_config')).toBe(true);
    expect(stepRan(captured.snapshot, 'gather')).toBe(false);
    expect(captured.agentRan).toBe(false);
    expect(captured.resolve).toBeUndefined();
    expect(captured.snapshot.steps['resolve_failure_config']?.inputs?.['status']).toBe('skipped');
    expect(String(captured.snapshot.steps['resolve_failure_config']?.inputs?.['message'])).toContain(
      'boom enhancer_config',
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
