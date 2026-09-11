/**
 * E2E for finops/tool-cloud-query.yaml on the local executor. The engine
 * plugin `np-package-call` is stubbed at the PLUGIN level (spec invariant 10):
 * the stub asserts the request the workflow hands to it and returns the shape
 * the real plugin emits ({ response, calls, failed, ... }).
 *
 * `runWorkflowE2E` resolves with `{ outputs, finalSnapshot, definition }` on a
 * completed run and REJECTS when the run fails.
 */
import { resolve } from 'node:path';
import { runWorkflowE2E } from '@nullplatform/workflow-kit/test';
import { describe, expect, it } from 'vitest';

const YAML = resolve(__dirname, '..', 'tool-cloud-query.yaml');

const RESPONSE = {
  provider: 'aws',
  identity: { account: '688720756067' },
  calls: [
    { id: 'who', ok: true, pages: 1, durationMs: 5, result: { Account: '688720756067' } },
    {
      id: 'cost',
      ok: true,
      pages: 1,
      durationMs: 9,
      result: { ResultsByTime: [{ Total: { UnblendedCost: { Amount: '1.5' } } }] },
    },
  ],
};

const passthroughTrigger = {
  handler: () => ({ status: 'success' as const, outputs: {}, activePorts: ['default'] }),
  registryType: 'trigger' as const,
};

function packageCallStub(outputs: Record<string, unknown>, seen: Array<Record<string, unknown>> = []) {
  return {
    handler: (ctx: { inputs: Record<string, unknown> }) => {
      seen.push(ctx.inputs);
      return { status: 'success' as const, outputs, activePorts: ['default'] };
    },
    executeMode: 'all' as const,
  };
}

type Snapshot = { steps: Record<string, { status: string }> };

