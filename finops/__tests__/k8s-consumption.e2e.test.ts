/**
 * E2E for finops/wf3-k8s-consumption-daily.yaml: lake scopes + collector output (agent) +
 * the day's raw cluster row → priced scope facts and the cluster's consumption shares.
 */
import { resolve } from 'node:path';
import { runWorkflowE2E } from '@nullplatform/workflow-kit/test';
import { describe, expect, it } from 'vitest';

const YAML = resolve(__dirname, '..', 'wf3-k8s-consumption-daily.yaml');
const D = '2026-09-09';
const passthroughTrigger = { handler: () => ({ status: 'success' as const, outputs: {}, activePorts: ['default'] }), registryType: 'trigger' as const };

const SCOPES = [
  { scope_id: 777, scope_name: 'prod', scope_slug: 'prod', scope_nrn: 'organization=4:account=17:namespace=5:application=100:scope=777', scope_type: 'web_pool_k8s', app_name: 'Orders', app_slug: 'orders-api' },
  { scope_id: 999, scope_name: 'prod', scope_slug: 'prod', scope_nrn: 'organization=4:account=17:namespace=6:application=400:scope=999', scope_type: 'web_pool_k8s', app_name: 'Users', app_slug: 'users-api' },
  { scope_id: 555, scope_name: 'ec2', scope_slug: 'ec2', scope_nrn: 'organization=4:account=17:namespace=6:application=400:scope=555', scope_type: 'custom', app_name: 'Users', app_slug: 'users-api' },
];
// cluster row of the day (wf1): 100 USD, rates 0.05 $/core-h and 0.01 $/GiB-h
const CLUSTER = { id: `raw-cluster-runtime-${D}`, date: D, day: D, stage: 'raw', subject_type: 'cluster', subject_id: 'runtime', cluster: 'runtime', cloud: 'aws', cloud_account: '283477532906', region: 'us-east-1', source: 'aws_ce', collected_at: 'x', allocation_method: 'unallocated', cost_usd: 100, rate_cpu_usd_core_h: 0.05, rate_mem_usd_gb_h: 0.01, cpu_share: 0.5, cpu_capacity_core_h: 2000, mem_capacity_gb_h: 8000 };
// collector day mode per scope: 2 hours, usage vs request (mc / MB)
const OUT: Record<string, unknown> = {
  777: { samples: 24, cpu_mc_hours: 3000, mem_mb_hours: 4096, cpu_req_mc_avg: 2000, mem_req_mb_avg: 2048, hours: [
    { cpu_mc: 1000, mem_mb: 1024, cpu_req_mc: 2000, mem_req_mb: 2048, pods: 2 }, // request wins: 2 core-h, 2 GiB-h
    { cpu_mc: 2000, mem_mb: 3072, cpu_req_mc: 1000, mem_req_mb: 2048, pods: 3 }, // usage wins: 2 core-h, 3 GiB-h
  ] },
  999: { samples: 24, cpu_mc_hours: 500, mem_mb_hours: 512, hours: [{ cpu_mc: 500, mem_mb: 512, cpu_req_mc: 500, mem_req_mb: 512, pods: 1 }] }, // 0.5 core-h, 0.5 GiB-h
  555: { samples: 0 }, // not in the cluster
};

