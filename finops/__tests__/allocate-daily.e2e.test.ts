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

const SCOPES_API = [
  { id: 777, name: 'prod', type: 'web_pool_k8s', dimensions: { environment: 'production' } },
  { id: 999, name: 'stage', type: 'web_pool_k8s', dimensions: { environment: 'stage' } },
];
const SERVICES_API = { results: [{ id: 'svc-1', name: 'Orders DB', dimensions: { environment: 'production' } }] };
const servicesStub = { handler: () => ({ status: 'success' as const, outputs: { status: 200, body: SERVICES_API }, activePorts: ['default'] }), executeMode: 'all' as const };
function fetchStub(raw = RAW, rules = RULES) {
  return {
    handler: (ctx: { stepId: string; inputs: Record<string, unknown> }) => {
      const items = ctx.stepId === 'read_rules' ? rules : ctx.stepId === 'scopes' ? SCOPES_API : raw;
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
        'np-api-call': servicesStub,
        'sub-workflow': {
          handler: (ctx: { inputs: Record<string, unknown> }) => {
            // batch child: { facts[], catalog_slug, dry_run }
            const facts = ctx.inputs.facts as Array<Record<string, unknown>>;
            expect(facts.length).toBeLessThanOrEqual(40);
            if (!ctx.inputs.dry_run) for (const f of facts) written.push({ ...f, _slug: ctx.inputs.catalog_slug });
            return { status: 'success' as const, outputs: { count: facts.length, written: ctx.inputs.dry_run ? 0 : facts.length, ids: facts.map((f) => f.id) }, activePorts: ['default'] };
          },
          executeMode: 'all' as const,
        },
      },
    });
    // a real run returns no batches (they would sit in the parent's history): read what the upsert children got
    expect(result.outputs?.batches).toEqual([]);
    const facts = written.filter((w) => w._slug === 'cost_daily');
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
    expect(byId[`alloc-service-metrics-db-${D}-app-100-orders`]).toMatchObject({ application_id: '100', cost_usd: 6, share: 0.6, allocation_method: 'by_metric', rule_id: 'metrics-db-by-load' });
    expect(byId[`alloc-service-metrics-db-${D}-app-300-ledger`]).toMatchObject({ application_id: '300', cost_usd: 3, share: 0.3 });
    expect(byId[`alloc-service-metrics-db-${D}-scratch-unallocated`]).toMatchObject({ cost_usd: 1, share: 0.1, allocation_method: 'unallocated', metric_key: 'scratch', rule_id: 'metrics-db-by-load' });
    // regex capture → application_slug
    expect(byId[`alloc-resource-loggroup-catalog-entities-api-${D}-app-entities-api`]).toMatchObject({ application_slug: 'entities-api', cost_usd: 1.5, rule_id: 'log-groups-by-name', category: 'observability' });
    // cluster components split by the consumption metric on the cluster row; the uncovered share is k8s overhead
    expect(byId[`alloc-bucket-runtime-nodes-${D}-app-100-777`]).toMatchObject({ application_id: '100', scope_id: '777', cost_usd: 2.5, share: 0.5, allocation_method: 'by_metric', rule_id: 'default:cluster-consumption', category: 'kubernetes' });
    expect(byId[`alloc-bucket-runtime-nodes-${D}-app-400-999`]).toMatchObject({ application_id: '400', cost_usd: 1.25 });
    expect(byId[`alloc-bucket-runtime-nodes-${D}-cluster-runtime-kubernetes-overhead`]).toMatchObject({ cluster: 'runtime', cost_usd: 1.25, share: 0.25, allocation_method: 'kubernetes_overhead' });
    expect(byId[`alloc-bucket-runtime-networking-${D}-app-100-777`]).toMatchObject({ cost_usd: 1.5, category: 'kubernetes' });
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
    // application_cost_daily: one INVOICE per application — flat charge items with the null object each came through
    const appRows = written.filter((w) => w._slug === 'application_cost_daily');
    type Item = Record<string, unknown>;
    const app100 = appRows.find((r) => r.id === `100-${D}`) as { total_usd: number; charge_items: Item[]; totals: { by_charge_type: Record<string, number>; by_category: Record<string, number>; by_cloud_service: Record<string, number> } };
    expect(app100).toMatchObject({ date: D, day: D, application_id: '100', namespace_id: '5', total_usd: 30, currency: 'USD', charge_items_count: 6, cloud_accounts: ['111122223333'] });
    expect(app100.totals).toEqual({ by_charge_type: { scope: 6, service: 12, application: 12 }, by_environment: { production: 18, none: 12 }, by_category: { compute: 2, database: 24, kubernetes: 4 }, by_cloud_service: { [EC2]: 4.5, [RDS]: 24, [VPC]: 1.5 } });
    expect(app100.charge_items.map((i) => [i.charge_type, i.subject_id, i.cost_usd])).toEqual([
      ['service', 'orders-db', 12], ['application', 'shared-db', 6], ['application', 'metrics-db', 6], ['scope', 'runtime|nodes', 2.5], ['scope', '777', 2], ['scope', 'runtime|networking', 1.5],
    ]);
    expect(app100.charge_items[0]).toMatchObject({ charge_type: 'service', service_id: 'svc-1', service_name: 'Orders DB', scope_id: null, category: 'database', rule_id: 'default:null-service', share: 1, dimensions: { environment: 'production' }, environment: 'production' });
    expect(app100.charge_items[3]).toMatchObject({ charge_type: 'scope', scope_id: '777', scope_name: 'prod', scope_type: 'web_pool_k8s', environment: 'production', component: 'nodes', cluster: 'runtime', category: 'kubernetes', allocation_method: 'by_metric', rule_id: 'default:cluster-consumption', share: 0.5 });
    expect(app100.charge_items[1]).toMatchObject({ environment: null, dimensions: null });
    // the allocated fact rows carry the dimensions too
    expect(byId[`alloc-scope-777-${D}-app-100`]).toMatchObject({ dimensions: { environment: 'production' }, environment: 'production' });
    expect(app100.charge_items[4]).toMatchObject({ charge_type: 'scope', scope_id: '777', subject_type: 'scope', category: 'compute', rule_id: 'default:null-dims' });
    expect(app100.charge_items[1]).toMatchObject({ charge_type: 'application', scope_id: null, service_id: null, allocation_method: 'split', rule_id: 'shared-db-by-database' });
    const sum = Object.values(app100.totals.by_charge_type).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(app100.total_usd, 6);
    expect(appRows.map((r) => r.id).sort()).toEqual([`100-${D}`, `200-${D}`, `300-${D}`, `400-${D}`]);
    expect((appRows.find((r) => r.id === `400-${D}`) as { charge_items: Item[] }).charge_items[0]).toMatchObject({ charge_type: 'scope', scope_id: '999', cost_usd: 1.25 });
    expect(written.filter((w) => (w as { id: string }).id === `100-${D}`)).toHaveLength(1);
    expect(byId[`alloc-app-200-${D}`]).toMatchObject({ cost_usd: 2 });
    expect(byId[`alloc-bucket-shared-platform-${D}`]).toMatchObject({ bucket: 'shared-platform', cost_usd: 1 });
    expect(byId[`alloc-unallocated-${D}`]).toMatchObject({ subject_type: 'unallocated', cost_usd: 6.5, by_cloud_service: { [EC2]: 3, [CW]: 2.5, [RDS]: 1 } });

    // Σ leaves = Σ services = allocated + cluster + unallocated
    const leafRows = facts.filter((f) => f.allocation_method !== 'rollup' && f.subject_type !== 'unallocated');
    expect(leafRows.reduce((s, f) => s + Number(f.cost_usd), 0)).toBeCloseTo(48, 6);
    expect(summary.unallocated_usd).toBe(6.5);
    // wf3 published shares for the cluster: nothing is pending, what no scope covers is overhead
    expect(summary.cluster_pending_usd).toEqual({});
    expect(summary.kubernetes_overhead_usd).toEqual({ runtime: 2 });
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
    const stub = { handler: (ctx: { inputs: Record<string, unknown> }) => { if (!ctx.inputs.dry_run) written.push(...(ctx.inputs.facts as unknown[])); return { status: 'success' as const, outputs: { written: 0 }, activePorts: ['default'] }; }, executeMode: 'all' as const };
    const r = await runWorkflowE2E({ yamlPath: YAML, inputs: { date: D, dry_run: true }, pluginStubs: { manual: passthroughTrigger, 'np-entity-paginated-fetch': fetchStub(), 'np-api-call': servicesStub, 'sub-workflow': stub } });
    expect(written).toHaveLength(0);
    expect((r.outputs?.summary as { written: number; dry_run: boolean })).toMatchObject({ written: 0, dry_run: true });
    await expect(
      runWorkflowE2E({ yamlPath: YAML, inputs: { date: '2026-01-01' }, pluginStubs: { manual: passthroughTrigger, 'np-entity-paginated-fetch': fetchStub([], []), 'np-api-call': servicesStub, 'sub-workflow': stub } }),
    ).rejects.toThrow(/no raw facts for 2026-01-01/);
  });

  it('spread: a platform service is shared by every application, weighted by what each one already carries', async () => {
    const CONFIG = 'AWS Config';
    const raw = [...RAW, { id: `raw-cloud_service-config-${D}`, date: D, day: D, stage: 'raw', subject_type: 'cloud_service', subject_id: CONFIG, subject_name: CONFIG, cloud: 'aws', cloud_service: CONFIG, cost_usd: 10 }];
    const rules = [...RULES, { id: 'config-is-platform-spread', name: 'AWS Config → every app', enabled: true, status: 'active', priority: 20, scope: { cloud_service: { regex: 'AWS Config' } }, method: 'spread', target: { spread: { weights: 'attributed' } }, category: 'platform' }];
    const stub = { handler: (ctx: { inputs: Record<string, unknown> }) => { const facts = ctx.inputs.facts as Array<Record<string, unknown>>; return { status: 'success' as const, outputs: { count: facts.length, written: 0, ids: facts.map((f) => f.id) }, activePorts: ['default'] }; }, executeMode: 'all' as const };
    const run = (r: typeof raw, ru: typeof rules) => runWorkflowE2E({ yamlPath: YAML, inputs: { date: D, dry_run: true }, pluginStubs: { manual: passthroughTrigger, 'np-entity-paginated-fetch': fetchStub(r, ru), 'np-api-call': servicesStub, 'sub-workflow': stub } });
    const base = (await run(RAW, RULES)).outputs?.summary as Record<string, unknown>;
    const result = await run(raw, rules);
    const summary = result.outputs?.summary as Record<string, unknown>;
    const facts = (result.outputs?.batches as Array<{ facts: Array<Record<string, unknown>> }>).flatMap((b) => b.facts);
    const byId = Object.fromEntries(facts.map((f) => [f.id, f]));
    expect(summary.total_usd).toBe(Number(base.total_usd) + 10);
    expect(summary.platform_spread_usd).toBe(10);
    expect(summary.unallocated_usd).toBe(base.unallocated_usd); // nothing new is unallocated: the spread lands on the apps
    // weights = each application's attribution BEFORE the spread (the baseline run), never the spread itself
    const baseApps = base.applications as Array<{ owner: string; application_id: string | null; cost_usd: number }>;
    const appsBase = baseApps.filter((a) => a.application_id); // owners known only by slug get nothing: the spread needs an application id
    const tot = appsBase.reduce((s, a) => s + a.cost_usd, 0);
    const spread = facts.filter((a) => a.allocation_method === 'spread');
    expect(spread.length).toBe(appsBase.length);
    expect(Math.round(spread.reduce((s, a) => s + Number(a.cost_usd), 0) * 1e6) / 1e6).toBe(10);
    for (const a of appsBase) {
      const row = byId[`alloc-cloud_service-config-${D}-remainder-${a.owner}-spread`];
      expect(row).toMatchObject({ allocation_method: 'spread', category: 'platform', charge_type: 'application', rule_id: 'config-is-platform-spread', cloud_service: CONFIG });
      expect(Number(row?.cost_usd)).toBeCloseTo((10 * a.cost_usd) / tot, 5);
    }
    // the rollup and the by_category of each app include their share
    const app100base = appsBase.find((a) => a.owner === 'app-100') as { cost_usd: number };
    expect(Number((byId[`alloc-app-100-${D}`] as Record<string, unknown>).cost_usd)).toBeCloseTo(app100base.cost_usd + (10 * app100base.cost_usd) / tot, 5);
    expect(((byId[`alloc-app-100-${D}`] as Record<string, unknown>).by_category as Record<string, number>).platform).toBeCloseTo((10 * app100base.cost_usd) / tot, 5);
    // a spread rule when no application has cost yet → the leaf stays visibly unallocated
    const lonely = await run([raw[raw.length - 1] as (typeof raw)[number]], rules);
    expect((lonely.outputs?.summary as Record<string, unknown>).unallocated_usd).toBe(10);
  });

  it('usage-type buckets with collector shares are leaves: by_metric resolves owners from metric_owners without a map', async () => {
    const CW = 'AWS X-Ray'; // not in RAW (RAW already has a CloudWatch service with an unallocated remainder)
    const raw = [...RAW,
      { id: `raw-cloud_service-cw-${D}`, date: D, day: D, stage: 'raw', subject_type: 'cloud_service', subject_id: CW, subject_name: CW, cloud: 'aws', cloud_service: CW, cost_usd: 10 },
      { id: `raw-bucket-cw-ingest-${D}`, date: D, day: D, stage: 'raw', subject_type: 'bucket', subject_id: 'cw|DataProcessing-Bytes', subject_name: 'cw / ingest', cloud: 'aws', cloud_service: CW, parent_id: `raw-cloud_service-cw-${D}`, usage_type: 'DataProcessing-Bytes', cost_usd: 4,
        metric: 'cloudwatch.IncomingBytes', metric_shares: { 'ns.orders': 0.5, 'ns.ledger': 0.25, '/aws/eks/x/cluster': 0.25 }, metric_owners: { 'ns.orders': { application_id: '100', namespace_id: '5' }, 'ns.ledger': { application_id: '300' } } },
      { id: `raw-bucket-cw-alarms-${D}`, date: D, day: D, stage: 'raw', subject_type: 'bucket', subject_id: 'cw|AlarmMonitorUsage', cloud: 'aws', cloud_service: CW, parent_id: `raw-cloud_service-cw-${D}`, usage_type: 'AlarmMonitorUsage', cost_usd: 6 },
    ];
    const rules = [...RULES,
      { id: 'cw-logs-by-group', name: 'logs → app of the group', enabled: true, status: 'active', priority: 100, scope: { cloud_service: { regex: 'X-Ray' }, usage_type: { regex: 'DataProcessing-Bytes' } }, match: [{ field: 'metric_shares', exists: true }], method: 'by_metric', category: 'observability', target: { map: { key: 'log_group', entries: {} } } },
      { id: 'cw-rest-spread', name: 'rest of X-Ray → every app', enabled: true, status: 'active', priority: 900, scope: { cloud_service: { regex: 'X-Ray' } }, method: 'spread', category: 'observability', target: { spread: { weights: 'equal' } } },
    ];
    const stub = { handler: (ctx: { inputs: Record<string, unknown> }) => { const facts = ctx.inputs.facts as Array<Record<string, unknown>>; return { status: 'success' as const, outputs: { count: facts.length, written: 0, ids: facts.map((f) => f.id) }, activePorts: ['default'] }; }, executeMode: 'all' as const };
    const result = await runWorkflowE2E({ yamlPath: YAML, inputs: { date: D, dry_run: true }, pluginStubs: { manual: passthroughTrigger, 'np-entity-paginated-fetch': fetchStub(raw, rules), 'np-api-call': servicesStub, 'sub-workflow': stub } });
    const summary = result.outputs?.summary as Record<string, unknown>;
    const facts = (result.outputs?.batches as Array<{ facts: Array<Record<string, unknown>> }>).flatMap((b) => b.facts);
    const byId = Object.fromEntries(facts.map((f) => [f.id, f]));
    expect(summary.total_usd).toBe(58);
    // the ingest bucket is a leaf (4): 2 → app 100, 1 → app 300 (owners from the collector), 1 → unallocated with its key
    expect(byId[`alloc-bucket-cw-ingest-${D}-app-100-ns-orders`]).toMatchObject({ application_id: '100', cost_usd: 2, share: 0.5, allocation_method: 'by_metric', rule_id: 'cw-logs-by-group', category: 'observability', charge_type: 'application' });
    expect(byId[`alloc-bucket-cw-ingest-${D}-app-300-ns-ledger`]).toMatchObject({ application_id: '300', cost_usd: 1 });
    expect(byId[`alloc-bucket-cw-ingest-${D}-aws-eks-x-cluster-unallocated`]).toMatchObject({ cost_usd: 1, allocation_method: 'unallocated', metric_key: '/aws/eks/x/cluster' });
    // the alarms bucket has no shares → informational; the service remainder (10 − 4 = 6) goes to the spread rule
    expect(facts.find((f) => String(f.id).startsWith(`alloc-bucket-cw-alarms-`))).toBeUndefined();
    const spread = facts.filter((f) => f.allocation_method === 'spread' && f.cloud_service === CW);
    expect(Math.round(spread.reduce((s, f) => s + Number(f.cost_usd), 0) * 1e6) / 1e6).toBe(6);
    const base = await runWorkflowE2E({ yamlPath: YAML, inputs: { date: D, dry_run: true }, pluginStubs: { manual: passthroughTrigger, 'np-entity-paginated-fetch': fetchStub(), 'np-api-call': servicesStub, 'sub-workflow': stub } });
    expect(summary.unallocated_usd).toBe(Number((base.outputs?.summary as Record<string, unknown>).unallocated_usd) + 1);
  });
});
