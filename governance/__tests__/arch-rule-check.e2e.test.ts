/**
 * @file E2E for `arch-rule-check` (incremental architecture compliance).
 *
 * The audit logic itself lives in `code-exec` steps (gather / resolve /
 * resolve_carryover) — network access to the NP and GitHub APIs — so these
 * tests stub `code-exec` BY STEP ID and assert the graph routing the
 * incremental design relies on:
 *
 *   - gather → mode=carry_over  → resolve_carryover, agent NEVER runs.
 *   - gather → mode=analyze     → claude-code-agent → resolve.
 *
 * Stubs:
 *   - `np-checklist-trigger` passthrough (workflow inputs flow through).
 *   - `code-exec` switched on ctx step id; captures resolve payloads.
 *   - `claude-code-agent` returns a canned verdict (with change categories).
 *   - `np-checklist-item-progress` passthrough.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { runWorkflowE2E } from '@nullplatform/workflow-kit/test';

const WF_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'arch-rule-check.yaml');

const TRIGGER_OUTPUTS = {
  kind: 'arch-rule-check',
  runId: 'crun_test',
  itemId: 'has_tests',
  callbackUrl: 'https://approval-api.test/approval/9001/checklist/items/has_tests',
  callbackToken: 'tok_signed_xxx',
  inputs: {
    application_id: 924036609,
    release_id: 734671234,
    rule_id: 'has_tests',
    rule_title: 'Automated tests present',
    instruction: 'The repository must contain automated tests.',
    file_pattern: '(test|spec)s?[./]',
  },
  approvalRequestId: 9001,
  applicationId: 924036609,
  nrn: 'organization=<org-id>:account=<account-id>:namespace=<ns-id>:application=924036609',
};

const GATHER_CARRY_OVER = {
  mode: 'carry_over',
  repo: 'acme/shop-api',
  branch: 'main',
  analyzed_sha: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111',
  prev: {
    approval_id: 8000,
    sha: 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222',
    status: 'passed',
    findings: [],
    markdown: '### Automated tests present — PASSED',
  },
  changed_count: 2,
};

const GATHER_ANALYZE = {
  mode: 'analyze',
  scope: 'verify_fix',
  repo: 'acme/shop-api',
  branch: 'main',
  analyzed_sha: 'cccc3333cccc3333cccc3333cccc3333cccc3333',
  prev: null,
  changed_count: 3,
  total_files: 12,
  prev_findings_view: '- package.json: placeholder test script',
  llm_view: '## Repository: acme/shop-api …',
};

const AGENT_VERDICT = {
  status: 'passed',
  summary: 'Tests were added under __tests__/.',
  findings: [],
  resolved_findings: [
    { file: 'package.json', issue: 'placeholder test script', resolution: 'now runs vitest' },
  ],
  fix_instructions_md: '',
  change_categories: [{ category: 'tests', count: 1, notes: 'unit tests added' }],
};

interface CapturedResolves {
  resolve?: Record<string, unknown>;
  resolve_carryover?: Record<string, unknown>;
  agentRan: boolean;
}

async function run(gatherOutput: Record<string, unknown>): Promise<CapturedResolves> {
  const captured: CapturedResolves = { agentRan: false };
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

describe('arch-rule-check — incremental routing', () => {
  it('carry_over skips the agent and resolves via resolve_carryover', async () => {
    const captured = await run(GATHER_CARRY_OVER);
    expect(captured.resolve_carryover).toBeTruthy();
    expect(captured.resolve).toBeUndefined();
    expect(captured.agentRan).toBe(false);
  });

  it('analyze routes through the audit agent to resolve', async () => {
    const captured = await run(GATHER_ANALYZE);
    expect(captured.agentRan).toBe(true);
    expect(captured.resolve).toBeTruthy();
    expect(captured.resolve_carryover).toBeUndefined();
  });
});
