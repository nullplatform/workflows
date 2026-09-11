/**
 * E2E for finops/wf2-allocate-daily.yaml: raw facts + mapping rules → allocated facts.
 * Catalog reads are stubbed at the `np-entity-paginated-fetch` level, the upsert child at
 * the `sub-workflow` level.
 */
import { resolve } from 'node:path';
import { runWorkflowE2E } from '@nullplatform/workflow-kit/test';
import { describe, expect, it } from 'vitest';

const YAML = resolve(__dirname, '..', 'wf2-allocate-daily.yaml');
const D = '2026-09-09';

const passthroughTrigger = {
  handler: () => ({ status: 'success' as const, outputs: {}, activePorts: ['default'] }),
  registryType: 'trigger' as const,
};

const svc = (name: string, id: string, cost: number) => ({
  id: `raw-cloud_service-${id}-${D}`, date: D, day: D, stage: 'raw', subject_type: 'cloud_service', subject_id: id, subject_name: name,
  cloud: 'aws', cloud_account: '111122223333', cloud_service: name, cost_usd: cost,
});
const EC2 = 'Amazon Elastic Compute Cloud - Compute';
const RDS = 'Amazon Relational Database Service';
const VPC = 'Amazon Virtual Private Cloud';
const GD = 'Amazon GuardDuty';
const CW = 'AmazonCloudWatch';

const RAW = [
  svc(EC2, 'ec2', 10), svc(RDS, 'rds', 30), svc(VPC, 'vpc', 3), svc(GD, 'guardduty', 1), svc(CW, 'cloudwatch', 4),
  // EC2: a null scope (tags → dims from wf1), a cluster nodes component, the unattributed bucket → remainder 2
  { id: `raw-scope-777-${D}`, date: D, day: D, stage: 'raw', subject_type: 'scope', subject_id: '777', subject_name: 'ns.app.prod', cloud: 'aws', cloud_service: EC2, parent_id: `raw-cloud_service-ec2-${D}`,
    cost_usd: 2, scope_id: '777', application_id: '100', namespace_id: '5', account_id: '1', tags: { scope_id: '777', application_id: '100' }, resource_id: 'i-1', resource_type: 'ec2:instance' },
  { id: `raw-bucket-runtime-nodes-${D}`, date: D, day: D, stage: 'raw', subject_type: 'bucket', subject_id: 'runtime|nodes', subject_name: 'runtime / nodes', cloud: 'aws', cloud_service: EC2, cluster: 'runtime', component: 'nodes', parent_id: `raw-cluster-runtime-${D}`, cost_usd: 5 },
  { id: `raw-bucket-ec2-instances-unattributed-${D}`, date: D, day: D, stage: 'raw', subject_type: 'bucket', subject_id: 'ec2-instances-unattributed', subject_name: 'EC2 instances not attributable', cloud: 'aws', cloud_service: EC2, parent_id: `raw-cloud_service-ec2-${D}`, cost_usd: 1, resource_type: 'ec2:instance' },
  { id: `raw-cluster-runtime-${D}`, date: D, day: D, stage: 'raw', subject_type: 'cluster', subject_id: 'runtime', cloud: 'aws', cluster: 'runtime', cost_usd: 8,
    metric: 'k8s.chargeable', metric_shares: { 777: 0.5, 999: 0.25 }, metric_owners: { 777: { application_id: '100', namespace_id: '5', scope_id: '777' }, 999: { application_id: '400', scope_id: '999' } } },
  // k8s consumption rows (wf3) — informational for the allocator, summarized into application_cost_daily.kubernetes
  { id: `raw-k8s-scope-777-${D}`, date: D, day: D, stage: 'raw', subject_type: 'scope', subject_id: '777', cloud: 'aws', source: 'k8s', cluster: 'runtime', application_id: '100', scope_id: '777', cost_usd: 4, core_h_chargeable: 48, gb_h_chargeable: 96, core_h_used: 10, gb_h_used: 40, usage_usd: 1, waste_usd: 3 },
  { id: `raw-bucket-runtime-networking-${D}`, date: D, day: D, stage: 'raw', subject_type: 'bucket', subject_id: 'runtime|networking', subject_name: 'runtime / networking', cloud: 'aws', cloud_service: VPC, cluster: 'runtime', component: 'networking', parent_id: `raw-cluster-runtime-${D}`, cost_usd: 3 },
  // RDS: one cluster mapped by wf1 (host = null service), one shared cluster with no owner
  { id: `raw-service-orders-db-${D}`, date: D, day: D, stage: 'raw', subject_type: 'service', subject_id: 'orders-db', subject_name: 'Orders DB', cloud: 'aws', cloud_service: RDS, parent_id: `raw-cloud_service-rds-${D}`,
    cost_usd: 12, service_id: 'svc-1', application_id: '100', namespace_id: '5', account_id: '1', host: 'orders-db.cluster-abc.us-east-1.rds.amazonaws.com', resource_type: 'rds:cluster', tags: { application: 'orders' } },
  { id: `raw-service-shared-db-${D}`, date: D, day: D, stage: 'raw', subject_type: 'service', subject_id: 'shared-db', subject_name: 'shared-db', cloud: 'aws', cloud_service: RDS, parent_id: `raw-cloud_service-rds-${D}`,
    cost_usd: 8, host: 'shared-db.cluster-abc.us-east-1.rds.amazonaws.com', resource_type: 'rds:cluster', tags: { application: 'shared' } },
  // a cluster with Performance Insights shares by database (by_metric rule below): 60% orders, 30% ledger, 10% scratch (no owner)
  { id: `raw-service-metrics-db-${D}`, date: D, day: D, stage: 'raw', subject_type: 'service', subject_id: 'metrics-db', subject_name: 'metrics-db', cloud: 'aws', cloud_service: RDS, parent_id: `raw-cloud_service-rds-${D}`,
    cost_usd: 10, host: 'metrics-db.cluster-abc.us-east-1.rds.amazonaws.com', resource_type: 'rds:cluster', metric: 'pi.db.load', metric_shares: { orders: 0.6, ledger: 0.3, scratch: 0.1 } },
  // usage-type buckets are informational — must not be allocated (they overlap the leaves)
  { id: `raw-bucket-rds-aurora-storageio-${D}`, date: D, day: D, stage: 'raw', subject_type: 'bucket', subject_id: 'rds|Aurora:StorageIOUsage', cloud: 'aws', cloud_service: RDS, parent_id: `raw-cloud_service-rds-${D}`, usage_type: 'Aurora:StorageIOUsage', cost_usd: 7 },
  // CloudWatch: a log-group resource named <namespace>.<application>
  { id: `raw-resource-loggroup-catalog-entities-api-${D}`, date: D, day: D, stage: 'raw', subject_type: 'resource', subject_id: 'catalog.entities-api', subject_name: 'catalog.entities-api', cloud: 'aws', cloud_service: CW, parent_id: `raw-cloud_service-cloudwatch-${D}`, resource_type: 'logs:log-group', cost_usd: 1.5 },
  // yesterday's row must be ignored
  { id: 'raw-cloud_service-ec2-2026-09-08', date: '2026-09-08', day: '2026-09-08', stage: 'raw', subject_type: 'cloud_service', subject_id: 'ec2', subject_name: EC2, cloud: 'aws', cloud_service: EC2, cost_usd: 99 },
];

