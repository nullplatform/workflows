/**
 * @file E2E for `audit-entity-check` (audit-coverage checklist gate).
 *
 * The deterministic logic lives in `code-exec` steps (signals / gather /
 * resolve / resolve_carryover) — network access to GitHub, ClickHouse and the
 * NP APIs — so these tests stub `code-exec` BY STEP ID and assert the graph
 * routing the design relies on:
 *
 *   - gather → mode=carry_over  → resolve_carryover, agent NEVER runs.
 *   - gather → mode=analyze     → claude-code-agent → resolve.
 *   - signals always run before gather (their flags feed the decision).
 *
 * Stubs:
 *   - `np-checklist-trigger` passthrough (workflow inputs flow through).
 *   - `code-exec` switched on ctx step id; captures which resolves ran.
 *   - `claude-code-agent` returns a canned verdict.
 *   - `np-checklist-item-progress` passthrough.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
  nrn: 'organization=<org-id>:account=<account-id>:namespace=<ns-id>:application=924036609',
};

const SIGNALS_CLEAN = {
  flags: [],
  entity_config_keys: ['user', 'application', 'notification'],
  new_entities: [],
  degraded_entities: [],
  probes: [],
  signals_view: '### Flags (0)\n(none)',
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

interface CapturedResolves {
  resolve?: Record<string, unknown>;
  resolve_carryover?: Record<string, unknown>;
  signalsRan: boolean;
  agentRan: boolean;
}

async function run(gatherOutput: Record<string, unknown>): Promise<CapturedResolves> {
  const captured: CapturedResolves = { signalsRan: false, agentRan: false };
  await runWorkflowE2E({
    yamlPath: WF_PATH,
    inputs: TRIGGER_OUTPUTS,
    pluginStubs: {
      'np-checklist-trigger': {
        handler: () => ({ status: 'success', outputs: {}, activePorts: ['default'] }),
        registryType: 'trigger',
      },
      'np-checklist-item-progress': () => ({
        status: 'success',
        outputs: { ok: true, statusCode: 200 },
        activePorts: ['default'],
      }),
      // Failure fallbacks — never reached in these scenarios, but the graph
      // validator requires every declared plugin to be registered.
      'np-checklist-item-resolve': () => ({
        status: 'success',
        outputs: { ok: true },
        activePorts: ['default'],
      }),
      'code-exec': (ctx: { stepId?: string; step?: { id?: string } }) => {
        const stepId = ctx.stepId ?? ctx.step?.id;
        if (stepId === 'signals') {
          captured.signalsRan = true;
          return { status: 'success', outputs: SIGNALS_CLEAN, activePorts: ['default'] };
        }
        if (stepId === 'gather') {
          return { status: 'success', outputs: gatherOutput, activePorts: ['default'] };
        }
        // resolve / resolve_carryover: capture that the path was taken.
        captured[stepId as 'resolve' | 'resolve_carryover'] = { ran: true };
        return {
          status: 'success',
          outputs: { resolved: true },
          activePorts: ['default'],
        };
      },
      'claude-code-agent': () => {
        captured.agentRan = true;
        return { status: 'success', outputs: AGENT_VERDICT, activePorts: ['default'] };
      },
    },
  });
  return captured;
}

describe('audit-entity-check — routing', () => {
  it('carry_over skips the agent and resolves via resolve_carryover', async () => {
    const captured = await run(GATHER_CARRY_OVER);
    expect(captured.signalsRan).toBe(true);
    expect(captured.resolve_carryover).toBeTruthy();
    expect(captured.resolve).toBeUndefined();
    expect(captured.agentRan).toBe(false);
  });

  it('analyze routes through the audit agent to resolve', async () => {
    const captured = await run(GATHER_ANALYZE);
    expect(captured.signalsRan).toBe(true);
    expect(captured.agentRan).toBe(true);
    expect(captured.resolve).toBeTruthy();
    expect(captured.resolve_carryover).toBeUndefined();
  });
});
