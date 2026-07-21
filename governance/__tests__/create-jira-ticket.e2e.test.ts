/**
 * @file E2E for `create_jira_ticket` — the checklist resolver that creates a
 * Jira ticket and waits for it to be resolved.
 *
 * I/O is stubbed at the plugin level (principle 10):
 *  - `np-checklist-trigger` is short-circuited by the runner (trigger outputs =
 *    its inputs), so we feed the dispatch payload via workflow `inputs`.
 *  - `jira-create-issue`, `np-checklist-item-progress`, `np-checklist-item-resolve`
 *    are stubbed to return success.
 *  -  is stubbed to simulate a "poke" (default port) or a 2h
 *    timeout (step failure -> error_handling.fallback_step).
 *  - `jira-get-issue` returns a scripted sequence of statuses so we can exercise
 *    the keep-waiting reentry loop (In Progress -> Done).
 *
 * `case`, `set-variable` and the graph (incl. the keep_waiting back-edge into
 * `wait`) run for real — this is what validates the reentry loop.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { IStepResult } from '@nullplatform/workflow-kit/test';

import { runWorkflowE2E } from '@nullplatform/workflow-kit/test';

const WF_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'create-jira-ticket.yaml');

const TRIGGER_INPUTS = {
  callbackBaseUrl: 'https://webhooks.nullplatform.io',
  // These surface as steps.trigger.outputs.* (trigger outputs = its inputs).
  callbackUrl: 'https://approval.nullplatform.com/checklist/item/abc',
  callbackToken: 'cb-token-xyz',
  inputs: {
    summary: 'Investigate flaky deploy',
    description: 'Pipeline is red intermittently.',
  },
};

const CREATE_ISSUE_STUB = {
  handler: () => ({
    status: 'success' as const,
    outputs: {
      key: 'TEST-1',
      id: '1001',
      self: 'https://x/rest/1001',
      url: 'https://x/browse/TEST-1',
    },
    items: [{ key: 'TEST-1', id: '1001', url: 'https://x/browse/TEST-1' }],
    activePorts: ['default'],
  }),
};

const OK_STUB = {
  handler: () => ({
    status: 'success' as const,
    outputs: { ok: true, statusCode: 200 },
    items: [{ ok: true, statusCode: 200 }],
    activePorts: ['default'],
  }),
};

/** signal-wait stub that always reports a received poke on the `default` port. */
const POKE_STUB = {
  registryType: 'module' as const,
  outputPorts: [{ name: 'default' }, { name: 'timeout' }],
  handler: () => ({
    status: 'success' as const,
    outputs: { name: 'jira-callback', payload: {}, receivedAt: '2026-06-25T00:00:00.000Z' },
    items: [{ name: 'jira-callback', payload: {} }],
    activePorts: ['default'],
  }),
};

/**
 * signal-wait stub simulating a 2h timeout with `onTimeout: error`: the step
 * FAILS, and the workflow's `error_handling.fallback_step` routes to a
 * dedicated `resolve_timeout` node (we intentionally don't use a `timeout` output port — see the
 * workflow YAML).
 */
const TIMEOUT_STUB = {
  registryType: 'module' as const,
  handler: () => ({
    status: 'failure' as const,
    error: {
      message: 'Timed out after 2h waiting for jira-callback',
      code: 'SIGNAL_WAIT_TIMEOUT',
      retryable: false,
    },
  }),
};

/** jira-get-issue stub returning a scripted status sequence (one per call). */
function getIssueSequenceStub(statuses: readonly string[]) {
  let i = 0;
  return {
    handler: (): IStepResult => {
      const status = statuses[Math.min(i, statuses.length - 1)] ?? 'Done';
      i += 1;
      const issue = { key: 'TEST-1', status, issuetype: 'Task', summary: 'x' };
      return { status: 'success', outputs: issue, items: [issue], activePorts: ['default'] };
    },
  };
}

function stepRan(
  snapshot: import('@nullplatform/workflow-kit/test').IWorkflowContextSnapshot,
  id: string,
): boolean {
  return snapshot.steps[id] !== undefined;
}