const RULES = [
  { id: 'security-is-platform', name: 'security → platform', enabled: true, status: 'active', priority: 10, scope: { cloud_service: { regex: 'GuardDuty|Security Hub' } }, target: { bucket: 'shared-platform' }, category: 'security' },
  { id: 'shared-db-by-database', name: 'shared Aurora split', enabled: true, status: 'active', priority: 20, scope: { resource_type: 'rds:cluster' },
    match: [{ field: 'host', equals: 'shared-db.cluster-abc.us-east-1.rds.amazonaws.com' }],
    method: 'split', target: { split: [{ weight: 3, target: { application_id: '100', namespace_id: '5' } }, { weight: 1, target: { application_id: '200', namespace_id: '6' } }] } },
  { id: 'metrics-db-by-load', name: 'metrics-db by database load', enabled: true, status: 'active', priority: 25, scope: { resource_type: 'rds:cluster' },
    match: [{ field: 'host', equals: 'metrics-db.cluster-abc.us-east-1.rds.amazonaws.com' }, { field: 'metric', equals: 'pi.db.load' }],
    method: 'by_metric', target: { map: { key: 'db.name', entries: { orders: { application_id: '100', namespace_id: '5' }, ledger: { application_id: '300' } } } } },
  { id: 'log-groups-by-name', name: 'log groups <ns>.<app>', enabled: true, status: 'active', priority: 30, scope: { resource_type: 'logs:log-group' },
    match: [{ field: 'subject_name', regex: '^(?<ns>[a-z0-9-]+)\\.(?<app>[a-z0-9-]+)$' }], target: { capture: { application_slug: '$app' } } },
  { id: 'disabled-rule', name: 'would steal everything', enabled: false, status: 'active', priority: 1, target: { bucket: 'nope' } },
  { id: 'proposed-rule', name: 'not active yet', enabled: true, status: 'proposed', priority: 1, target: { bucket: 'nope' } },
];

