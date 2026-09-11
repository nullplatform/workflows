/**
 * E2E for finops/wf0-aws-billing-dispatch.yaml: one collector run per target
 * (account × agent × role × package version), summary per account. The
 * collector child is stubbed at the `sub-workflow` plugin level.
 */
import { resolve } from 'node:path';
import { runWorkflowE2E } from '@nullplatform/workflow-kit/test';
import { describe, expect, it } from 'vitest';

const YAML = resolve(__dirname, '..', 'wf0-aws-billing-dispatch.yaml');

const passthroughTrigger = {
  handler: () => ({ status: 'success' as const, outputs: {}, activePorts: ['default'] }),
  registryType: 'trigger' as const,
};

const TARGETS = [
  {
    name: 'prod',
    agent_tags: { package: 'cloud-query', account: 'prod' },
    agent_nrn: 'organization=4:account=17',
    org_nrn: 'organization=4',
    assume_role_arn: 'arn:aws:iam::111122223333:role/np-finops',
    assume_role_external_id: 'ext-prod',
    package_version: '0.0.1',
    expected_account: '111122223333',
  },
  { name: 'dev', agent_tags: { package: 'cloud-query', account: 'dev' }, region: 'us-west-2' },
];

describe('finops/wf0-aws-billing-dispatch', () => {
  it('fans out one collector run per target with its agent, role and version, and summarizes per account', async () => {
    const runs: Array<Record<string, unknown>> = [];
    const allocations: Array<Record<string, unknown>> = [];
    const k8sRuns: Array<Record<string, unknown>> = [];
    const suggestions: Array<Record<string, unknown>> = [];
    const result = await runWorkflowE2E({
      yamlPath: YAML,
      inputs: { date: '2026-09-09', targets: TARGETS, dry_run: true, k8s_clusters: [{ cluster: 'runtime' }] },
      pluginStubs: {
        manual: passthroughTrigger,
        cron: passthroughTrigger,
        'sub-workflow': {
          handler: (ctx: { stepId: string; inputs: Record<string, unknown> }) => {
            if (ctx.stepId === 'k8s') {
              k8sRuns.push(ctx.inputs);
              return { status: 'success' as const, outputs: { summary: { cluster: 'runtime', scopes_cost_usd: 20, overhead_usd: 5, coverage_pct: 80 } }, activePorts: ['default'] };
            }
            if (ctx.stepId === 'allocate') {
              allocations.push(ctx.inputs);
              return { status: 'success' as const, outputs: { summary: { day: '2026-09-09', total_usd: 42.816, allocated_usd: 30, unallocated_usd: 12.816 }, unallocated_leaves: [{ id: 'raw-x', cost_usd: 12.816 }] }, activePorts: ['default'] };
            }
            if (ctx.stepId === 'suggest') {
              suggestions.push(ctx.inputs);
              return { status: 'success' as const, outputs: { summary: { suggestions: 1, recovers_usd: 12.816 } }, activePorts: ['default'] };
            }
            runs.push(ctx.inputs);
            const acct = ctx.inputs.target_name === 'prod' ? '111122223333' : '444455556666';
            return {
              status: 'success' as const,
              outputs: {
                summary: { day: '2026-09-09', account: acct, daily_total_usd: ctx.inputs.target_name === 'prod' ? 37.316 : 5.5, facts: 116, written: 0, clusters: [{ cluster: 'x' }] },
              },
              activePorts: ['default'],
            };
          },
          executeMode: 'all' as const,
        },
      },
    });
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      date: '2026-09-09',
      agent_tags: { package: 'cloud-query', account: 'prod' },
      agent_nrn: 'organization=4:account=17',
      org_nrn: 'organization=4',
      assume_role_arn: 'arn:aws:iam::111122223333:role/np-finops',
      assume_role_external_id: 'ext-prod',
      package_version: '0.0.1',
      expected_account: '111122223333',
      target_name: 'prod',
      dry_run: true,
    });
    expect(runs[1]).toMatchObject({ agent_tags: { package: 'cloud-query', account: 'dev' }, region: 'us-west-2', target_name: 'dev' });
    expect(runs[1]?.assume_role_arn ?? null).toBeNull();
    expect(runs[1]?.agent_nrn ?? null).toBeNull();

    const out = result.outputs?.summary as { collection: { targets: number; total_usd: number; accounts: Array<Record<string, unknown>> }; allocation: Record<string, unknown>; suggestions: Record<string, unknown> };
    const summary = out.collection;
    expect(summary.targets).toBe(2);
    expect(summary.total_usd).toBeCloseTo(42.816, 6);
    expect(summary.accounts.map((a) => [a.target, a.account])).toEqual([['prod', '111122223333'], ['dev', '444455556666']]);
    // collection → allocation (same day, same dry_run) → suggestions fed with the unallocated leaves
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({ date: '2026-09-09', dry_run: true }); // spreadItem also passes `index`/`run`, ignored by the child
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ date: '2026-09-09', dry_run: true, unallocated_leaves: [{ id: 'raw-x', cost_usd: 12.816 }] });
    expect(out.allocation).toMatchObject({ allocated_usd: 30, unallocated_usd: 12.816 });
    // one wf3 run per configured cluster, before the allocation
    expect(k8sRuns).toHaveLength(1);
    expect(k8sRuns[0]).toMatchObject({ date: '2026-09-09', cluster: 'runtime', dry_run: true });
    expect((out as { kubernetes: Array<Record<string, unknown>> }).kubernetes).toEqual([{ cluster: 'runtime', scopes_cost_usd: 20, overhead_usd: 5, coverage_pct: 80 }]);
    expect(out.suggestions).toMatchObject({ suggestions: 1 });
  });

  it('refuses to run without targets or with a target lacking agent_tags', async () => {
    const stub = { handler: () => ({ status: 'success' as const, outputs: {}, activePorts: ['default'] }), executeMode: 'all' as const };
    await expect(
      runWorkflowE2E({ yamlPath: YAML, inputs: { date: '2026-09-09' }, pluginStubs: { manual: passthroughTrigger, cron: passthroughTrigger, 'sub-workflow': stub } }),
    ).rejects.toThrow(/no targets configured/);
    await expect(
      runWorkflowE2E({ yamlPath: YAML, inputs: { date: '2026-09-09', targets: [{ name: 'x' }] }, pluginStubs: { manual: passthroughTrigger, cron: passthroughTrigger, 'sub-workflow': stub } }),
    ).rejects.toThrow(/needs agent_tags/);
  });
});
