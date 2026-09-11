/**
 * E2E for finops/wf-suggest-mappings.yaml: unallocated leaves + evidence (null services,
 * application parameters) → cost_mapping_suggestion rows. Platform reads stubbed at the
 * plugin level; the upsert child at the `sub-workflow` level.
 */
import { resolve } from 'node:path';
import { runWorkflowE2E } from '@nullplatform/workflow-kit/test';
import { describe, expect, it } from 'vitest';

const YAML = resolve(__dirname, '..', 'wf-suggest-mappings.yaml');
const D = '2026-09-09';
const RDS = 'Amazon Relational Database Service';
const SHARED = 'shared-db.cluster-abc.us-east-1.rds.amazonaws.com';
const ORDERS = 'orders-db.cluster-abc.us-east-1.rds.amazonaws.com';

const passthroughTrigger = { handler: () => ({ status: 'success' as const, outputs: {}, activePorts: ['default'] }), registryType: 'trigger' as const };

const LEAVES = [
  { id: `raw-service-shared-db-${D}`, cloud_service: RDS, subject_type: 'service', subject_id: 'shared-db', subject_name: 'shared-db', resource_type: 'rds:cluster', host: SHARED, cost_usd: 8 },
  { id: `raw-service-orders-db-${D}`, cloud_service: RDS, subject_type: 'service', subject_id: 'orders-db', subject_name: 'orders-db', resource_type: 'rds:cluster', host: ORDERS, cost_usd: 12 },
  { id: `raw-cloud_service-guardduty-${D}-remainder`, cloud_service: 'Amazon GuardDuty', subject_type: 'cloud_service', subject_id: 'guardduty', cost_usd: 1 },
  { id: `raw-bucket-tiny-${D}`, cloud_service: RDS, subject_type: 'service', subject_id: 'tiny-db', host: 'tiny.rds.amazonaws.com', cost_usd: 0.01 },
];
const SERVICES = { results: [{ id: 'svc-1', name: 'Orders DB', slug: 'orders-db', entity_nrn: 'organization=4:account=17:namespace=5:application=100', attributes: { host: ORDERS } }] };
const APPS = [
  { id: 100, slug: 'orders-api', namespace_id: 5 },
  { id: 200, slug: 'users-api', namespace_id: 6 },
  { id: 300, slug: 'unrelated', namespace_id: 6 },
];
const PARAMS: Record<string, unknown> = {
  100: { results: [{ name: 'DB_HOST', values: [{ value: SHARED }] }, { name: 'DB_NAME', values: [{ value: 'orders' }] }] },
  200: { results: [{ name: 'DATABASE_URL', values: [{ value: `postgres://u:p@${SHARED}:5432/users` }] }] },
  300: { results: [{ name: 'SECRET_URL', secret: true, values: [{ value: null }] }] },
};

describe('finops/wf-suggest-mappings', () => {
  it('proposes a direct rule from a null service host and a split from application parameters', async () => {
    const written: Array<Record<string, unknown>> = [];
    const result = await runWorkflowE2E({
      yamlPath: YAML,
      inputs: { date: D, unallocated_leaves: LEAVES, org_nrn: 'organization=4', account_id: '17' },
      pluginStubs: {
        manual: passthroughTrigger,
        'np-api-call': {
          handler: (ctx: { stepId: string; inputs: Record<string, unknown> }) => {
            if (ctx.stepId === 'np_services') return { status: 'success' as const, outputs: { status: 200, body: SERVICES }, activePorts: ['default'] };
            const nrn = String((ctx.inputs.query as { nrn: string }).nrn);
            const appId = nrn.split('application=')[1];
            return { status: 'success' as const, outputs: { status: 200, body: PARAMS[appId as string] ?? { results: [] } }, activePorts: ['default'] };
          },
          executeMode: 'all' as const,
        },
        'np-entity-paginated-fetch': { handler: () => ({ status: 'success' as const, outputs: { items: APPS, totalFetched: 3, pages: 1 }, activePorts: ['default'] }), executeMode: 'all' as const },
        'sub-workflow': {
          handler: (ctx: { inputs: Record<string, unknown> }) => { written.push(ctx.inputs); return { status: 'success' as const, outputs: { id: (ctx.inputs.fact as { id: string }).id }, activePorts: ['default'] }; },
          executeMode: 'all' as const,
        },
      },
    });
    const sugg = result.outputs?.suggestions as Array<Record<string, unknown>>;
    const summary = result.outputs?.summary as Record<string, unknown>;
    expect(sugg.map((s) => s.id)).toEqual([`sugg-orders-db-${D}`, `sugg-shared-db-${D}`]); // by recovered USD; tiny (< min_usd) and GuardDuty (no evidence) skipped

    const orders = sugg[0] as { rule: Record<string, unknown>; evidence: Array<Record<string, unknown>>; confidence: number };
    expect(orders.confidence).toBe(0.95);
    expect(orders.rule).toEqual({ scope: { cloud_service: RDS }, match: [{ field: 'host', equals: ORDERS }], method: 'direct', target: { application_id: '100', namespace_id: '5', service_id: 'svc-1' } });
    expect(orders.evidence[0]).toMatchObject({ kind: 'null_service', service_id: 'svc-1', application_id: '100' });

    const shared = sugg[1] as { rule: { method: string; target: { split: Array<{ weight: number; target: Record<string, unknown> }> } }; evidence: Array<Record<string, unknown>>; confidence: number; recovers_usd: number };
    expect(shared.confidence).toBe(0.6);
    expect(shared.recovers_usd).toBe(8);
    expect(shared.rule.method).toBe('split');
    expect(shared.rule.target.split.map((p) => [p.weight, p.target.application_id, p.target.application_slug])).toEqual([[1, '100', 'orders-api'], [1, '200', 'users-api']]);
    expect(shared.evidence.map((e) => e.kind)).toEqual(['parameter', 'parameter']);

    expect(summary).toMatchObject({ suggestions: 2, recovers_usd: 20, apps_scanned: 3, services: 1, written: 2 });
    expect(written.map((w) => w.catalog_slug)).toEqual(['cost_mapping_suggestion', 'cost_mapping_suggestion']);
    expect((written[0]?.fact as { status: string }).status).toBe('proposed');
  });
});