function fetchStub(raw = RAW, rules = RULES) {
  return {
    handler: (ctx: { stepId: string; inputs: Record<string, unknown> }) => {
      const items = ctx.stepId === 'read_rules' ? rules : raw;
      return { status: 'success' as const, outputs: { items, totalFetched: items.length, pages: 1 }, activePorts: ['default'] };
    },
    executeMode: 'all' as const,
  };
}

describe('finops/wf2-allocate-daily', () => {
  it('allocates every leaf, reconciles with the service totals, and rolls up per application', async () => {
    const written: Array<Record<string, unknown>> = [];
    const result = await runWorkflowE2E({
      yamlPath: YAML,
      inputs: { date: D },
      pluginStubs: {
        manual: passthroughTrigger,
        'np-entity-paginated-fetch': fetchStub(),
        'sub-workflow': {
          handler: (ctx: { inputs: Record<string, unknown> }) => {
            written.push(ctx.inputs.fact as Record<string, unknown>);
            return { status: 'success' as const, outputs: { id: (ctx.inputs.fact as { id: string }).id, status: 200 }, activePorts: ['default'] };
          },
          executeMode: 'all' as const,
        },
      },
    });
    const facts = result.outputs?.facts as Array<Record<string, unknown>>;
    const summary = result.outputs?.summary as Record<string, unknown>;
    const byId = Object.fromEntries(facts.map((f) => [f.id, f]));

    // leaves: scope, nodes, unattributed, EC2 remainder 2, orders-db, shared-db, networking, GuardDuty remainder, log group, CloudWatch remainder 2.5
    expect(summary.leaves).toBe(11);
    expect(summary.total_usd).toBe(48);
    expect(summary.rules_active).toBe(4);

    // default:null-dims — the scope row already carries the owner
    expect(byId[`alloc-scope-777-${D}-app-100`]).toMatchObject({ stage: 'allocated', application_id: '100', scope_id: '777', cost_usd: 2, share: 1, rule_id: 'default:null-dims', category: 'compute', source_fact_id: `raw-scope-777-${D}` });
    // default:null-service — host mapped by wf1
    expect(byId[`alloc-service-orders-db-${D}-app-100`]).toMatchObject({ application_id: '100', service_id: 'svc-1', cost_usd: 12, rule_id: 'default:null-service', category: 'database' });
    // split rule 3:1 on the shared cluster
    expect(byId[`alloc-service-shared-db-${D}-app-100`]).toMatchObject({ application_id: '100', cost_usd: 6, share: 0.75, allocation_method: 'split', rule_id: 'shared-db-by-database' });
    expect(byId[`alloc-service-shared-db-${D}-app-200`]).toMatchObject({ application_id: '200', cost_usd: 2, share: 0.25 });
    // by_metric: Performance Insights shares → owners; the share nobody owns stays visibly unallocated
    expect(byId[`alloc-service-metrics-db-${D}-app-100`]).toMatchObject({ application_id: '100', cost_usd: 6, share: 0.6, allocation_method: 'by_metric', rule_id: 'metrics-db-by-load' });
    expect(byId[`alloc-service-metrics-db-${D}-app-300`]).toMatchObject({ application_id: '300', cost_usd: 3, share: 0.3 });
    expect(byId[`alloc-service-metrics-db-${D}-scratch-unallocated`]).toMatchObject({ cost_usd: 1, share: 0.1, allocation_method: 'unallocated', metric_key: 'scratch', rule_id: 'metrics-db-by-load' });
    // regex capture → application_slug
    expect(byId[`alloc-resource-loggroup-catalog-entities-api-${D}-app-entities-api`]).toMatchObject({ application_slug: 'entities-api', cost_usd: 1.5, rule_id: 'log-groups-by-name', category: 'observability' });
    // cluster components split by the consumption metric on the cluster row; the uncovered share is k8s overhead
    expect(byId[`alloc-bucket-runtime-nodes-${D}-app-100`]).toMatchObject({ application_id: '100', scope_id: '777', cost_usd: 2.5, share: 0.5, allocation_method: 'by_metric', rule_id: 'default:cluster-consumption', category: 'kubernetes' });
    expect(byId[`alloc-bucket-runtime-nodes-${D}-app-400`]).toMatchObject({ application_id: '400', cost_usd: 1.25 });
    expect(byId[`alloc-bucket-runtime-nodes-${D}-cluster-runtime`]).toMatchObject({ cluster: 'runtime', cost_usd: 1.25, share: 0.25, allocation_method: 'kubernetes_overhead' });
    expect(byId[`alloc-bucket-runtime-networking-${D}-app-100`]).toMatchObject({ cost_usd: 1.5, category: 'kubernetes' });
    // security → shared bucket with the rule's category
    expect(byId[`alloc-cloud_service-guardduty-${D}-remainder-bucket-shared-platform`]).toMatchObject({ bucket: 'shared-platform', cost_usd: 1, category: 'security', rule_id: 'security-is-platform' });
    // what nobody claims
    expect(byId[`alloc-bucket-ec2-instances-unattributed-${D}-unallocated`]).toMatchObject({ cost_usd: 1, allocation_method: 'unallocated' });
    expect(byId[`alloc-cloud_service-ec2-${D}-remainder-unallocated`]).toMatchObject({ cost_usd: 2 });
    expect(byId[`alloc-cloud_service-cloudwatch-${D}-remainder-unallocated`]).toMatchObject({ cost_usd: 2.5 });
    // usage-type buckets and the cluster row are not allocation leaves
    expect(facts.some((f) => String(f.source_fact_id ?? '').includes('storageio'))).toBe(false);
    expect(facts.some((f) => f.source_fact_id === `raw-cluster-runtime-${D}`)).toBe(false);

    // rollups
    expect(byId[`alloc-app-100-${D}`]).toMatchObject({ subject_type: 'application', application_id: '100', cost_usd: 30, by_category: { compute: 2, database: 24, kubernetes: 4 }, quantity: 6 });
    expect(byId[`alloc-app-300-${D}`]).toMatchObject({ cost_usd: 3 });
    expect(byId[`alloc-app-400-${D}`]).toMatchObject({ cost_usd: 2 });
    // application_cost_daily: the per-app entity, split by the null objects the cost came through
    const appRows = result.outputs?.app_rows as Array<Record<string, unknown>>;
    type Item = Record<string, unknown>; type Owner = { scope_id?: string; service_id?: string; cost_usd: number; items: Item[]; consumption?: Record<string, number>; scope_type?: string | null };
    const app100 = appRows.find((r) => r.id === `100-${D}`) as { total_usd: number; scopes_usd: number; services_usd: number; application_usd: number; scopes: Owner[]; services: Owner[]; application_items: Item[]; consumption: Record<string, number>; by_category: Record<string, number> };
    expect(app100).toMatchObject({ application_id: '100', namespace_id: '5', total_usd: 30, scopes_usd: 6, services_usd: 12, application_usd: 12, by_category: { compute: 2, database: 24, kubernetes: 4 }, items_count: 6, cloud_accounts: ['111122223333'] });
    // scope 777: the EC2 instance tagged with the scope (2) + its share of the cluster nodes (2.5) and networking (1.5), with the k8s consumption alongside
    expect(app100.scopes).toHaveLength(1);
    expect(app100.scopes[0]).toMatchObject({ scope_id: '777', cost_usd: 6, by_category: { compute: 2, kubernetes: 4 }, consumption: { core_h_chargeable: 48, gb_h_chargeable: 96, core_h_used: 10, gb_h_used: 40, usage_usd: 1, waste_usd: 3 } });
    expect(app100.scopes[0].items.map((i) => [i.subject_id, i.cost_usd])).toEqual([['runtime|nodes', 2.5], ['777', 2], ['runtime|networking', 1.5]]);
    expect(app100.scopes[0].items[0]).toMatchObject({ component: 'nodes', allocation_method: 'by_metric', rule_id: 'default:cluster-consumption', category: 'kubernetes' });
    // service svc-1 (orders-db, by null service host): 12
    expect(app100.services).toHaveLength(1);
    expect(app100.services[0]).toMatchObject({ service_id: 'svc-1', cost_usd: 12, items: [{ subject_id: 'orders-db', rule_id: 'default:null-service', cost_usd: 12 }] });
    // neither a scope nor a service: the shared clusters split by rule/metric (6 + 6) are attributed to the application directly
    expect(app100.application_items).toHaveLength(2);
    expect(app100.application_items.map((i) => [i.subject_id, i.cost_usd, i.allocation_method]).sort()).toEqual([['metrics-db', 6, 'by_metric'], ['shared-db', 6, 'split']]);
    expect(app100.consumption).toEqual({ core_h_chargeable: 48, gb_h_chargeable: 96, core_h_used: 10, gb_h_used: 40, usage_usd: 1, waste_usd: 3, scopes: 1 });
    expect(app100.scopes_usd + app100.services_usd + app100.application_usd).toBeCloseTo(app100.total_usd, 6);
    expect(appRows.map((r) => r.id).sort()).toEqual([`100-${D}`, `200-${D}`, `300-${D}`, `400-${D}`]);
    expect((appRows.find((r) => r.id === `400-${D}`) as { scopes: Owner[] }).scopes[0]).toMatchObject({ scope_id: '999', cost_usd: 2 });
    expect(written.filter((w) => (w as { id: string }).id === `100-${D}`)).toHaveLength(1);
    expect(byId[`alloc-app-200-${D}`]).toMatchObject({ cost_usd: 2 });
    expect(byId[`alloc-bucket-shared-platform-${D}`]).toMatchObject({ bucket: 'shared-platform', cost_usd: 1 });
    expect(byId[`alloc-unallocated-${D}`]).toMatchObject({ subject_type: 'unallocated', cost_usd: 6.5, by_cloud_service: { [EC2]: 3, [CW]: 2.5, [RDS]: 1 } });

    // Σ leaves = Σ services = allocated + cluster + unallocated
    const leafRows = facts.filter((f) => f.allocation_method !== 'rollup' && f.subject_type !== 'unallocated');
    expect(leafRows.reduce((s, f) => s + Number(f.cost_usd), 0)).toBeCloseTo(48, 6);
    expect(summary.unallocated_usd).toBe(6.5);
    expect(summary.cluster_pending_usd).toEqual({ runtime: 2 });
    expect(summary.allocated_usd).toBeCloseTo(39.5, 6);
    expect((summary.applications as Array<{ owner: string; cost_usd: number }>)[0]).toMatchObject({ owner: 'app-100', cost_usd: 30 });

    // everything was written (allocated facts + one application_cost_daily row per app), every fact carries the required keys
    expect(written).toHaveLength(facts.length + 4);
    expect(summary.written).toBe(facts.length + 4);
    for (const f of facts) for (const k of ['id', 'date', 'day', 'stage', 'subject_type', 'subject_id', 'cloud', 'cost_usd', 'source', 'allocation_method', 'collected_at']) expect(f[k], `${f.id}.${k}`).toBeDefined();
    const unl = result.outputs?.unallocated_leaves as Array<Record<string, unknown>>;
    expect(unl.map((u) => u.id)).toEqual([`raw-cloud_service-cloudwatch-${D}-remainder`, `raw-cloud_service-ec2-${D}-remainder`, `raw-bucket-ec2-instances-unattributed-${D}`, `raw-service-metrics-db-${D}#scratch`]);
    expect(unl[3]).toMatchObject({ kind: 'metric_key', metric_key: 'scratch', cost_usd: 1, rule_id: 'metrics-db-by-load', host: 'metrics-db.cluster-abc.us-east-1.rds.amazonaws.com' });
  });

  it('dry_run computes everything and writes nothing; no raw facts is an error', async () => {
    const written: unknown[] = [];
    const stub = { handler: (ctx: { inputs: Record<string, unknown> }) => { written.push(ctx.inputs.fact); return { status: 'success' as const, outputs: {}, activePorts: ['default'] }; }, executeMode: 'all' as const };
    const r = await runWorkflowE2E({ yamlPath: YAML, inputs: { date: D, dry_run: true }, pluginStubs: { manual: passthroughTrigger, 'np-entity-paginated-fetch': fetchStub(), 'sub-workflow': stub } });
    expect(written).toHaveLength(0);
    expect((r.outputs?.summary as { written: number; dry_run: boolean })).toMatchObject({ written: 0, dry_run: true });
    await expect(
      runWorkflowE2E({ yamlPath: YAML, inputs: { date: '2026-01-01' }, pluginStubs: { manual: passthroughTrigger, 'np-entity-paginated-fetch': fetchStub([], []), 'sub-workflow': stub } }),
    ).rejects.toThrow(/no raw facts for 2026-01-01/);
  });
});
