/**
 * @file E2E for `validate_jira_epic`.
 *
 * Stubs:
 *   - `np-checklist-trigger` (registryType: 'trigger') as a passthrough so
 *     workflow.inputs become the trigger output. The harness drives all
 *     trigger steps natively — we register only to declare ports.
 *   - `jira-get-issue` to return a synthetic Jira response.
 *   - `np-checklist-item-resolve` to capture the resolution payload.
 *
 * Asserts that the resolution PATCH carries the correct status/message/
 * details for the four representative outcomes (happy + 3 fail modes).
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { runWorkflowE2E } from '@nullplatform/workflow-kit/test';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WF_PATH = resolve(REPO_ROOT, 'workflows', 'governance', 'validate-jira-epic.yaml');

const TRIGGER_OUTPUTS = {
  kind: 'validate-jira-epic',
  runId: 'crun_test',
  itemId: 'epic_valid',
  callbackUrl: 'https://approval-api.test/approval/9001/checklist/items/epic_valid',
  callbackToken: 'tok_signed_xxx',
  inputs: { jira_epic: 'ACME-123' },
  timeoutSeconds: 60,
  approvalRequestId: 9001,
  applicationId: 1521043056,
  nrn: 'organization=<org-id>::account=<account-id>::namespace=<namespace-id>::application=1521043056',
};

interface JiraIssue {
  key: string;
  id: string;
  issuetype: string;
  status: string;
  summary?: string;
}

interface ResolveCall {
  callbackUrl: unknown;
  callbackToken: unknown;
  status: unknown;
  message: unknown;
  details: unknown;
}

async function run(jiraIssue: JiraIssue) {
  let resolveCall: ResolveCall | null = null;
  const result = await runWorkflowE2E({
    yamlPath: WF_PATH,
    inputs: TRIGGER_OUTPUTS,
    pluginStubs: {
      'np-checklist-trigger': {
        handler: () => ({ status: 'success', outputs: {}, activePorts: ['default'] }),
        registryType: 'trigger',
      },
      'jira-get-issue': () => ({
        status: 'success',
        outputs: {
          key: jiraIssue.key,
          id: jiraIssue.id,
          issuetype: jiraIssue.issuetype,
          status: jiraIssue.status,
          summary: jiraIssue.summary ?? `Summary for ${jiraIssue.key}`,
          fields: {},
          raw: {},
        },
        activePorts: ['default'],
      }),
      // Progress pings are fire-and-forget HTTP calls — a passthrough stub
      // keeps the graph valid without asserting on them.
      'np-checklist-item-progress': () => ({
        status: 'success',
        outputs: { ok: true, statusCode: 200 },
        activePorts: ['default'],
      }),
      'np-checklist-item-resolve': (ctx) => {
        const i = ctx.inputs ?? {};
        resolveCall = {
          callbackUrl: i.callbackUrl,
          callbackToken: i.callbackToken,
          status: i.status,
          message: i.message,
          details: i.details,
        };
        return {
          status: 'success',
          outputs: { ok: true, statusCode: 200, body: {} },
          activePorts: ['default'],
        };
      },
    },
  });
  return { result, resolveCall };
}

describe('validate_jira_epic (E2E)', () => {
  it('passes when the epic is Epic and In Progress', async () => {
    const { result, resolveCall } = await run({
      key: 'ACME-123',
      id: '10001',
      issuetype: 'Epic',
      status: 'In Progress',
    });

    expect(resolveCall).not.toBeNull();
    const call = resolveCall as ResolveCall;
    expect(call.callbackUrl).toBe(TRIGGER_OUTPUTS.callbackUrl);
    expect(call.callbackToken).toBe(TRIGGER_OUTPUTS.callbackToken);
    expect(call.status).toBe('passed');
    expect(String(call.message)).toMatch(/ACME-123/);
    expect((call.details as Record<string, unknown>).jira_key).toBe('ACME-123');

    expect(result.outputs.resolved_status).toBe('passed');
    expect(result.outputs.callback_ok).toBe(true);
  });

  it('passes when the epic is in In Development', async () => {
    const { resolveCall } = await run({
      key: 'ACME-9',
      id: '10009',
      issuetype: 'Epic',
      status: 'In Development',
    });
    expect((resolveCall as ResolveCall).status).toBe('passed');
  });

  it('fails when the epic is in Done', async () => {
    const { resolveCall, result } = await run({
      key: 'ACME-9',
      id: '10009',
      issuetype: 'Epic',
      status: 'Done',
    });
    const call = resolveCall as ResolveCall;
    expect(call.status).toBe('failed');
    expect(String(call.message)).toMatch(/Done/);
    expect(result.outputs.resolved_status).toBe('failed');
  });

  it('fails when the issue type is not Epic', async () => {
    const { resolveCall } = await run({
      key: 'ACME-9',
      id: '10009',
      issuetype: 'Task',
      status: 'In Progress',
    });
    const call = resolveCall as ResolveCall;
    expect(call.status).toBe('failed');
    expect(String(call.message)).toMatch(/not an Epic/i);
    expect((call.details as Record<string, unknown>).issuetype).toBe('Task');
  });
});