describe('finops/wf3-k8s-consumption-daily', () => {
  it('prices each scope with the cluster rates (max(usage, request) per hour) and writes the cluster shares', async () => {
    const cmds: string[] = []; const written: Array<Record<string, unknown>> = [];
    const result = await runWorkflowE2E({
      yamlPath: YAML,
      inputs: { date: D },
      pluginStubs: {
        manual: passthroughTrigger,
        'np-lake-query': { handler: () => ({ status: 'success' as const, outputs: { rows: SCOPES, rowCount: 3 }, activePorts: ['default'] }), executeMode: 'all' as const },
        'np-api-call': { handler: () => ({ status: 'success' as const, outputs: { status: 200, body: CLUSTER }, activePorts: ['default'] }), executeMode: 'all' as const },
        'np-agent-command': {
          handler: (ctx: { inputs: Record<string, unknown> }) => {
            const c = String(ctx.inputs.cmdline); cmds.push(c);
            const id = c.split('--scope ')[1];
            return { status: 'success' as const, outputs: { status: 'success', stdout: JSON.stringify(OUT[id as string]), stderr: '' }, activePorts: ['default'] };
          },
          executeMode: 'all' as const,
        },
        'sub-workflow': { handler: (ctx: { inputs: Record<string, unknown> }) => { written.push(ctx.inputs); return { status: 'success' as const, outputs: { id: (ctx.inputs.fact as { id: string }).id }, activePorts: ['default'] }; }, executeMode: 'all' as const },
      },
    });
    expect(cmds).toEqual([
      `nullplatform/platform-scopes-override/cost/collect_metrics --prom http://prometheus-server.default.svc.cluster.local --mode day --date ${D} --scope 777`,
      `nullplatform/platform-scopes-override/cost/collect_metrics --prom http://prometheus-server.default.svc.cluster.local --mode day --date ${D} --scope 999`,
      `nullplatform/platform-scopes-override/cost/collect_metrics --prom http://prometheus-server.default.svc.cluster.local --mode day --date ${D} --scope 555`,
    ]);
    const facts = result.outputs?.facts as Array<Record<string, unknown>>;
    expect(facts.map((f) => f.id)).toEqual([`raw-k8s-scope-777-${D}`, `raw-k8s-scope-999-${D}`]); // 555 has no pods here
    // 777: chargeable 4 core-h × 0.05 + 5 GiB-h × 0.01 = 0.25; used 3 core-h + 4 GiB-h = 0.19; waste 0.06
    expect(facts[0]).toMatchObject({ subject_type: 'scope', source: 'k8s', cluster: 'runtime', application_id: '100', namespace_id: '5', scope_id: '777', application_slug: 'orders-api', subject_name: 'orders-api.prod',
      core_h_chargeable: 4, gb_h_chargeable: 5, core_h_used: 3, gb_h_used: 4, core_h_requested: 3, gb_h_requested: 4, pods_avg: 2.5, cost_usd: 0.25, usage_usd: 0.19, waste_usd: 0.06, allocation_method: 'direct_resource', metric: 'k8s.chargeable' });
    expect(facts[1]).toMatchObject({ scope_id: '999', application_id: '400', cost_usd: 0.03, usage_usd: 0.03, waste_usd: 0 });
    // cluster row patched with shares by scope (over the cluster cost) and the overhead
    const cluster = written.find((w) => (w.fact as { id: string }).id === `raw-cluster-runtime-${D}`)?.fact as Record<string, unknown>;
    expect(cluster).toMatchObject({ metric: 'k8s.chargeable', metric_shares: { 777: 0.0025, 999: 0.0003 }, k8s_overhead_usd: 99.72, cost_usd: 100 });
    expect((cluster.metric_owners as Record<string, Record<string, unknown>>)[777]).toEqual({ application_id: '100', namespace_id: '5', scope_id: '777', account_id: '17', application_slug: 'orders-api' });
    const summary = result.outputs?.summary as Record<string, unknown>;
    expect(summary).toMatchObject({ scopes: 3, with_data: 2, scopes_cost_usd: 0.28, overhead_usd: 99.72, cluster_cost_usd: 100, written: 3, error_count: 0 });
    expect(written.map((w) => w.catalog_slug)).toEqual(['cost_daily', 'cost_daily', 'cost_daily']);
  });

  it('fails clearly when the day has no raw cluster row', async () => {
    await expect(runWorkflowE2E({ yamlPath: YAML, inputs: { date: '2026-01-01' }, pluginStubs: {
      manual: passthroughTrigger,
      'np-lake-query': { handler: () => ({ status: 'success' as const, outputs: { rows: SCOPES }, activePorts: ['default'] }), executeMode: 'all' as const },
      'np-api-call': { handler: () => ({ status: 'success' as const, outputs: { status: 404, body: { message: 'not found' } }, activePorts: ['default'] }), executeMode: 'all' as const },
      'np-agent-command': { handler: () => ({ status: 'success' as const, outputs: { stdout: '{}' }, activePorts: ['default'] }), executeMode: 'all' as const },
      'sub-workflow': { handler: () => ({ status: 'success' as const, outputs: {}, activePorts: ['default'] }), executeMode: 'all' as const },
    } })).rejects.toThrow(/raw cluster row not found/);
  });
});