describe('create_jira_ticket (E2E)', () => {
  it('resolves the item PASSED when the ticket reaches Done (single poke)', async () => {
    const result = await runWorkflowE2E({
      yamlPath: WF_PATH,
      inputs: TRIGGER_INPUTS,
      pluginStubs: {
        'np-checklist-trigger': {
          handler: () => ({ status: 'success', outputs: {}, activePorts: ['default'] }),
          registryType: 'trigger',
        },
        'jira-create-issue': CREATE_ISSUE_STUB,
        'np-checklist-item-progress': OK_STUB,
        'np-checklist-item-resolve': OK_STUB,
        'signal-wait': POKE_STUB,
        'jira-get-issue': getIssueSequenceStub(['Done']),
      },
    });

    expect(stepRan(result.finalSnapshot, 'resolve_ok')).toBe(true);
    expect(stepRan(result.finalSnapshot, 'resolve_fail')).toBe(false);
    expect(result.finalSnapshot.steps['resolve_ok']?.inputs?.['status']).toBe('passed');
    expect(result.outputs['resolved_status']).toBe('Done');
    // The callback URL was derived from execution.id and written for create_issue.
    expect(String(result.finalSnapshot.variables?.['callback_url'])).toContain(
      '/workflows/webhooks/callback/',
    );
  });

  it('loops through keep_waiting (In Progress) then resolves PASSED on Done — reentry', async () => {
    const result = await runWorkflowE2E({
      yamlPath: WF_PATH,
      inputs: TRIGGER_INPUTS,
      pluginStubs: {
        'np-checklist-trigger': {
          handler: () => ({ status: 'success', outputs: {}, activePorts: ['default'] }),
          registryType: 'trigger',
        },
        'jira-create-issue': CREATE_ISSUE_STUB,
        'np-checklist-item-progress': OK_STUB,
        'np-checklist-item-resolve': OK_STUB,
        'signal-wait': POKE_STUB,
        // First poke: In Progress -> keep_waiting -> reenter wait.
        // Second poke: Done -> ok.
        'jira-get-issue': getIssueSequenceStub(['In Progress', 'Done']),
      },
    });

    expect(stepRan(result.finalSnapshot, 'resolve_ok')).toBe(true);
    expect(stepRan(result.finalSnapshot, 'resolve_fail')).toBe(false);
    expect(result.outputs['resolved_status']).toBe('Done');
  });

  it('resolves the item FAILED on a discard status (Cancelled)', async () => {
    const result = await runWorkflowE2E({
      yamlPath: WF_PATH,
      inputs: TRIGGER_INPUTS,
      pluginStubs: {
        'np-checklist-trigger': {
          handler: () => ({ status: 'success', outputs: {}, activePorts: ['default'] }),
          registryType: 'trigger',
        },
        'jira-create-issue': CREATE_ISSUE_STUB,
        'np-checklist-item-progress': OK_STUB,
        'np-checklist-item-resolve': OK_STUB,
        'signal-wait': POKE_STUB,
        'jira-get-issue': getIssueSequenceStub(['Cancelled']),
      },
    });

    expect(stepRan(result.finalSnapshot, 'resolve_fail')).toBe(true);
    expect(stepRan(result.finalSnapshot, 'resolve_ok')).toBe(false);
    expect(result.finalSnapshot.steps['resolve_fail']?.inputs?.['status']).toBe('failed');
  });

  // --- Temporal parity: same workflow, real Temporal worker bundle ---------
  // Skipped unless TEMPORAL_TESTING_ADDRESS points at a running test server
  // (booting the ephemeral server is unreliable in CI/sandbox) — same gating
  // convention as temporal-parity.e2e.test.ts.
  it.skipIf(!process.env.TEMPORAL_TESTING_ADDRESS)(
    'resolves PASSED on Done via the real Temporal worker (parity)',
    async () => {
      const result = await runWorkflowE2E({
        yamlPath: WF_PATH,
        executor: 'temporal',
        inputs: TRIGGER_INPUTS,
        pluginStubs: {
          'np-checklist-trigger': {
            handler: () => ({ status: 'success', outputs: {}, activePorts: ['default'] }),
            registryType: 'trigger',
          },
          'jira-create-issue': CREATE_ISSUE_STUB,
          'np-checklist-item-progress': OK_STUB,
          'np-checklist-item-resolve': OK_STUB,
          'signal-wait': POKE_STUB,
          'jira-get-issue': getIssueSequenceStub(['In Progress', 'Done']),
        },
      });
      expect(stepRan(result.finalSnapshot, 'resolve_ok')).toBe(true);
      expect(stepRan(result.finalSnapshot, 'resolve_fail')).toBe(false);
      expect(result.outputs['resolved_status']).toBe('Done');
    },
    180_000,
  );

  it('resolves the item FAILED on 2h timeout (no poke)', async () => {
    const result = await runWorkflowE2E({
      yamlPath: WF_PATH,
      inputs: TRIGGER_INPUTS,
      pluginStubs: {
        'np-checklist-trigger': {
          handler: () => ({ status: 'success', outputs: {}, activePorts: ['default'] }),
          registryType: 'trigger',
        },
        'jira-create-issue': CREATE_ISSUE_STUB,
        'np-checklist-item-progress': OK_STUB,
        'np-checklist-item-resolve': OK_STUB,
        'signal-wait': TIMEOUT_STUB,
        'jira-get-issue': getIssueSequenceStub(['In Progress']),
      },
    });

    expect(stepRan(result.finalSnapshot, 'resolve_timeout')).toBe(true);
    expect(stepRan(result.finalSnapshot, 'resolve_ok')).toBe(false);
    expect(stepRan(result.finalSnapshot, 'reread')).toBe(false);
  });
});