describe('finops/tool-cloud-query', () => {
  it('returns results keyed by call id', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const result = await runWorkflowE2E({
      yamlPath: YAML,
      inputs: {
        agent_tags: { package: 'cloud-query' },
        calls: [
          { id: 'who', service: 'sts', operation: 'GetCallerIdentity' },
          { id: 'cost', service: 'ce', operation: 'GetCostAndUsage' },
        ],
      },
      pluginStubs: {
        manual: passthroughTrigger,
        'np-package-call': packageCallStub(
          {
            commandId: 'c1',
            agentId: 'a1',
            response: RESPONSE,
            calls: RESPONSE.calls,
            failed: [],
            mode: 'async',
          },
          seen,
        ),
      },
    });
    const snap = result.finalSnapshot as Snapshot;
    expect(snap.steps.shape_results?.status).toBe('completed');
    expect(result.outputs?.results).toEqual({
      who: { Account: '688720756067' },
      cost: { ResultsByTime: [{ Total: { UnblendedCost: { Amount: '1.5' } } }] },
    });
    expect(result.outputs?.identity).toEqual({ account: '688720756067' });
    expect(result.outputs?.failed).toEqual([]);

    expect(seen).toHaveLength(1);
    const ac = seen[0]?.action_context as { cloud_query: { calls: unknown[]; provider: string } };
    expect(ac.cloud_query.provider).toBe('aws');
    expect(ac.cloud_query.calls).toHaveLength(2);
    expect(seen[0]?.agent_selector).toEqual({ package: 'cloud-query' });
    expect(seen[0]?.mode).toBe('async');
    // the released image travels as an immutable reference (default from variables.image)
    expect(String(seen[0]?.image)).toMatch(/^public\.ecr\.aws\/nullplatform\/agent-plugins\/workflows\/aws-cost-explorer@sha256:[a-f0-9]{64}$/);
    // …and ALSO as the oci_image artifact inside the action context (works on engines without the `image` input)
    const pkg = (seen[0]?.action_context as { notification: { package: { slug: string; revision: { artifacts: Array<{ type: string; meta: { registry: string; repository: string; digest: string } }> } } } }).notification.package;
    expect(pkg.slug).toBe('cloud-query');
    expect(pkg.revision.artifacts[0]?.type).toBe('oci_image');
    expect(pkg.revision.artifacts[0]?.meta).toEqual({ registry: 'public.ecr.aws', repository: 'nullplatform/agent-plugins/workflows/aws-cost-explorer', digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });
  });

  it('scopes the agent selector to agent_nrn when given (agents registered under an account)', async () => {
    const seen: Array<Record<string, unknown>> = [];
    await runWorkflowE2E({
      yamlPath: YAML,
      inputs: {
        agent_tags: { cluster: 'runtime' },
        agent_nrn: 'organization=4:account=17',
        calls: [{ id: 'who', service: 'sts', operation: 'GetCallerIdentity' }],
      },
      pluginStubs: {
        manual: passthroughTrigger,
        'np-package-call': packageCallStub({ commandId: 'c1', agentId: 'a1', response: RESPONSE, calls: RESPONSE.calls, failed: [], mode: 'async' }, seen),
      },
    });
    expect(seen[0]?.agent_selector).toEqual({ nrn: 'organization=4:account=17', tags: { cluster: 'runtime' } });
    await expect(
      runWorkflowE2E({
        yamlPath: YAML,
        inputs: { agent_tags: { cluster: 'runtime' }, agent_nrn: 'not-an-nrn', calls: [{ id: 'who', service: 'sts', operation: 'GetCallerIdentity' }] },
        pluginStubs: { manual: passthroughTrigger, 'np-package-call': packageCallStub({ commandId: 'c1', agentId: 'a1', response: RESPONSE, calls: RESPONSE.calls, failed: [], mode: 'async' }) },
      }),
    ).rejects.toThrow(/agent_nrn is not an NRN/);
  });

  it('surfaces failed calls in outputs when the plugin reports them', async () => {
    const failedCall = { id: 'big', ok: false, errorCode: 'RESULT_TOO_LARGE', error: 'too big' };
    const seen: Array<Record<string, unknown>> = [];
    const result = await runWorkflowE2E({
      yamlPath: YAML,
      inputs: {
        agent_tags: { package: 'cloud-query' },
        calls: [{ id: 'big', service: 'ce', operation: 'GetCostAndUsage' }],
        mode: 'sync',
      },
      pluginStubs: {
        manual: passthroughTrigger,
        'np-package-call': packageCallStub(
          {
            commandId: 'c1',
            agentId: 'a1',
            response: { calls: [failedCall] },
            calls: [failedCall],
            failed: ['big'],
            mode: 'sync',
          },
          seen,
        ),
      },
    });
    expect(result.outputs?.failed).toEqual(['big']);
    expect(result.outputs?.results).toEqual({
      big: { error: 'too big', errorCode: 'RESULT_TOO_LARGE' },
    });
    expect(seen[0]?.mode).toBe('sync');
  });

  it('refuses a callback host outside the allow-list, before dispatching anything', async () => {
    const seen: Array<Record<string, unknown>> = [];
    await expect(
      runWorkflowE2E({
        yamlPath: YAML,
        inputs: {
          agent_tags: { package: 'cloud-query' },
          calls: [{ id: 'who', service: 'sts', operation: 'GetCallerIdentity' }],
          callback_base_url: 'http://169.254.169.254',
        },
        pluginStubs: {
          manual: passthroughTrigger,
          'np-package-call': packageCallStub({ response: {}, calls: [], failed: [] }, seen),
        },
      }),
    ).rejects.toThrow(/callback host not allowed/);
    expect(seen).toHaveLength(0);
  });

  it('fails the run when calls is empty, before dispatching anything', async () => {
    const seen: Array<Record<string, unknown>> = [];
    await expect(
      runWorkflowE2E({
        yamlPath: YAML,
        inputs: { agent_tags: { package: 'cloud-query' }, calls: [] },
        pluginStubs: {
          manual: passthroughTrigger,
          'np-package-call': packageCallStub({ response: {}, calls: [], failed: [] }, seen),
        },
      }),
    ).rejects.toThrow(/calls must be a non-empty array/);
    expect(seen).toHaveLength(0);
  });
});
