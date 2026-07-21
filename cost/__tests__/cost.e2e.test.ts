/**
 * @file E2E + shape tests for the cost tracker / right-sizing suite.
 *
 * E2E (runWorkflowE2E, plugin-level stubs):
 *   - wf1 cost-tracker: one collector sub-execution per K8s scope, date
 *     defaulting, nrn filter, summary math (priced / no-data / org cost).
 *   - wf1b collect-scope: prices the day from the agent stdout, merges the
 *     365-day series (first run + existing instance + same-day replace),
 *     upserts the catalog instance.
 *   - wf2b analyze-scope: deterministic filter branches (not_candidate /
 *     no_data / below_min_savings per environment), AI verdict branches
 *     (not_genuine, AI saving under the env floor), create path with ONE
 *     suggestion in the AI-chosen mode, refresh path on recommendation
 *     change.
 *   - wf3 events: comment events forward a rightsizing-command signal keyed
 *     by action item; accepted suggestions start the apply workflow.
 *   - wf4 apply: apply-only patches the spec and leaves the item OPEN;
 *     nocturnal mode deploys, marks applied and closes the item.
 *
 * Plugin stubs cannot see step config (stubs ignore `configure()`), so
 * payload constants (close action, suggestion modes, labels) are asserted by
 * parsing the YAML directly. Steps whose payloads matter at runtime declare
 * observation `inputs:` so stubs can capture them.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeWorkflowDocument,
  parseYamlDocument,
  schemaValidate,
} from '@nullplatform/workflow-kit/test';
import type { IStepResult, IWorkflowDefinition } from '@nullplatform/workflow-kit/test';
import { describe, expect, it } from 'vitest';

import { runWorkflowE2E } from '@nullplatform/workflow-kit/test';

const DIR = join(fileURLToPath(import.meta.url), '..', '..');
const FILES = {
  tracker: 'wf1-cost-tracker.yaml',
  collect: 'wf1b-cost-scope-collect.yaml',
  scanner: 'wf2-right-sizing-scanner.yaml',
  analyze: 'wf2b-right-sizing-analyze-scope.yaml',
  metricsTool: 'wf2c-cost-metrics-tool.yaml',
  events: 'wf3-right-sizing-events.yaml',
  calibration: 'wf6-cluster-cost-calibration.yaml',
  apply: 'wf4-apply-rightsizing.yaml',
  closer: 'wf7-rightsizing-closer.yaml',
  verify: 'wf7b-rightsizing-verify-scope.yaml',
  qa: 'wf8-rightsizing-qa.yaml',
  // Reusable progressive-deploy pack (workflows/deploy)
  progressive: '../deploy/progressive-deploy.yaml',
  deployStart: '../deploy/tools/deploy-start.yaml',
  deployStatus: '../deploy/tools/deploy-status.yaml',
  deploySwitch: '../deploy/tools/deploy-switch-traffic.yaml',
  deployFinish: '../deploy/tools/deploy-finish.yaml',
  deployMetrics: '../deploy/tools/deploy-metrics.yaml',
  itemComment: '../deploy/tools/item-comment.yaml',
} as const;

async function loadYaml(filename: string): Promise<IWorkflowDefinition> {
  const yaml = await readFile(join(DIR, filename), 'utf8');
  const parsed = parseYamlDocument(yaml);
  const errors = parsed.errors.filter((e) => e.severity === 'error');
  if (errors.length > 0)
    throw new Error(`YAML parse errors in ${filename}: ${JSON.stringify(errors)}`);
  const normalized = normalizeWorkflowDocument(parsed.document);
  const validated = schemaValidate(normalized);
  if (!validated.ok)
    throw new Error(`Schema errors in ${filename}: ${JSON.stringify(validated.errors)}`);
  return validated.value as unknown as IWorkflowDefinition;
}

const ok = (outputs: Record<string, unknown>, items?: Record<string, unknown>[]): IStepResult => ({
  status: 'success',
  outputs,
  ...(items !== undefined ? { items } : {}),
  activePorts: ['default'],
});

const passthroughTrigger = {
  handler: () => ok({}),
  registryType: 'trigger' as const,
};

const SCOPES = [
  {
    scope_id: 111,
    scope_name: 'API Prod',
    scope_slug: 'api-prod',
    scope_nrn: 'organization=1:account=2:namespace=3:application=4',
    app_name: 'api',
  },
  {
    scope_id: 222,
    scope_name: 'Worker Prod',
    scope_slug: 'worker-prod',
    scope_nrn: 'organization=1:account=2:namespace=3:application=5',
    app_name: 'worker',
  },
];

const lakeStub = (rows: Record<string, unknown>[]) => ({
  handler: () => ok({ rows, rowCount: rows.length }),
  executeMode: 'all' as const,
});

// ── Shape: every file parses, normalizes and schema-validates ───────────

describe('cost suite (shape)', () => {
  for (const [key, file] of Object.entries(FILES)) {
    it(`${key} (${file}) parses + validates`, async () => {
      const def = await loadYaml(file);
      expect(def.id).toBeTruthy();
      expect(Object.keys(def.steps ?? {}).length).toBeGreaterThan(0);
    });
  }

  it('wf4 closes the item with action close, wf2b labels items workflow_type=rightsizing', async () => {
    const applyRaw = await readFile(join(DIR, FILES.apply), 'utf8');
    expect(applyRaw).toMatch(/action:\s*close/);
    const analyzeRaw = await readFile(join(DIR, FILES.analyze), 'utf8');
    expect(analyzeRaw).toMatch(/workflow_type:\s*"?rightsizing"?/);
    // ONE suggestion whose mode is the AI's choice (build_item validates it)
    expect(analyzeRaw).toMatch(/mode:\s*"\$\{\{ steps\.build_item\.outputs\.mode \}\}"/);
    expect(analyzeRaw).toMatch(/recommended_mode/);
    // Accept form: deploy_timing + deploy_at rendered from user_metadata_config
    expect(analyzeRaw).toMatch(/userMetadataConfig/);
    expect(analyzeRaw).toMatch(/deploy_timing/);
    expect(analyzeRaw).toMatch(/deploy_at/);
  });

  it('signal-wait uses onTimeout continue (no timeout port on connections)', async () => {
    const applyRaw = await readFile(join(DIR, FILES.apply), 'utf8');
    expect(applyRaw).toMatch(/onTimeout:\s*continue/);
    expect(applyRaw).not.toMatch(/source_port:\s*"?timeout"?/);
  });
});

// ── wf1 cost-tracker ────────────────────────────────────────────────────

interface CollectCall {
  scope: Record<string, unknown>;
  date: unknown;
}

async function runTracker(opts: {
  inputs?: Record<string, unknown>;
  childResults?: Record<string, Record<string, unknown>>;
}) {
  const collectCalls: CollectCall[] = [];
  const result = await runWorkflowE2E({
    yamlPath: resolve(DIR, FILES.tracker),
    inputs: opts.inputs ?? {},
    pluginStubs: {
      manual: passthroughTrigger,
      cron: passthroughTrigger,
      'np-lake-query': lakeStub(SCOPES),
      'sub-workflow': {
        handler: (ctx: { inputs: Record<string, unknown> }) => {
          const scope = ctx.inputs.scope as Record<string, unknown>;
          collectCalls.push({ scope, date: ctx.inputs.date });
          const byId = opts.childResults ?? {};
          const r = byId[String(scope.scope_id)] ?? { status: 'ok', cost_day: 1.5 };
          return ok(r);
        },
        executeMode: 'all' as const,
      },
    },
  });
  return { result, collectCalls };
}

describe('wf1-cost-tracker (E2E)', () => {
  it('collects every active scope with the resolved date and sums the org cost', async () => {
    const { result, collectCalls } = await runTracker({
      inputs: { date: '2026-07-15' },
      childResults: {
        '111': { status: 'ok', cost_day: 2.5 },
        '222': { status: 'no-data', cost_day: 0 },
      },
    });
    expect(collectCalls).toHaveLength(2);
    expect(collectCalls[0]!.date).toBe('2026-07-15');
    expect(result.outputs.scopes).toBe(2);
    expect(result.outputs.priced).toBe(1);
    expect(result.outputs.no_data).toBe(1);
    expect(result.outputs.failed).toBe(0);
    expect(result.outputs.org_cost_day).toBe(2.5);
  });

  it('defaults the date to yesterday (UTC)', async () => {
    const { collectCalls } = await runTracker({});
    const date = String(collectCalls[0]!.date);
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const deltaDays = (Date.now() - Date.parse(date)) / 86400000;
    expect(deltaDays).toBeGreaterThan(0.9);
    expect(deltaDays).toBeLessThan(2.1);
  });

  it('honors the nrn prefix filter', async () => {
    const { collectCalls, result } = await runTracker({
      inputs: { nrn: 'organization=1:account=2:namespace=3:application=4' },
    });
    expect(collectCalls).toHaveLength(1);
    expect(collectCalls[0]!.scope.scope_id).toBe(111);
    expect(result.outputs.scopes).toBe(1);
  });
});

// ── wf1b collect-scope ──────────────────────────────────────────────────

const DAY_STDOUT = JSON.stringify({
  mode: 'day',
  date: '2026-07-15',
  hours: [],
  cpu_mc_hours: 2400,
  mem_mb_hours: 12000,
  cpu_req_mc_avg: 200,
  mem_req_mb_avg: 512,
  cpu_mc_p95: 180,
  cpu_mc_pk10m: 950,
  mem_mb_pk: 640,
  cpu_mc_valley: 40,
  peak_hour: 13,
  samples: 24,
});

async function runCollect(opts: {
  existing?: Record<string, unknown> | null;
  stdout?: string;
  /** GET /scope body for the config-billing basis; omitted → 404 → KSM fallback. */
  scopeBody?: Record<string, unknown>;
}) {
  let upserted: Record<string, unknown> | null = null;
  let upsertPath: string | null = null;
  const result = await runWorkflowE2E({
    yamlPath: resolve(DIR, FILES.collect),
    inputs: { scope: SCOPES[0], date: '2026-07-15' },
    pluginStubs: {
      manual: passthroughTrigger,
      'np-agent-command': {
        handler: () =>
          ok({ status: 'success', stdout: opts.stdout ?? DAY_STDOUT, stderr: '', exitCode: 0 }),
        executeMode: 'all' as const,
      },
      'np-api-call': {
        handler: (ctx: { stepId: string; inputs: Record<string, unknown> }) => {
          if (ctx.stepId === 'fetch_scope') {
            // No scope config in these fixtures → billing falls back to the
            // KSM request basis (the numbers asserted below). Config-basis
            // billing has its own coverage via `scopeBody`.
            return opts.scopeBody
              ? ok({ status: 200, body: opts.scopeBody })
              : ok({ status: 404, body: null });
          }
          if (ctx.stepId === 'fetch_instance') {
            return opts.existing
              ? ok({ status: 200, body: opts.existing })
              : ok({ status: 404, body: null });
          }
          if (ctx.stepId === 'create_instance') {
            // Mirrors the live API: POST creates, 400 when it already exists.
            if (opts.existing) return ok({ status: 400, body: { message: 'already exists' } });
            upserted = ctx.inputs.payload as Record<string, unknown>;
            upsertPath = 'created';
            return ok({ status: 201, body: {} });
          }
          if (ctx.stepId === 'update_instance') {
            upserted = ctx.inputs.payload as Record<string, unknown>;
            upsertPath = 'updated';
            return ok({ status: 200, body: {} });
          }
          throw new Error(`unexpected np-api-call step: ${ctx.stepId}`);
        },
        executeMode: 'all' as const,
      },
    },
  });
  return { result, upserted: upserted as Record<string, unknown> | null, upsertPath };
}

describe('wf1b-cost-scope-collect (E2E)', () => {
  it('prices the day and creates the first instance', async () => {
    const { result, upserted } = await runCollect({ existing: null });
    // Chargeback basis max(used, requested):
    //   cpu max(2400, 200×24=4800)=4800 mc-h × 0.000011 = 0.0528
    //   mem max(12000, 512×24=12288)=12288 MB-h × 0.0000048 = 0.059
    expect(result.outputs.cost_day).toBeCloseTo(0.1118, 3);
    expect(result.outputs.status).toBe('ok');
    expect(upserted).not.toBeNull();
    const inst = upserted!;
    expect(inst.cost_today).toBeCloseTo(0.1118, 3);
    // usage basis kept alongside; the gap is the scope's waste
    expect(inst.usage_cost_today).toBeCloseTo(0.084, 4);
    expect(inst.waste_today).toBeCloseTo(0.0278, 3);
    expect(inst.cost_7d).toBeCloseTo(0.1118, 3);
    expect(inst.currency).toBe('USD');
    const series = inst.daily_series as Record<string, unknown>[];
    expect(series).toHaveLength(1);
    expect(series[0]!.d).toBe('2026-07-15');
    expect(series[0]!.cpu_mc_h).toBe(2400);
    expect(series[0]!.cpu_req_mc).toBe(200);
    expect(series[0]!.mem_req_mb).toBe(512);
    const breakdown = inst.cost_breakdown as Record<string, number>;
    expect(breakdown.cpu_pct + breakdown.mem_pct).toBeCloseTo(100, 1);
    // usage-vs-request rollups + utilization signal (24 samples → avg = total/24)
    expect(inst.cpu_request_mc).toBe(200);
    expect(inst.mem_request_mb).toBe(512);
    expect(inst.cpu_avg_usage_mc).toBeCloseTo(100, 1); // 2400 mc-h / 24
    expect(inst.mem_avg_usage_mb).toBeCloseTo(500, 1); // 12000 MB-h / 24
    expect(inst.cpu_utilization_pct).toBeCloseTo(50, 1); // 100 / 200
    expect(inst.mem_utilization_pct).toBeCloseTo(97.66, 1); // 500 / 512
    // provisioning_status is scanner-owned: with no prior value the tracker
    // writes 'unknown', never a naive daily classification.
    expect(inst.provisioning_status).toBe('unknown');
    expect(inst.rightsizing_item_id).toBeNull();
    // 10m-resolution peak profile preserved in the instance AND the series —
    // daily averages hide traffic peaks; this is what production sizing and
    // the descale check read.
    expect(inst.cpu_peak10m_mc_today).toBe(950);
    expect(inst.mem_peak_mb_today).toBe(640);
    expect(series[0]!.cpu_mc_pk10m).toBe(950);
    expect(series[0]!.cpu_mc_p95).toBe(180);
    expect(series[0]!.mem_mb_pk).toBe(640);
    expect(series[0]!.cpu_mc_valley).toBe(40);
    expect(series[0]!.peak_hour).toBe(13);
  });

  it("bills hour by hour with THAT hour's request (replica scaling is real)", async () => {
    const { result, upserted } = await runCollect({
      existing: null,
      stdout: JSON.stringify({
        mode: 'day',
        date: '2026-07-15',
        // Hour 0: 10 pods requesting 1000mc total; hour 1: 1 pod, 100mc.
        hours: [
          { h: 0, cpu_mc: 100, mem_mb: 200, cpu_req_mc: 1000, mem_req_mb: 512, pods: 10 },
          { h: 1, cpu_mc: 50, mem_mb: 100, cpu_req_mc: 100, mem_req_mb: 128, pods: 1 },
        ],
        cpu_mc_hours: 150,
        mem_mb_hours: 300,
        cpu_req_mc_hours: 1100,
        mem_req_mb_hours: 640,
        cpu_req_mc_avg: 550,
        mem_req_mb_avg: 320,
        pods_min: 1,
        pods_max: 10,
        pods_avg: 5.5,
        samples: 2,
      }),
    });
    // billed: cpu max(100,1000)+max(50,100)=1100 ×1.1e-5 = 0.0121
    //         mem max(200,512)+max(100,128)=640 ×4.8e-6 = 0.00307
    expect(result.outputs.cost_day).toBeCloseTo(0.0121 + 0.00307, 3);
    const inst = upserted!;
    expect(inst.usage_cost_today).toBeCloseTo(150 * 0.000011 + 300 * 0.0000048, 4);
    expect(inst.pods_min_today).toBe(1);
    expect(inst.pods_max_today).toBe(10);
    const pt = (inst.daily_series as Record<string, unknown>[])[0]!;
    expect(pt.cpu_req_mc_h).toBe(1100); // Σ hourly requests, not avg×24
    expect(pt.pods_max).toBe(10);
  });

  it('preserves the scanner-owned provisioning flag on daily upserts', async () => {
    const { upserted } = await runCollect({
      existing: {
        daily_series: [],
        provisioning_status: 'over_provisioned',
        rightsizing_item_id: 'ai_77',
        last_scan_at: '2026-07-10T05:00:00.000Z',
        last_scan_status: 'created',
      },
    });
    expect(upserted!.provisioning_status).toBe('over_provisioned');
    expect(upserted!.rightsizing_item_id).toBe('ai_77');
    // last-scan stamp is scanner-owned too (drives the rescan window)
    expect(upserted!.last_scan_at).toBe('2026-07-10T05:00:00.000Z');
    expect(upserted!.last_scan_status).toBe('created');
  });

  it('appends to an existing series and rolls up 7d', async () => {
    const { upserted } = await runCollect({
      existing: {
        daily_series: [{ d: '2026-07-14', cpu_mc_h: 2400, mem_mb_h: 12000, cost: 0.084 }],
      },
    });
    const series = upserted!.daily_series as Record<string, unknown>[];
    expect(series).toHaveLength(2);
    expect(series.map((p) => p.d)).toEqual(['2026-07-14', '2026-07-15']);
    expect(upserted!.cost_7d).toBeCloseTo(0.084 + 0.1118, 3);
  });

  it('replaces the same-day point on rerun (no duplicates)', async () => {
    const { upserted } = await runCollect({
      existing: {
        daily_series: [{ d: '2026-07-15', cpu_mc_h: 1, mem_mb_h: 1, cost: 9.99 }],
      },
    });
    const series = upserted!.daily_series as Record<string, unknown>[];
    expect(series).toHaveLength(1);
    expect(series[0]!.cost).toBeCloseTo(0.1118, 3);
  });

  it('caps the series at 365 points (FIFO)', async () => {
    const old: Record<string, unknown>[] = [];
    for (let i = 0; i < 365; i++) {
      const d = new Date(Date.UTC(2025, 6, 1) + i * 86400000).toISOString().slice(0, 10);
      old.push({ d, cpu_mc_h: 1, mem_mb_h: 1, cost: 0.01 });
    }
    const { upserted } = await runCollect({ existing: { daily_series: old } });
    const series = upserted!.daily_series as Record<string, unknown>[];
    expect(series).toHaveLength(365);
    expect(series[series.length - 1]!.d).toBe('2026-07-15');
    expect(series[0]!.d).not.toBe(old[0]!.d);
  });

  it('reports no-data without writing an instance when the collector saw no samples', async () => {
    const { result, upserted } = await runCollect({
      stdout: JSON.stringify({
        mode: 'day',
        date: '2026-07-15',
        hours: [],
        cpu_mc_hours: 0,
        mem_mb_hours: 0,
        samples: 0,
      }),
    });
    expect(result.outputs.status).toBe('no-data');
    expect(result.outputs.cost_day).toBe(0);
    // Scopes outside the monitored cluster must NOT get a zeros instance.
    expect(upserted).toBeNull();
  });
});

// ── wf2b analyze-scope ──────────────────────────────────────────────────

const RANGE_STDOUT = (over: boolean) =>
  JSON.stringify({
    mode: 'range',
    days: 14,
    step: 3600,
    points: [{ t: 1, cpu_mc: 100, cpu_req_mc: over ? 400 : 120, mem_mb: 200, mem_req_mb: 250 }],
    summary: {
      cpu: { avg_usage_mc: 100, avg_request_mc: over ? 400 : 120, p95_usage_mc: 150 },
      mem: { avg_usage_mb: 200, avg_request_mb: 250, p95_usage_mb: 220 },
    },
  });

interface AnalyzeStubOpts {
  stdout?: string;
  genuine?: boolean;
  aiSavings?: number;
  aiMode?: string;
  environment?: string;
  minSavingsByEnv?: string;
  minChangePctByEnv?: string;
  found?: { count: number; items: unknown[]; firstMatch: Record<string, unknown> | null };
  /** cost_tracking instance returned to get_flag_inst (404 when absent). */
  instance?: Record<string, unknown> | null;
  /** cost_tracking instance returned to fetch_tracker/prefilter (404 when absent). */
  tracker?: Record<string, unknown> | null;
  /** wf2b force input: bypass the prefilter. */
  force?: boolean;
  /** wf2b target_util_by_env input: ceilings + sizing basis per env. */
  targetUtilByEnv?: string;
  /** wf2b floors_by_env input: platform floors per env. */
  floorsByEnv?: string;
}

async function runAnalyze(opts: AnalyzeStubOpts) {
  const created: Record<string, unknown>[] = [];
  const suggestions: { stepId: string; itemId: unknown; mode: unknown }[] = [];
  const updates: Record<string, unknown>[] = [];
  const flagWrites: Record<string, unknown>[] = [];
  let agentRan = false;
  const result = await runWorkflowE2E({
    yamlPath: resolve(DIR, FILES.analyze),
    inputs: {
      scope: SCOPES[0],
      ...(opts.minSavingsByEnv !== undefined ? { min_savings_by_env: opts.minSavingsByEnv } : {}),
      ...(opts.minChangePctByEnv !== undefined
        ? { min_change_pct_by_env: opts.minChangePctByEnv }
        : {}),
      ...(opts.force !== undefined ? { force: opts.force } : {}),
      ...(opts.targetUtilByEnv !== undefined ? { target_util_by_env: opts.targetUtilByEnv } : {}),
      ...(opts.floorsByEnv !== undefined ? { floors_by_env: opts.floorsByEnv } : {}),
    },
    pluginStubs: {
      manual: passthroughTrigger,
      'np-agent-command': {
        handler: () =>
          ok({
            status: 'success',
            stdout: opts.stdout ?? RANGE_STDOUT(true),
            stderr: '',
            exitCode: 0,
          }),
        executeMode: 'all' as const,
      },
      'np-api-call': {
        handler: (ctx: { stepId: string; inputs: Record<string, unknown> }) => {
          // fetch_tracker: the prefilter's view of the tracker metadata.
          if (ctx.stepId === 'fetch_tracker') {
            return opts.tracker
              ? ok({ status: 200, body: opts.tracker })
              : ok({ status: 404, body: null });
          }
          // get_flag_inst / put_flag: the catalog-flag sync chain.
          if (ctx.stepId === 'get_flag_inst') {
            return opts.instance
              ? ok({ status: 200, body: opts.instance })
              : ok({ status: 404, body: null });
          }
          if (ctx.stepId === 'put_flag') {
            flagWrites.push(ctx.inputs.payload as Record<string, unknown>);
            return ok({ status: 200, body: {} });
          }
          // fetch_scope: the environment dimension drives the per-env floor.
          return ok({
            status: 200,
            body: {
              id: SCOPES[0]!.scope_id,
              dimensions: { environment: opts.environment ?? 'development' },
            },
          });
        },
        executeMode: 'all' as const,
      },
      'claude-code-agent': {
        handler: () => {
          agentRan = true;
          return ok({
            genuine: opts.genuine !== false,
            reason: '- **peaks**: flat\n- **trend**: none',
            recommended_cpu_request_mc: 200,
            recommended_mem_request_mb: 256,
            recommended_mode: opts.aiMode ?? 'apply-only',
            confidence: 0.9,
            estimated_savings_usd_month: opts.aiSavings ?? 1.6,
            risk_level: 'low',
          });
        },
        executeMode: 'all' as const,
      },
      'np-action-item-find': {
        handler: () => ok(opts.found ?? { count: 0, items: [], firstMatch: null }),
        executeMode: 'all' as const,
      },
      'np-action-item-create': {
        handler: (ctx: { inputs: Record<string, unknown> }) => {
          created.push(ctx.inputs);
          return ok({ actionItemId: 'ai_new', slug: 'rs-1', status: 'open', actionItem: {} });
        },
        executeMode: 'all' as const,
      },
      'np-action-item-suggestion-create': {
        handler: (ctx: { stepId: string; inputs: Record<string, unknown> }) => {
          suggestions.push({
            stepId: ctx.stepId,
            itemId: ctx.inputs.observed_item_id,
            mode: ctx.inputs.observed_mode,
          });
          return ok({ suggestionId: `sug_${ctx.stepId}`, suggestion: {} });
        },
        executeMode: 'all' as const,
      },
      'np-action-item-update': {
        handler: (ctx: { inputs: Record<string, unknown> }) => {
          updates.push(ctx.inputs);
          return ok({ actionItem: {} });
        },
        executeMode: 'all' as const,
      },
    },
  });
  return { result, created, suggestions, updates, flagWrites, agentRan };
}

describe('wf2b-right-sizing-analyze-scope (E2E)', () => {
  it('creates the item and ONE suggestion in the AI-chosen mode on a genuine new finding', async () => {
    const { result, created, suggestions, agentRan } = await runAnalyze({
      aiMode: 'nocturnal-deploy',
    });
    expect(agentRan).toBe(true);
    expect(created).toHaveLength(1);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.stepId).toBe('suggest_apply');
    expect(suggestions[0]!.itemId).toBe('ai_new');
    expect(suggestions[0]!.mode).toBe('nocturnal-deploy');
    expect(result.outputs.status).toBe('created');
    expect(result.outputs.action_item_id).toBe('ai_new');
    expect(result.outputs.estimated_savings_usd_month).toBe(1.6);
  });

  it('falls back to apply-only when the AI returns an unexpected mode', async () => {
    const { suggestions } = await runAnalyze({ aiMode: 'yolo-deploy' });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.mode).toBe('apply-only');
  });

  it('item metadata carries the per-dimension opportunity (resources + USD)', async () => {
    const { created } = await runAnalyze({});
    const meta = created[0]!.observed_metadata as Record<string, number>;
    // avg request 400/250, recommended 200/256 (AI stub) → cpu reclaims 200mc,
    // memory nothing (rec above current).
    expect(meta.cpu_reclaim_mc).toBe(200);
    expect(meta.mem_reclaim_mb).toBe(0);
    expect(meta.cpu_savings_usd_month).toBeCloseTo(200 * 0.000011 * 730, 2);
    expect(meta.mem_savings_usd_month).toBe(0);
  });

  it('production: creates the item WITH a suggestion, forced to apply-only (never deploys)', async () => {
    const { result, created, suggestions } = await runAnalyze({
      environment: 'production',
      minSavingsByEnv: '{"default":1,"production":1}',
    });
    expect(created).toHaveLength(1);
    // Production policy v2: the one-click apply IS offered, but the mode is
    // apply-only regardless of the AI's recommendation — wf4 enforces it
    // server-side too. (Was: no suggestion at all.)
    expect(suggestions).toHaveLength(1);
    expect((suggestions[0] as { mode?: string }).mode).toBe('apply-only');
    expect(result.outputs.status).toBe('created');
  });

  it('production: the 25% min-change rule skips deltas the 10% default would act on', async () => {
    // request 500, p95 290 → rec 400 → delta 100 = 20%: passes in dev (>=10%)
    // but NOT via pct in prod (<25%)… yet the 100-unit absolute still
    // applies. Use request 900, p95 660 → rec 800 → delta 100 (11%):
    // dev acts (>=10%), prod must skip only when delta<25% AND <100 — delta
    // is exactly 100, so use 899/661 → rec 800, delta 99 (11%).
    const stdout = JSON.stringify({
      mode: 'range',
      days: 14,
      step: 3600,
      points: [{ t: 1, cpu_mc: 500, cpu_req_mc: 899, mem_mb: 200, mem_req_mb: 250 }],
      summary: {
        cpu: { avg_usage_mc: 500, avg_request_mc: 899, p95_usage_mc: 661 },
        mem: { avg_usage_mb: 200, avg_request_mb: 250, p95_usage_mb: 220 },
      },
    });
    const cfg = '{"default":10,"production":25}';
    const dev = await runAnalyze({
      stdout,
      environment: 'development',
      minSavingsByEnv: '{"default":0}',
      minChangePctByEnv: cfg,
    });
    expect(dev.result.outputs.status).not.toBe('not_candidate');
    const prod = await runAnalyze({
      stdout,
      environment: 'production',
      minSavingsByEnv: '{"default":0}',
      minChangePctByEnv: cfg,
    });
    expect(prod.result.outputs.status).toBe('not_candidate');
  });

  it('skips as below_min_savings when the env floor exceeds the naive saving (no AI call)', async () => {
    // Naive saving for RANGE_STDOUT(true) ≈ 1.61 USD/month; dev floor 5 kills it.
    const { result, agentRan, created } = await runAnalyze({
      minSavingsByEnv: '{"default":1,"development":5}',
    });
    expect(result.outputs.status).toBe('below_min_savings');
    expect(agentRan).toBe(false);
    expect(created).toHaveLength(0);
  });

  it('uses the default floor when the environment has no explicit entry', async () => {
    const { result, agentRan } = await runAnalyze({
      minSavingsByEnv: '{"default":5,"production":1}',
      environment: 'development',
    });
    expect(result.outputs.status).toBe('below_min_savings');
    expect(agentRan).toBe(false);
  });

  it('discards when the AI-refined saving lands under the env floor', async () => {
    // Naive ≈ 1.61 passes the 1.603 floor, but the AI refines it down to 1.6.
    const { result, agentRan, created } = await runAnalyze({
      minSavingsByEnv: '{"default":1.603}',
    });
    expect(agentRan).toBe(true);
    expect(result.outputs.status).toBe('not_genuine');
    expect(created).toHaveLength(0);
  });

  it('stops as not_candidate when requests are within threshold (no AI call)', async () => {
    const { result, agentRan, created } = await runAnalyze({ stdout: RANGE_STDOUT(false) });
    expect(result.outputs.status).toBe('not_candidate');
    expect(agentRan).toBe(false);
    expect(created).toHaveLength(0);
  });

  it('stops as no_data when the collector returned no points', async () => {
    const { result, agentRan } = await runAnalyze({
      stdout: JSON.stringify({ mode: 'range', days: 14, step: 3600, points: [], summary: {} }),
    });
    expect(result.outputs.status).toBe('no_data');
    expect(agentRan).toBe(false);
  });

  it('discards AI-rejected candidates without touching action items', async () => {
    const { result, created, suggestions } = await runAnalyze({ genuine: false });
    expect(result.outputs.status).toBe('not_genuine');
    expect(created).toHaveLength(0);
    expect(suggestions).toHaveLength(0);
  });

  it('refreshes an existing item when the recommendation changed (no new suggestions)', async () => {
    // force: without it, live items resolve on tracker data alone and never
    // reach the refresh path (rescan economy).
    const { result, created, suggestions, updates } = await runAnalyze({
      force: true,
      found: {
        count: 1,
        items: [],
        firstMatch: {
          id: 'ai_old',
          metadata: { recommended_cpu_request_mc: 500, recommended_mem_request_mb: 256 },
        },
      },
    });
    expect(created).toHaveLength(0);
    expect(suggestions).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(result.outputs.status).toBe('updated');
    expect(result.outputs.action_item_id).toBe('ai_old');
  });

  it('no-ops when the existing recommendation is identical', async () => {
    const { result, updates } = await runAnalyze({
      force: true,
      found: {
        count: 1,
        items: [],
        firstMatch: {
          id: 'ai_old',
          metadata: { recommended_cpu_request_mc: 200, recommended_mem_request_mb: 256 },
        },
      },
    });
    expect(updates).toHaveLength(0);
    expect(result.outputs.status).toBe('unchanged');
  });

  // ── stale-item close + catalog-flag lifecycle ───────────────────────────

  it('closes a stale item when the scope no longer qualifies (forced deep path)', async () => {
    // force → the full analysis runs even with a live item (without force,
    // live items resolve on tracker data alone — covered below).
    const { result, updates, flagWrites } = await runAnalyze({
      stdout: RANGE_STDOUT(false), // deterministic filter says no
      force: true,
      found: { count: 1, items: [], firstMatch: { id: 'ai_stale', metadata: {} } },
      instance: { provisioning_status: 'over_provisioned', rightsizing_item_id: 'ai_stale' },
    });
    expect(result.outputs.status).toBe('closed_stale');
    expect(result.outputs.action_item_id).toBe('ai_stale');
    expect(updates).toHaveLength(1);
    expect(updates[0]!.reason).toContain('no longer qualifies');
    // flag flips back: the item lifecycle is the authority
    expect(flagWrites).toHaveLength(1);
    expect(flagWrites[0]!.provisioning_status).toBe('optimal');
    expect(flagWrites[0]!.rightsizing_item_id).toBeNull();
  });

  it('closes a stale item when the AI stops considering it genuine', async () => {
    const { result, updates } = await runAnalyze({
      genuine: false,
      force: true,
      found: { count: 1, items: [], firstMatch: { id: 'ai_stale', metadata: {} } },
      instance: { provisioning_status: 'over_provisioned' },
    });
    expect(result.outputs.status).toBe('closed_stale');
    expect(updates).toHaveLength(1);
    expect(String(updates[0]!.reason)).toContain('AI validation');
  });

  it('never closes on no_data (unmonitored is not fixed)', async () => {
    const { result, updates, flagWrites } = await runAnalyze({
      stdout: JSON.stringify({ mode: 'range', days: 14, step: 3600, points: [], summary: {} }),
      force: true,
      found: { count: 1, items: [], firstMatch: { id: 'ai_live', metadata: {} } },
      instance: { provisioning_status: 'over_provisioned' },
    });
    expect(result.outputs.status).toBe('no_data');
    expect(updates).toHaveLength(0);
    // no_data is not a verdict: no flag write, no last_scan stamp — the
    // scope must be re-analyzed on the next run.
    expect(flagWrites).toHaveLength(0);
  });

  it('sets the over_provisioned flag on the catalog instance when creating an item', async () => {
    const { flagWrites } = await runAnalyze({
      instance: { provisioning_status: 'unknown', cost_7d: 1.2 },
    });
    expect(flagWrites).toHaveLength(1);
    expect(flagWrites[0]!.provisioning_status).toBe('over_provisioned');
    expect(flagWrites[0]!.rightsizing_item_id).toBe('ai_new');
    // the rest of the instance body is preserved, not clobbered
    expect(flagWrites[0]!.cost_7d).toBe(1.2);
    // every conclusive verdict stamps the rescan window
    expect(flagWrites[0]!.last_scan_status).toBe('created');
    expect(typeof flagWrites[0]!.last_scan_at).toBe('string');
  });

  it('a not_candidate verdict stamps last_scan; hot pods flag under_provisioned', async () => {
    // RANGE_STDOUT(false): request 120mc but p95 usage 150mc — nothing to
    // reclaim AND the pod runs hot → the catalog flags the risk.
    const { result, flagWrites, updates } = await runAnalyze({
      stdout: RANGE_STDOUT(false),
      instance: { provisioning_status: 'unknown', rightsizing_item_id: null },
    });
    expect(result.outputs.status).toBe('not_candidate');
    expect(updates).toHaveLength(0);
    expect(flagWrites).toHaveLength(1);
    expect(flagWrites[0]!.provisioning_status).toBe('under_provisioned');
    expect(flagWrites[0]!.last_scan_status).toBe('not_candidate');
    expect(typeof flagWrites[0]!.last_scan_at).toBe('string');
  });

  it('skips the flag write when the tracker has not seen the scope yet', async () => {
    const { result, flagWrites } = await runAnalyze({});
    expect(result.outputs.status).toBe('created');
    expect(flagWrites).toHaveLength(0);
  });

  it('custom scopes are auto-applyable too (capabilities patch) — item AND suggestion', async () => {
    const { suggestions } = await runAnalyze({});
    // sanity: default fixture (web_pool_k8s-less row) still suggests
    expect(suggestions).toHaveLength(1);
    const customScope = { ...SCOPES[0]!, scope_type: 'custom' };
    const created2: Record<string, unknown>[] = [];
    let suggestions2 = 0;
    await runWorkflowE2E({
      yamlPath: resolve(DIR, FILES.analyze),
      inputs: { scope: customScope },
      pluginStubs: {
        manual: passthroughTrigger,
        'np-agent-command': {
          handler: () =>
            ok({ status: 'success', stdout: RANGE_STDOUT(true), stderr: '', exitCode: 0 }),
          executeMode: 'all' as const,
        },
        'np-api-call': {
          handler: (ctx: { stepId: string }) =>
            ctx.stepId === 'fetch_tracker' || ctx.stepId === 'get_flag_inst'
              ? ok({ status: 404, body: null })
              : ok({ status: 200, body: { id: 111, dimensions: { environment: 'development' } } }),
          executeMode: 'all' as const,
        },
        'claude-code-agent': {
          handler: () =>
            ok({
              genuine: true,
              reason: '- ok',
              recommended_cpu_request_mc: 200,
              recommended_mem_request_mb: 256,
              recommended_mode: 'apply-only',
              confidence: 0.9,
              estimated_savings_usd_month: 5,
              risk_level: 'low',
            }),
          executeMode: 'all' as const,
        },
        'np-action-item-find': {
          handler: () => ok({ count: 0, items: [], firstMatch: null }),
          executeMode: 'all' as const,
        },
        'np-action-item-create': {
          handler: (ctx: { inputs: Record<string, unknown> }) => {
            created2.push(ctx.inputs);
            return ok({ actionItemId: 'ai_c', slug: 'rs-c', status: 'open', actionItem: {} });
          },
          executeMode: 'all' as const,
        },
        'np-action-item-suggestion-create': {
          handler: () => {
            suggestions2++;
            return ok({ suggestionId: 'sug_x', suggestion: {} });
          },
          executeMode: 'all' as const,
        },
        'np-action-item-update': { handler: () => ok({}), executeMode: 'all' as const },
      },
    });
    expect(created2).toHaveLength(1); // the opportunity IS reported
    // Auto-apply v2: `custom` scopes patch capabilities.cpu_millicores /
    // ram_memory (verified PATCH shape), so they get the one-click apply
    // like web_pool_k8s. Only non-applyable types (EC2 web_pool,
    // serverless) stay report-only.
    expect(suggestions2).toBe(1);
  });

  // ── tracker-data prefilter ──────────────────────────────────────────────

  const healthyTracker = (days: number) => ({
    daily_series: Array.from({ length: days }, (_, i) => ({
      d: `2026-07-${String(8 + i).padStart(2, '0')}`,
      // 80% utilization on both dims — clearly above the 66.7% threshold
      cpu_mc_h: 0.8 * 200 * 24,
      cpu_req_mc: 200,
      mem_mb_h: 0.8 * 512 * 24,
      mem_req_mb: 512,
      cost: 0.1,
    })),
  });

  it('prefilter skips a healthy scope without touching Prometheus', async () => {
    const { result, agentRan } = await runAnalyze({ tracker: healthyTracker(7) });
    expect(result.outputs.status).toBe('prefiltered');
    expect(agentRan).toBe(false);
  });

  it('live item + healthy tracker → closes it cheaply (no Prometheus, no AI)', async () => {
    const { result, updates, flagWrites, agentRan } = await runAnalyze({
      tracker: { ...healthyTracker(7), provisioning_status: 'over_provisioned' },
      instance: { provisioning_status: 'over_provisioned', rightsizing_item_id: 'ai_old' },
      found: { count: 1, items: [], firstMatch: { id: 'ai_old', metadata: {} } },
    });
    expect(result.outputs.status).toBe('closed_stale');
    expect(result.outputs.action_item_id).toBe('ai_old');
    expect(agentRan).toBe(false);
    expect(updates).toHaveLength(1);
    expect(String(updates[0]!.reason)).toContain('cost tracker 7-day average');
    expect(flagWrites).toHaveLength(1);
    expect(flagWrites[0]!.provisioning_status).toBe('optimal');
    expect(flagWrites[0]!.rightsizing_item_id).toBeNull();
    expect(flagWrites[0]!.last_scan_status).toBe('closed_stale');
  });

  it('live item still backed by the data → kept as-is, no AI spend', async () => {
    const unhealthy = {
      daily_series: Array.from({ length: 7 }, (_, i) => ({
        d: `2026-07-${String(8 + i).padStart(2, '0')}`,
        // 20% utilization — the over-provisioning is still there
        cpu_mc_h: 0.2 * 200 * 24,
        cpu_req_mc: 200,
        mem_mb_h: 0.2 * 512 * 24,
        mem_req_mb: 512,
      })),
    };
    const { result, updates, agentRan, flagWrites } = await runAnalyze({
      tracker: unhealthy,
      instance: { provisioning_status: 'over_provisioned', rightsizing_item_id: null },
      found: { count: 1, items: [], firstMatch: { id: 'ai_live', metadata: {} } },
    });
    expect(result.outputs.status).toBe('active_valid');
    expect(result.outputs.action_item_id).toBe('ai_live');
    expect(agentRan).toBe(false);
    expect(updates).toHaveLength(0);
    // heals the catalog pointer (items created before the flag-sync existed)
    expect(flagWrites).toHaveLength(1);
    expect(flagWrites[0]!.rightsizing_item_id).toBe('ai_live');
    expect(flagWrites[0]!.provisioning_status).toBe('over_provisioned');
    expect(flagWrites[0]!.last_scan_status).toBe('active_valid');
  });

  it('rescan window: a fresh conclusive scan skips the re-analysis', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
    const { result, agentRan } = await runAnalyze({
      // NOT healthy (would analyze on the health rule) — the recent scan wins.
      tracker: {
        daily_series: [],
        last_scan_at: twoDaysAgo,
        last_scan_status: 'not_genuine',
      },
    });
    expect(result.outputs.status).toBe('prefiltered');
    expect(agentRan).toBe(false);
  });

  it('rescan window: an expired scan analyzes again', async () => {
    const twentyDaysAgo = new Date(Date.now() - 20 * 86400000).toISOString();
    const { result } = await runAnalyze({
      tracker: {
        daily_series: [],
        last_scan_at: twentyDaysAgo,
        last_scan_status: 'not_genuine',
      },
    });
    // stale stamp + no usable history → full analysis → created
    expect(result.outputs.status).toBe('created');
  });

  it('force=true bypasses the prefilter', async () => {
    const { result } = await runAnalyze({ tracker: healthyTracker(7), force: true });
    expect(result.outputs.status).toBe('created');
  });

  it('insufficient tracker history analyzes fully', async () => {
    const { result } = await runAnalyze({ tracker: healthyTracker(2) });
    expect(result.outputs.status).toBe('created');
  });

  // ── peak-based sizing + descale detection ───────────────────────────────

  const PEAKY_STDOUT = JSON.stringify({
    mode: 'range',
    days: 14,
    step: 3600,
    points: [{ t: 1, cpu_mc: 100, cpu_req_mc: 1000, mem_mb: 200, mem_req_mb: 250 }],
    summary: {
      cpu: {
        avg_usage_mc: 100,
        avg_request_mc: 1000,
        request_now_mc: 1000,
        p95_usage_mc: 150,
        p95_10m_mc: 800,
        peak10m_mc: 900,
      },
      mem: {
        avg_usage_mb: 200,
        avg_request_mb: 250,
        request_now_mb: 250,
        p95_usage_mb: 220,
        peak_mb: 240,
      },
    },
    per_pod: {
      pod_count_avg: 3,
      pod_count_min: 3,
      pod_count_max: 3,
      cpu: { avg_mc: 33, p95_mc: 50, hot_avg_mc: 40, hot_p95_mc: 60, hot_peak10m_mc: 300 },
      mem: { avg_mb: 66, p95_mb: 80, hot_avg_mb: 70, hot_p95_mb: 85, hot_peak_mb: 90 },
    },
  });

  it('basis avg (default): a spiky scope still looks over-provisioned on averages', async () => {
    const { result, agentRan } = await runAnalyze({ stdout: PEAKY_STDOUT });
    // avg-based rec ≈ 200mc vs request 1000 → candidate → AI confirms
    expect(agentRan).toBe(true);
    expect(result.outputs.status).toBe('created');
  });

  it('basis peak10m: the peaks must fit the ceiling — the same scope is NOT a candidate', async () => {
    const { result, agentRan } = await runAnalyze({
      stdout: PEAKY_STDOUT,
      // 900mc peak / 70% ceiling → needs ≥1286mc > the 1000mc configured:
      // nothing to reclaim once peaks count.
      targetUtilByEnv: '{"default":{"cpu":70,"mem":85,"basis":"peak10m"}}',
    });
    expect(agentRan).toBe(false);
    expect(result.outputs.status).toBe('not_candidate');
  });

  it('flat replicas + varying load land in the item metadata (descale finding)', async () => {
    // peak 900 vs avg 100 = 9× while pods stayed at 3 the whole window.
    const { created } = await runAnalyze({ stdout: PEAKY_STDOUT });
    const meta = created[0]!.observed_metadata as Record<string, unknown>;
    expect(meta.flat_replicas).toBe(true);
    // per-pod: hottest-pod peak 300 / hottest-pod avg 40
    expect(meta.peak_to_avg_ratio).toBe(7.5);
    expect(meta.cpu_peak10m_mc).toBe(900);
    expect(meta.mem_peak_mb).toBe(240);
    expect(meta.sizing_basis).toBe('avg/avg');
    // the closer's change-detection baseline — PER POD (fleet 1000/250 ÷ 3)
    expect(meta.observed_cpu_request_mc).toBeCloseTo(333.33, 1);
    expect(meta.observed_mem_request_mb).toBeCloseTo(83.33, 1);
    expect(meta.pods_avg).toBe(3);
  });

  // ── p95 vs peak basis (deployment bursts) ───────────────────────────────

  const DEPLOY_SPIKE_STDOUT = JSON.stringify({
    mode: 'range',
    days: 14,
    step: 3600,
    points: [{ t: 1, cpu_mc: 100, cpu_req_mc: 1000, mem_mb: 200, mem_req_mb: 250 }],
    summary: {
      cpu: {
        avg_usage_mc: 100,
        avg_request_mc: 1000,
        request_now_mc: 1000,
        p95_usage_mc: 150,
        // steady p95 is low; the absolute peak is a 10-minute deployment burst
        p95_10m_mc: 200,
        peak10m_mc: 900,
      },
      mem: {
        avg_usage_mb: 200,
        avg_request_mb: 250,
        request_now_mb: 250,
        p95_usage_mb: 220,
        peak_mb: 240,
      },
    },
    per_pod: { pod_count_avg: 2, pod_count_min: 2, pod_count_max: 2 },
  });

  it('cpu basis peak10m: a deployment burst kills the candidate (the bug)', async () => {
    const { result, agentRan } = await runAnalyze({
      stdout: DEPLOY_SPIKE_STDOUT,
      targetUtilByEnv: '{"default":{"cpu":70,"mem":85,"basis":"peak10m"}}',
    });
    // 900mc burst / 70% → needs ≥1286mc > the 1000mc configured.
    expect(agentRan).toBe(false);
    expect(result.outputs.status).toBe('not_candidate');
  });

  it('cpu basis p95_10m: the burst is throttling, not capacity — candidate survives', async () => {
    const { result, agentRan } = await runAnalyze({
      stdout: DEPLOY_SPIKE_STDOUT,
      targetUtilByEnv:
        '{"default":{"cpu":70,"mem":85,"cpu_basis":"p95_10m","mem_basis":"peak10m"}}',
    });
    // p95 200mc / 70% → ~300mc vs 1000mc configured → real opportunity.
    expect(agentRan).toBe(true);
    expect(result.outputs.status).toBe('created');
  });

  it('per-env floors: lower non-prod floors unlock tiny idle scopes', async () => {
    const tiny = JSON.stringify({
      mode: 'range',
      days: 14,
      step: 3600,
      points: [{ t: 1, cpu_mc: 5, cpu_req_mc: 100, mem_mb: 20, mem_req_mb: 128 }],
      summary: {
        cpu: { avg_usage_mc: 5, avg_request_mc: 100, request_now_mc: 100, p95_usage_mc: 10 },
        mem: { avg_usage_mb: 20, avg_request_mb: 128, request_now_mb: 128, p95_usage_mb: 25 },
      },
    });
    // Classic 100/128 floors: already at the floor → nothing to reclaim.
    const a = await runAnalyze({ stdout: tiny });
    expect(a.result.outputs.status).toBe('not_candidate');
    // 50/64 floors: half the request becomes reclaimable.
    const b = await runAnalyze({
      stdout: tiny,
      floorsByEnv: '{"default":{"cpu":50,"mem":64}}',
    });
    expect(b.result.outputs.status).toBe('created');
  });

  it('varying replicas (autoscaling working) do not raise the descale finding', async () => {
    const scaling = JSON.parse(PEAKY_STDOUT) as {
      per_pod: { pod_count_min: number; pod_count_max: number };
    };
    scaling.per_pod.pod_count_min = 2;
    scaling.per_pod.pod_count_max = 8;
    const { created } = await runAnalyze({ stdout: JSON.stringify(scaling) });
    const meta = created[0]!.observed_metadata as Record<string, unknown>;
    expect(meta.flat_replicas).toBe(false);
  });
});

// ── wf6 cluster cost calibration ────────────────────────────────────────

const COSTING_STDOUT = JSON.stringify({
  month: '2026-06',
  monthly_compute_cost: 2162,
  nodes: 16,
  vcpu_total: 64,
  gb_total: 176,
  price_per_millicore_hour: 0.0000335,
  price_per_mb_ram_hour: 0.00000455,
  method: 'CE AmortizedCost EC2-Compute / prometheus fleet, ratio 7.2',
});

async function runCalibration(opts: { stdout?: string; curCpu?: string }) {
  const writes: { stepId: string; body: Record<string, unknown> }[] = [];
  const result = await runWorkflowE2E({
    yamlPath: resolve(DIR, FILES.calibration),
    inputs: {},
    pluginStubs: {
      manual: passthroughTrigger,
      cron: passthroughTrigger,
      'np-agent-command': {
        handler: () =>
          ok({ status: 'success', stdout: opts.stdout ?? COSTING_STDOUT, stderr: '', exitCode: 0 }),
        executeMode: 'all' as const,
      },
      'np-api-call': {
        handler: (ctx: { stepId: string; inputs: Record<string, unknown> }) => {
          writes.push({ stepId: ctx.stepId, body: {} });
          return ok({ status: 200, body: {} });
        },
        executeMode: 'all' as const,
      },
    },
  });
  return { result, writes };
}

describe('wf6-cluster-cost-calibration (E2E)', () => {
  it('derives prices and writes entries + account metadata', async () => {
    const { result, writes } = await runCalibration({});
    expect(result.outputs.status).toBe('applied');
    expect(writes.map((w) => w.stepId)).toEqual([
      'write_cpu_price',
      'write_mem_price',
      'write_metadata',
    ]);
  });

  it('invalid costing data is reported, never applied', async () => {
    const { result, writes } = await runCalibration({
      stdout: JSON.stringify({ price_per_millicore_hour: 0, price_per_mb_ram_hour: 0 }),
    });
    expect(result.outputs.status).toBe('invalid_data');
    expect(writes).toHaveLength(0);
  });
});

// ── wf3 events router ───────────────────────────────────────────────────

const TRIGGER_OUTPUT_PORTS = [
  { name: 'onCreated' },
  { name: 'onUpdated' },
  { name: 'onResolved' },
  { name: 'onCommentAdded' },
  { name: 'onSuggestionCreated' },
  { name: 'onSuggestionAccepted' },
  { name: 'onSuggestionRejected' },
  { name: 'onSuggestionUpdated' },
  { name: 'onDeleted' },
  { name: 'onDeferred' },
  { name: 'onRejected' },
  { name: 'onClosed' },
  { name: 'onReopened' },
  { name: 'default' },
] as const;

async function runEvents(port: string, opts?: { signalStatus?: number; userEmail?: string }) {
  const started: Record<string, unknown>[] = [];
  const signals: Record<string, unknown>[] = [];
  const result = await runWorkflowE2E({
    yamlPath: resolve(DIR, FILES.events),
    inputs: {
      _activePort: port,
      actionItem: { id: 'ai-42', nrn: 'organization=1', status: 'open' },
      suggestion: { id: 'sug-7' },
      userEmail: opts?.userEmail ?? 'dev@demo.org',
    },
    pluginStubs: {
      'np-action-item-trigger': {
        handler: () => ok({}),
        registryType: 'trigger' as const,
        outputPorts: TRIGGER_OUTPUT_PORTS,
      },
      'sub-workflow': {
        handler: (ctx: { inputs: Record<string, unknown> }) => {
          started.push(ctx.inputs);
          return ok({ _childExecutionId: 'child-1' });
        },
        executeMode: 'all' as const,
      },
      'np-api-call': {
        handler: (ctx: { inputs: Record<string, unknown> }) => {
          signals.push(ctx.inputs);
          return ok({ status: opts?.signalStatus ?? 200, body: { delivered: true } });
        },
        executeMode: 'all' as const,
      },
    },
  });
  return { result, started, signals };
}

describe('wf3-right-sizing-events (E2E)', () => {
  it('starts the apply workflow on suggestion accept', async () => {
    const { started, signals } = await runEvents('onSuggestionAccepted');
    expect(started).toHaveLength(1);
    expect(started[0]!.action_item_id).toBe('ai-42');
    expect(started[0]!.suggestion_id).toBe('sug-7');
    expect(signals).toHaveLength(0);
  });

  it('forwards comments as rightsizing-command signals keyed by item', async () => {
    const { started, signals } = await runEvents('onCommentAdded');
    expect(started).toHaveLength(0);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.correlation).toBe('ai-42');
  });

  it('an unclaimed human comment (signal 409) routes to the Q&A workflow', async () => {
    const { started } = await runEvents('onCommentAdded', { signalStatus: 409 });
    expect(started).toHaveLength(1);
    expect(started[0]!.action_item_id).toBe('ai-42');
    expect(started[0]!.author).toBe('dev@demo.org');
  });

  it('a claimed comment (signal 200 → apply consumed it) never reaches the Q&A', async () => {
    const { started } = await runEvents('onCommentAdded', { signalStatus: 200 });
    expect(started).toHaveLength(0);
  });

  it('agent comments never route to the Q&A (no bot-to-bot loops)', async () => {
    const { started } = await runEvents('onCommentAdded', {
      signalStatus: 409,
      userEmail: 'agent:progressive-deploy',
    });
    expect(started).toHaveLength(0);
  });
});

// ── wf7b closer verification ────────────────────────────────────────────

/** Daily series helper: `pre` days at the baseline PER-POD request, `post`
 * days at the changed per-pod request with the given utilization fraction.
 * Fleet totals = per-pod × pods (change detection must work on per-pod:
 * requests are config; fleet totals move with autoscaling). */
function verifySeries(opts: {
  pre: number;
  post: number;
  postUtil?: number;
  postCpuReqPerPod?: number;
  postMemReqPerPod?: number;
  prePods?: number;
  postPods?: number;
}) {
  const series: Record<string, unknown>[] = [];
  const prePods = opts.prePods ?? 2;
  for (let i = 0; i < opts.pre; i++) {
    series.push({
      d: `2026-07-${String(1 + i).padStart(2, '0')}`,
      cpu_mc_h: 0.2 * 200 * prePods * 24,
      cpu_req_mc: 200 * prePods,
      mem_mb_h: 0.2 * 256 * prePods * 24,
      mem_req_mb: 256 * prePods,
      pods_avg: prePods,
    });
  }
  const util = opts.postUtil ?? 0.5;
  const cpuPP = opts.postCpuReqPerPod ?? 100;
  const memPP = opts.postMemReqPerPod ?? 128;
  const postPods = opts.postPods ?? 2;
  for (let i = 0; i < opts.post; i++) {
    series.push({
      d: `2026-07-${String(10 + i).padStart(2, '0')}`,
      cpu_mc_h: util * cpuPP * postPods * 24,
      cpu_req_mc: cpuPP * postPods,
      mem_mb_h: util * memPP * postPods * 24,
      mem_req_mb: memPP * postPods,
      pods_avg: postPods,
    });
  }
  return series;
}

async function runVerify(opts: {
  tracker?: Record<string, unknown> | null;
  itemStatus?: number;
  item?: Record<string, unknown>;
}) {
  const comments: Record<string, unknown>[] = [];
  const closes: Record<string, unknown>[] = [];
  const flagWrites: Record<string, unknown>[] = [];
  const result = await runWorkflowE2E({
    yamlPath: resolve(DIR, FILES.verify),
    inputs: { scope: SCOPES[0] },
    pluginStubs: {
      manual: passthroughTrigger,
      'np-api-call': {
        handler: (ctx: { stepId: string; inputs: Record<string, unknown> }) => {
          if (ctx.stepId === 'fetch_tracker') {
            return opts.tracker
              ? ok({ status: 200, body: opts.tracker })
              : ok({ status: 404, body: null });
          }
          if (ctx.stepId === 'fetch_item') {
            return ok({
              status: opts.itemStatus ?? 200,
              body:
                (opts.itemStatus ?? 200) === 200
                  ? (opts.item ?? {
                      id: 'ai_9',
                      status: 'open',
                      metadata: {
                        observed_cpu_request_mc: 400,
                        observed_mem_request_mb: 512,
                        environment: 'development',
                      },
                    })
                  : null,
            });
          }
          if (ctx.stepId === 'put_flag') {
            flagWrites.push(ctx.inputs.payload as Record<string, unknown>);
            return ok({ status: 200, body: {} });
          }
          throw new Error(`unexpected np-api-call step: ${ctx.stepId}`);
        },
        executeMode: 'all' as const,
      },
      'np-action-item-add-comment': {
        handler: (ctx: { inputs: Record<string, unknown> }) => {
          comments.push(ctx.inputs);
          return ok({ commentId: 'c1', comment: {} });
        },
        executeMode: 'all' as const,
      },
      'np-action-item-update': {
        handler: (ctx: { inputs: Record<string, unknown> }) => {
          closes.push(ctx.inputs);
          return ok({ actionItem: {} });
        },
        executeMode: 'all' as const,
      },
    },
  });
  return { result, comments, closes, flagWrites };
}

describe('wf7b-rightsizing-verify-scope (closer, E2E)', () => {
  const trackerWith = (series: Record<string, unknown>[]) => ({
    rightsizing_item_id: 'ai_9',
    provisioning_status: 'over_provisioned',
    daily_series: series,
  });

  it('verified: applied change + healthy utilization → comment, close, flag optimal', async () => {
    const { result, comments, closes, flagWrites } = await runVerify({
      tracker: trackerWith(verifySeries({ pre: 3, post: 4, postUtil: 0.5 })),
    });
    expect(result.outputs.status).toBe('verified');
    // realized: (400-200)mc + (512-256)MB monthly at the configured prices
    expect(result.outputs.realized_savings_usd_month).toBeCloseTo(
      200 * 0.000011 * 730 + 256 * 0.0000048 * 730,
      2,
    );
    expect(comments).toHaveLength(1);
    expect(String(comments[0]!.text)).toContain('runs healthy');
    expect(closes).toHaveLength(1);
    expect(String(closes[0]!.reason)).toContain('verified healthy');
    expect(flagWrites).toHaveLength(1);
    expect(flagWrites[0]!.provisioning_status).toBe('optimal');
    expect(flagWrites[0]!.rightsizing_item_id).toBeNull();
  });

  it('regression: applied change but the scope runs hot → warning close, flag under_provisioned', async () => {
    const { result, comments, flagWrites } = await runVerify({
      tracker: trackerWith(verifySeries({ pre: 3, post: 4, postUtil: 0.95 })),
    });
    expect(result.outputs.status).toBe('verified_warning');
    expect(String(comments[0]!.text)).toContain('HOT');
    expect(flagWrites[0]!.provisioning_status).toBe('under_provisioned');
  });

  it('awaiting_data: fewer than 3 post-change days → silent, next run rechecks', async () => {
    const { result, comments, closes } = await runVerify({
      tracker: trackerWith(verifySeries({ pre: 5, post: 2 })),
    });
    expect(result.outputs.status).toBe('awaiting_data');
    expect(comments).toHaveLength(0);
    expect(closes).toHaveLength(0);
  });

  it('unchanged: nobody touched the requests → nothing to do', async () => {
    const { result, comments, closes, flagWrites } = await runVerify({
      tracker: trackerWith(verifySeries({ pre: 7, post: 0 })),
    });
    expect(result.outputs.status).toBe('unchanged');
    expect(comments).toHaveLength(0);
    expect(closes).toHaveLength(0);
    expect(flagWrites).toHaveLength(0);
  });

  it('autoscaling scale-up is NOT a change: fleet requests move, per-pod stays', async () => {
    // Regression (live 2026-07-19): 2 pods → 5 pods at the same per-pod
    // request looked like "1024MB → 1280MB" on fleet totals and the closer
    // wrongly verified+closed 3 items. Per-pod comparison must say unchanged.
    const { result, comments, closes } = await runVerify({
      tracker: trackerWith(
        verifySeries({
          pre: 3,
          post: 4,
          postCpuReqPerPod: 200,
          postMemReqPerPod: 256,
          postPods: 5,
        }),
      ),
    });
    expect(result.outputs.status).toBe('unchanged');
    expect(comments).toHaveLength(0);
    expect(closes).toHaveLength(0);
  });

  it('stale pointer: the item is already closed → clean the flag, no comment', async () => {
    const { result, comments, closes, flagWrites } = await runVerify({
      tracker: trackerWith(verifySeries({ pre: 3, post: 4 })),
      item: { id: 'ai_9', status: 'closed', metadata: {} },
    });
    expect(result.outputs.status).toBe('stale_pointer');
    expect(comments).toHaveLength(0);
    expect(closes).toHaveLength(0);
    expect(flagWrites).toHaveLength(1);
    expect(flagWrites[0]!.provisioning_status).toBe('unknown');
    expect(flagWrites[0]!.rightsizing_item_id).toBeNull();
  });

  it('no item pointer on the tracker → no_item, zero API churn', async () => {
    const { result, comments, closes, flagWrites } = await runVerify({
      tracker: { daily_series: [], rightsizing_item_id: null },
    });
    expect(result.outputs.status).toBe('no_item');
    expect(comments).toHaveLength(0);
    expect(closes).toHaveLength(0);
    expect(flagWrites).toHaveLength(0);
  });
});

// ── wf8 Q&A responder ───────────────────────────────────────────────────

async function runQa(opts: {
  author?: string;
  comments?: { author: string; content: string }[];
  itemStatus?: string;
  shouldReply?: boolean;
}) {
  const posted: Record<string, unknown>[] = [];
  let agentRan = false;
  const result = await runWorkflowE2E({
    yamlPath: resolve(DIR, FILES.qa),
    inputs: { action_item_id: 'ai-42', author: opts.author ?? 'dev@demo.org' },
    pluginStubs: {
      manual: passthroughTrigger,
      'np-api-call': {
        handler: (ctx: { stepId: string }) => {
          if (ctx.stepId === 'fetch_item') {
            return ok({
              status: 200,
              body: {
                id: 'ai-42',
                status: opts.itemStatus ?? 'open',
                title: 'Right-sizing: API Prod',
                description: 'analysis…',
                metadata: { matchers: 'namespace="nullplatform",pod=~"(d-111-|.*-111-d-).*"' },
              },
            });
          }
          if (ctx.stepId === 'fetch_comments') {
            return ok({
              status: 200,
              body: {
                results: opts.comments ?? [
                  { author: 'dev@demo.org', content: 'why is 200mc enough at peak?' },
                ],
              },
            });
          }
          throw new Error(`unexpected np-api-call step: ${ctx.stepId}`);
        },
        executeMode: 'all' as const,
      },
      'claude-code-agent': {
        handler: () => {
          agentRan = true;
          return ok({
            should_reply: opts.shouldReply !== false,
            reply: 'Peak 10m was **300mc per pod**; the 200mc request keeps 20% headroom over p95.',
          });
        },
        executeMode: 'all' as const,
      },
      'np-action-item-add-comment': {
        handler: (ctx: { inputs: Record<string, unknown> }) => {
          posted.push(ctx.inputs);
          return ok({ commentId: 'c9', comment: {} });
        },
        executeMode: 'all' as const,
      },
    },
  });
  return { result, posted, agentRan };
}

describe('wf8-rightsizing-qa (E2E)', () => {
  it('answers a human question on the thread (immediate ack, then the answer)', async () => {
    const { result, posted, agentRan } = await runQa({});
    expect(agentRan).toBe(true);
    // The ack posts BEFORE the AI runs (humans see "on it" instead of
    // minutes of silence); the grounded answer follows.
    expect(posted).toHaveLength(2);
    expect(String(posted[1]!.text)).toContain('300mc');
    expect(result.outputs.status).toBe('replied');
  });

  it('never replies to agent/executor authors (no bot-to-bot loops)', async () => {
    const { posted, agentRan, result } = await runQa({ author: 'agent:rightsizing-closer' });
    expect(agentRan).toBe(false);
    expect(posted).toHaveLength(0);
    expect(result.outputs.status).toBe('skipped');
  });

  it('skips when the last comment is already from an agent (race with our own reply)', async () => {
    const { agentRan, posted } = await runQa({
      comments: [
        { author: 'dev@demo.org', content: 'why?' },
        { author: 'agent:rightsizing-qa', content: 'because…' },
      ],
    });
    expect(agentRan).toBe(false);
    expect(posted).toHaveLength(0);
  });

  it('enforces the per-item reply cap', async () => {
    const thread = Array.from({ length: 10 }, () => ({
      author: 'agent:rightsizing-qa',
      content: 'answer',
    }));
    thread.push({ author: 'dev@demo.org', content: 'one more question' });
    const { agentRan, posted } = await runQa({ comments: thread });
    expect(agentRan).toBe(false);
    expect(posted).toHaveLength(0);
  });

  it('skips closed items', async () => {
    const { agentRan, posted } = await runQa({ itemStatus: 'closed' });
    expect(agentRan).toBe(false);
    expect(posted).toHaveLength(0);
  });

  it('acks but posts no ANSWER when the AI declines (chatter, commands)', async () => {
    const { result, posted, agentRan } = await runQa({ shouldReply: false });
    expect(agentRan).toBe(true);
    // Only the immediate ack — the guards that never ack (bot authors,
    // closed items, reply cap) are covered by the tests above.
    expect(posted).toHaveLength(1);
    expect(result.outputs.status).toBe('no_reply');
  });
});

// ── wf4 apply ───────────────────────────────────────────────────────────

interface ApplyStubOpts {
  mode: 'apply-only' | 'nocturnal-deploy';
  /** Outcome the stubbed progressive-deploy sub-workflow (wf5) reports. */
  progressiveOutcome?: Record<string, unknown>;
  /** HTTP status the scope PATCH returns (default 200). */
  patchStatus?: number;
  /** Overrides the scope's requested_spec (e.g. the profile shape). */
  profileSpec?: Record<string, unknown>;
  /** Simulates the user's accept-form answer (suggestion user_metadata). */
  userTiming?: string;
  /** Simulates the workflow-input override (manual smoke runs). */
  inputTiming?: string;
}

async function runApply(opts: ApplyStubOpts) {
  const patches: { stepId: string; payload: Record<string, unknown> }[] = [];
  const comments: string[] = [];
  const suggestionUpdates: string[] = [];
  const itemUpdates: string[] = [];
  const result = await runWorkflowE2E({
    yamlPath: resolve(DIR, FILES.apply),
    inputs: {
      action_item_id: 'ai-42',
      suggestion_id: 'sug-7',
      ...(opts.inputTiming !== undefined ? { deploy_timing: opts.inputTiming } : {}),
    },
    pluginStubs: {
      manual: passthroughTrigger,
      'np-action-item-get': {
        handler: () =>
          ok({
            actionItem: {
              id: 'ai-42',
              status: 'open',
              metadata: { scope_id: '777', scope_name: 'API Prod' },
            },
          }),
        executeMode: 'all' as const,
      },
      'np-api-call': {
        handler: (ctx: { stepId: string; inputs: Record<string, unknown> }) => {
          switch (ctx.stepId) {
            case 'fetch_suggestion':
              return ok({
                status: 200,
                body: {
                  id: 'sug-7',
                  metadata: {
                    mode: opts.mode,
                    recommended_cpu_request_mc: 200,
                    recommended_mem_request_mb: 256,
                  },
                  ...(opts.userTiming !== undefined
                    ? { user_metadata: { deploy_timing: opts.userTiming } }
                    : {}),
                },
              });
            case 'fetch_scope':
              return ok({
                status: 200,
                body: {
                  id: 777,
                  requested_spec: opts.profileSpec ?? {
                    resources: { cpu_millicores: 1000, memory_in_mb: 2048 },
                  },
                },
              });
            case 'patch_scope_only':
            case 'patch_scope_deploy':
              patches.push({
                stepId: ctx.stepId,
                payload: ctx.inputs.payload as Record<string, unknown>,
              });
              return ok({
                status: opts.patchStatus ?? 200,
                body:
                  opts.patchStatus && opts.patchStatus >= 400
                    ? { message: 'Blocked by approval policy' }
                    : {},
              });
            case 'fetch_comments':
              return ok({ status: 200, body: { results: [] } });
            default:
              throw new Error(`unexpected np-api-call step: ${ctx.stepId}`);
          }
        },
        executeMode: 'all' as const,
      },
      'sub-workflow': {
        handler: () =>
          ok(
            (opts.progressiveOutcome ?? {
              status: 'deployed',
              deployment_id: '9001',
              detail: 'finalized',
            }) as Record<string, unknown>,
          ),
        executeMode: 'all' as const,
      },
      'np-action-item-add-comment': {
        handler: (ctx: { stepId: string }) => {
          comments.push(ctx.stepId);
          return ok({ commentId: 'c1', comment: {} });
        },
        executeMode: 'all' as const,
      },
      'np-action-item-suggestion-update': {
        handler: (ctx: { stepId: string }) => {
          suggestionUpdates.push(ctx.stepId);
          return ok({ suggestion: {}, status: 'ok' });
        },
        executeMode: 'all' as const,
      },
      'np-action-item-update': {
        handler: (ctx: { stepId: string }) => {
          itemUpdates.push(ctx.stepId);
          return ok({ actionItem: {} });
        },
        executeMode: 'all' as const,
      },
      'signal-wait': {
        // The window arrives (timeout with onTimeout: continue).
        handler: () => ok({ timedOut: true, payload: null }),
        executeMode: 'all' as const,
      },
      delay: {
        handler: () => ok({ elapsed: 0 }),
        executeMode: 'all' as const,
      },
    },
  });
  return { result, patches, comments, suggestionUpdates, itemUpdates };
}

describe('wf4-apply-rightsizing (E2E)', () => {
  it('apply-only: patches the spec, marks applied, item stays OPEN', async () => {
    const { result, patches, suggestionUpdates, itemUpdates } = await runApply({
      mode: 'apply-only',
    });
    expect(patches).toHaveLength(1);
    expect(patches[0]!.stepId).toBe('patch_scope_only');
    // compute_plan wraps the cloned spec: PATCH body = { requested_spec }.
    const resources = (
      patches[0]!.payload as { requested_spec: { resources: Record<string, number> } }
    ).requested_spec.resources;
    expect(resources.cpu_millicores).toBe(200);
    expect(resources.memory_in_mb).toBe(256);
    expect(suggestionUpdates).toEqual(['mark_applied_only']);
    // The close step must NOT run in apply-only mode.
    expect(itemUpdates).toHaveLength(0);
    expect(result.outputs.status).toBe('applied-no-deploy');
    expect(result.outputs.deployment_id).toBeNull();
  });

  it('nocturnal: deploys on window, marks applied and CLOSES the item', async () => {
    const { result, patches, suggestionUpdates, itemUpdates, comments } = await runApply({
      mode: 'nocturnal-deploy',
    });
    expect(patches).toHaveLength(1);
    expect(patches[0]!.stepId).toBe('patch_scope_deploy');
    expect(suggestionUpdates).toEqual(['mark_applied_deploy']);
    expect(itemUpdates).toEqual(['close_item']);
    expect(comments).toContain('comment_scheduled');
    expect(comments).toContain('comment_deploying');
    expect(comments).toContain('comment_success');
    expect(result.outputs.status).toBe('deployed');
    expect(result.outputs.deployment_id).toBe('9001');
  });

  it('nocturnal: rolled-back progressive deploy marks the suggestion failed, item stays open', async () => {
    const { result, suggestionUpdates, itemUpdates } = await runApply({
      mode: 'nocturnal-deploy',
      progressiveOutcome: { status: 'rolled_back', deployment_id: '9001', detail: 'degraded' },
    });
    expect(suggestionUpdates).toEqual(['mark_failed']);
    expect(itemUpdates).toHaveLength(0);
    expect(result.outputs.status).toBe('deploy-failed');
  });

  it('apply-only: a blocked scope PATCH is narrated and marks the suggestion failed', async () => {
    const { result, comments, suggestionUpdates, itemUpdates } = await runApply({
      mode: 'apply-only',
      patchStatus: 403,
    });
    expect(comments).toContain('comment_patch_blocked_only');
    expect(suggestionUpdates).toEqual(['mark_failed_only']);
    expect(itemUpdates).toHaveLength(0);
    expect(result.outputs.status).toBe('blocked');
  });

  it('nocturnal: a blocked scope PATCH skips the deploy entirely', async () => {
    const { result, comments, suggestionUpdates } = await runApply({
      mode: 'nocturnal-deploy',
      userTiming: 'now',
      patchStatus: 403,
    });
    expect(comments).toContain('comment_patch_blocked_deploy');
    expect(suggestionUpdates).toEqual(['mark_failed']);
    expect(result.outputs.status).toBe('deploy-failed');
  });

  it('accept-form deploy_timing=now on an apply-only suggestion deploys immediately and closes', async () => {
    const { result, patches, itemUpdates } = await runApply({
      mode: 'apply-only',
      userTiming: 'now',
    });
    expect(patches).toHaveLength(1);
    expect(patches[0]!.stepId).toBe('patch_scope_deploy');
    expect(itemUpdates).toEqual(['close_item']);
    expect(result.outputs.status).toBe('deployed');
    expect(result.outputs.mode).toBe('nocturnal-deploy');
  });

  it('accept-form deploy_timing=next-deploy on a nocturnal suggestion downgrades to apply-only', async () => {
    const { result, patches, itemUpdates } = await runApply({
      mode: 'nocturnal-deploy',
      userTiming: 'next-deploy',
    });
    expect(patches).toHaveLength(1);
    expect(patches[0]!.stepId).toBe('patch_scope_only');
    expect(itemUpdates).toHaveLength(0);
    expect(result.outputs.status).toBe('applied-no-deploy');
  });

  it('workflow-input deploy_timing overrides the accept-form answer', async () => {
    const { result, patches } = await runApply({
      mode: 'apply-only',
      userTiming: 'next-deploy',
      inputTiming: 'now',
    });
    expect(patches[0]!.stepId).toBe('patch_scope_deploy');
    expect(result.outputs.status).toBe('deployed');
  });

  it('profile-shaped spec (cpu_profile + memory_in_gb): right-sizes memory to the next tier down', async () => {
    const { patches, result } = await runApply({
      mode: 'apply-only',
      profileSpec: { cpu_profile: 'standard', memory_in_gb: 1, local_storage_in_gb: 8 },
    });
    expect(patches).toHaveLength(1);
    const spec = (patches[0]!.payload as { requested_spec: Record<string, unknown> })
      .requested_spec;
    // rec 256MB → 0.25GB tier; cpu_profile untouched (CPU is profile-derived)
    expect(spec.memory_in_gb).toBe(0.25);
    expect(spec.cpu_profile).toBe('standard');
    expect(result.outputs.status).toBe('applied-no-deploy');
  });
});

// ── progressive deploy pack (workflows/deploy) ─────────────────────────

const telemetry = (value: number) => ({
  status: 200,
  body: { results: [{ dimensions: {}, data: [{ timestamp: 't', value }] }] },
});

describe('progressive-deploy (AI orchestrator loop)', () => {
  it('wait cycles re-enter the agent with a wake message; done maps the outcome', async () => {
    let calls = 0;
    const prompts: string[] = [];
    const result = await runWorkflowE2E({
      yamlPath: resolve(DIR, FILES.progressive),
      inputs: { scope_id: '777', action_item_id: 'ai-42', description: 'redeploy test' },
      pluginStubs: {
        manual: passthroughTrigger,
        'claude-code-agent': {
          handler: (ctx: { inputs: Record<string, unknown> }) => {
            calls++;
            prompts.push(String(ctx.inputs.observed_prompt ?? ''));
            return calls === 1
              ? ok({ action: 'wait', wait_seconds: 45, detail: 'soaking at 10%' })
              : ok({
                  action: 'done',
                  status: 'deployed',
                  deployment_id: '555',
                  detail: 'finalized after all steps healthy',
                });
          },
          executeMode: 'all' as const,
        },
        'signal-wait': {
          handler: () => ok({ timedOut: true, payload: null }),
          executeMode: 'all' as const,
        },
      },
    });
    expect(calls).toBe(2);
    expect(result.outputs.status).toBe('deployed');
    expect(result.outputs.deployment_id).toBe('555');
    // First turn gets the mission brief; the re-entry gets the wake note.
    expect(prompts[0]).toMatch(/progressive blue-green redeploy/i);
    expect(prompts[1]).toMatch(/waited 45 seconds/);
  });

  it('an unknown final status degrades to failed', async () => {
    const result = await runWorkflowE2E({
      yamlPath: resolve(DIR, FILES.progressive),
      inputs: { scope_id: '777', action_item_id: 'ai-42' },
      pluginStubs: {
        manual: passthroughTrigger,
        'claude-code-agent': {
          handler: () => ok({ action: 'done', status: 'party', detail: 'weird' }),
          executeMode: 'all' as const,
        },
        'signal-wait': {
          handler: () => ok({ timedOut: true, payload: null }),
          executeMode: 'all' as const,
        },
      },
    });
    expect(result.outputs.status).toBe('failed');
  });
});

describe('deploy tools', () => {
  it('deploy_start resolves the running release and interprets a policy block', async () => {
    const run = (createStatus: number) =>
      runWorkflowE2E({
        yamlPath: resolve(DIR, FILES.deployStart),
        inputs: { scope_id: '777', description: 'd' },
        pluginStubs: {
          manual: passthroughTrigger,
          'np-api-call': {
            handler: (ctx: { stepId: string }) => {
              if (ctx.stepId === 'list_deployments')
                return ok({
                  status: 200,
                  body: {
                    results: [
                      { id: 1, status: 'finalized', created_at: '2026-01-01', release_id: 900 },
                      { id: 2, status: 'finalized', created_at: '2026-03-01', release_id: 901 },
                      { id: 3, status: 'rolled_back', created_at: '2026-04-01', release_id: 902 },
                    ],
                  },
                });
              return createStatus >= 400
                ? ok({
                    status: createStatus,
                    body: { message: 'Blocked by approval policy: prod-gate' },
                  })
                : ok({ status: 200, body: { id: 555 } });
            },
            executeMode: 'all' as const,
          },
        },
      });

    const okRun = await run(200);
    expect(okRun.outputs.ok).toBe(true);
    expect(okRun.outputs.deployment_id).toBe('555');
    // Newest FINALIZED deployment wins (rolled_back ignored).
    expect(okRun.outputs.release_id).toBe(901);

    const blocked = await run(403);
    expect(blocked.outputs.ok).toBe(false);
    expect(String(blocked.outputs.blocked_reason)).toMatch(/approval\/policy\/checklist/);
  });

  it('deploy_metrics computes the degradation verdict deterministically', async () => {
    const run = (errNow: number, baselines?: Record<string, unknown>) =>
      runWorkflowE2E({
        yamlPath: resolve(DIR, FILES.deployMetrics),
        inputs: { scope_id: '777', minutes: 5, ...(baselines ?? {}) },
        pluginStubs: {
          manual: passthroughTrigger,
          'np-api-call': {
            handler: (ctx: { stepId: string }) => {
              switch (ctx.stepId) {
                case 'fetch_scope':
                  return ok({ status: 200, body: { id: 777, application_id: 42 } });
                case 'get_rpm':
                  return ok(telemetry(100));
                case 'get_err':
                  return ok(telemetry(errNow));
                case 'get_rt':
                  return ok(telemetry(120));
                default:
                  throw new Error(`unexpected step ${ctx.stepId}`);
              }
            },
            executeMode: 'all' as const,
          },
        },
      });

    // No baselines → raw snapshot, never degraded.
    const base = await run(0.5);
    expect(base.outputs.degraded).toBe(false);
    expect(base.outputs.error_rate).toBe(0.5);
    expect(base.outputs.has_data).toBe(true);

    // Error rate jumped 0.5 → 5 with max_err_increase 1 → degraded.
    const bad = await run(5, {
      baseline_err: 0.5,
      baseline_rt: 120,
      baseline_has_data: true,
      max_err_increase: 1,
      max_rt_ratio: 1.5,
    });
    expect(bad.outputs.degraded).toBe(true);
    expect((bad.outputs.problems as string[]).join(' ')).toMatch(/error rate 5%/);

    // Same jump but within threshold → healthy.
    const fine = await run(1.2, { baseline_err: 0.5, max_err_increase: 1 });
    expect(fine.outputs.degraded).toBe(false);
  });
});

// ── wf2 scanner ─────────────────────────────────────────────────────────

describe('scope-resolving collector interface (controlplane-agent compat)', () => {
  // The controlplane-agent exec validator rejects ( ) { } on the command
  // line. The 'scope' matchers template makes the script resolve the
  // null→k8s pod mapping itself, and wf2c ships PromQL base64-encoded.

  it('wf1b passes --scope instead of a matchers regex with the scope template', async () => {
    let cmdline = '';
    await runWorkflowE2E({
      yamlPath: resolve(DIR, FILES.collect),
      inputs: { scope: SCOPES[0], date: '2026-07-15', matchers_template: 'scope' },
      pluginStubs: {
        manual: passthroughTrigger,
        'np-agent-command': {
          handler: (ctx: { inputs: Record<string, unknown> }) => {
            cmdline = String(ctx.inputs.cmdline ?? '');
            return ok({ status: 'success', stdout: DAY_STDOUT, stderr: '', exitCode: 0 });
          },
          executeMode: 'all' as const,
        },
        'np-api-call': {
          handler: () => ok({ status: 404, body: null }),
          executeMode: 'all' as const,
        },
      },
    });
    expect(cmdline).toContain('--mode day');
    expect(cmdline).toContain(`--scope ${SCOPES[0]!.scope_id}`);
    expect(cmdline).not.toContain('--matchers');
    expect(cmdline).not.toMatch(/[(){}]/);
  });

  it('wf2b passes --scope with the scope template', async () => {
    let cmdline = '';
    await runWorkflowE2E({
      yamlPath: resolve(DIR, FILES.analyze),
      inputs: { scope: SCOPES[0], matchers_template: 'scope' },
      pluginStubs: {
        manual: passthroughTrigger,
        'np-agent-command': {
          handler: (ctx: { inputs: Record<string, unknown> }) => {
            cmdline = String(ctx.inputs.cmdline ?? '');
            // Below-threshold usage → workflow ends at the deterministic
            // filter; this test only cares about the command line.
            return ok({ status: 'success', stdout: RANGE_STDOUT(false), stderr: '', exitCode: 0 });
          },
          executeMode: 'all' as const,
        },
        'np-api-call': {
          handler: () => ok({ status: 200, body: { id: SCOPES[0]!.scope_id, dimensions: {} } }),
          executeMode: 'all' as const,
        },
        // Not reached (below-threshold usage) but must exist for validation.
        'claude-code-agent': { handler: () => ok({ genuine: false }), executeMode: 'all' as const },
        'np-action-item-find': {
          handler: () => ok({ count: 0, items: [], firstMatch: null }),
          executeMode: 'all' as const,
        },
        'np-action-item-create': { handler: () => ok({}), executeMode: 'all' as const },
        'np-action-item-suggestion-create': { handler: () => ok({}), executeMode: 'all' as const },
        'np-action-item-update': { handler: () => ok({}), executeMode: 'all' as const },
      },
    });
    expect(cmdline).toContain('--mode range');
    expect(cmdline).toContain(`--scope ${SCOPES[0]!.scope_id}`);
    expect(cmdline).not.toMatch(/[(){}]/);
  });

  it('wf2c ships PromQL base64-encoded (no shell metacharacters)', async () => {
    let cmdline = '';
    const promql = 'max(rate(container_cpu_usage_seconds_total{pod=~"d-1-.*"}[5m]))';
    await runWorkflowE2E({
      yamlPath: resolve(DIR, FILES.metricsTool),
      inputs: { promql, start: '-14d', step: 3600 },
      pluginStubs: {
        manual: passthroughTrigger,
        'np-agent-command': {
          handler: (ctx: { inputs: Record<string, unknown> }) => {
            cmdline = String(ctx.inputs.cmdline ?? '');
            return ok({
              status: 'success',
              stdout: JSON.stringify({ mode: 'query', result: [] }),
              stderr: '',
              exitCode: 0,
            });
          },
          executeMode: 'all' as const,
        },
      },
    });
    expect(cmdline).toContain('--promql-b64 ');
    expect(cmdline).not.toMatch(/[(){}]/);
    const b64 = /--promql-b64 (\S+)/.exec(cmdline)![1]!;
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(promql);
  });
});

interface ScannerRunOpts {
  byId: Record<string, Record<string, unknown>>;
  scopes: Record<string, unknown>[];
  /** Existing portfolio item returned by find_portfolio (absent → none). */
  portfolio?: Record<string, unknown> | null;
}

async function runScanner(opts: ScannerRunOpts) {
  const created: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const result = await runWorkflowE2E({
    yamlPath: resolve(DIR, FILES.scanner),
    inputs: {},
    pluginStubs: {
      manual: passthroughTrigger,
      cron: passthroughTrigger,
      'np-lake-query': lakeStub(opts.scopes),
      'sub-workflow': {
        handler: (ctx: { inputs: Record<string, unknown> }) => {
          const scope = ctx.inputs.scope as Record<string, unknown>;
          return ok(opts.byId[String(scope.scope_id)]!);
        },
        executeMode: 'all' as const,
      },
      'np-action-item-find': {
        handler: () =>
          ok(
            opts.portfolio
              ? { count: 1, items: [opts.portfolio], firstMatch: opts.portfolio }
              : { count: 0, items: [], firstMatch: null },
          ),
        executeMode: 'all' as const,
      },
      'np-action-item-create': {
        handler: (ctx: { inputs: Record<string, unknown> }) => {
          created.push(ctx.inputs);
          return ok({ actionItemId: 'ai_portfolio', slug: 'pf-1', status: 'open', actionItem: {} });
        },
        executeMode: 'all' as const,
      },
      'np-action-item-update': {
        handler: (ctx: { inputs: Record<string, unknown> }) => {
          updated.push(ctx.inputs);
          return ok({ actionItem: {}, status: 'open' });
        },
        executeMode: 'all' as const,
      },
    },
  });
  return { result, created, updated };
}

describe('wf2-right-sizing-scanner (E2E)', () => {
  it('fans out per scope and aggregates statuses + savings', async () => {
    const extraScopes = [
      { ...SCOPES[0]!, scope_id: 333, scope_name: 'Skipped', scope_slug: 'skipped' },
      { ...SCOPES[0]!, scope_id: 444, scope_name: 'Kept', scope_slug: 'kept' },
      { ...SCOPES[0]!, scope_id: 555, scope_name: 'Closed', scope_slug: 'closed' },
    ];
    const byId: Record<string, Record<string, unknown>> = {
      '111': {
        status: 'created',
        action_item_id: 'ai_1',
        estimated_savings_usd_month: 12.5,
        scope_id: 111,
      },
      '222': {
        status: 'not_candidate',
        action_item_id: null,
        estimated_savings_usd_month: 0,
        scope_id: 222,
      },
      '333': { status: 'prefiltered', action_item_id: null, scope_id: 333 },
      '444': { status: 'active_valid', action_item_id: 'ai_4', scope_id: 444 },
      '555': { status: 'closed_stale', action_item_id: 'ai_5', scope_id: 555 },
    };
    const { result, created } = await runScanner({
      byId,
      scopes: [...SCOPES, ...extraScopes],
    });
    expect(result.outputs.scopes).toBe(5);
    expect(result.outputs.created).toBe(1);
    expect(result.outputs.not_candidate).toBe(1);
    expect(result.outputs.prefiltered).toBe(1);
    expect(result.outputs.active_valid).toBe(1);
    expect(result.outputs.closed_stale).toBe(1);
    expect(result.outputs.estimated_savings_usd_month).toBe(12.5);
    // only items freshly created/refreshed are surfaced as scan output
    expect(result.outputs.action_item_ids).toEqual(['ai_1']);
    // no sub-ticket findings → no portfolio item
    expect(created).toHaveLength(0);
  });

  it('portfolio: sub-ticket findings aggregate into ONE org-level item', async () => {
    const byId: Record<string, Record<string, unknown>> = {
      '111': {
        status: 'below_min_savings',
        scope_id: 111,
        scope_name: 'API Prod',
        environment: 'stage',
        naive_savings_usd_month: 0.8,
        naive_recommendation: { cpu_request_mc: 100, mem_request_mb: 128 },
        stats: {
          cpu: { avg_request_mc: 300 },
          mem: { avg_request_mb: 512 },
        },
      },
      '222': {
        status: 'below_min_savings',
        scope_id: 222,
        scope_name: 'Worker Prod',
        environment: 'test',
        naive_savings_usd_month: 0.5,
        naive_recommendation: { cpu_request_mc: 50, mem_request_mb: 64 },
        stats: { cpu: { avg_request_mc: 200 }, mem: { avg_request_mb: 256 } },
      },
    };
    const { created, updated } = await runScanner({ byId, scopes: SCOPES });
    expect(updated).toHaveLength(0);
    expect(created).toHaveLength(1);
    const value = created[0]!.observed_value as number;
    expect(value).toBeCloseTo(1.3, 2);
  });

  it('portfolio: resolved scopes leave, fresh ones enter, the rest persists', async () => {
    const existing = {
      id: 'ai_pf',
      status: 'open',
      metadata: {
        rightsizing_key: 'rightsizing-portfolio',
        entries: {
          '111': { scope_id: '111', scope_name: 'API Prod', savings_usd_month: 0.8 },
          '999': { scope_id: '999', scope_name: 'Elsewhere', savings_usd_month: 0.3 },
        },
      },
    };
    const byId: Record<string, Record<string, unknown>> = {
      // 111 got a REAL item this run → must leave the portfolio
      '111': { status: 'created', action_item_id: 'ai_x', scope_id: 111 },
      // 222 is a fresh sub-ticket finding → enters
      '222': {
        status: 'below_min_savings',
        scope_id: 222,
        scope_name: 'Worker Prod',
        environment: 'test',
        naive_savings_usd_month: 0.5,
        naive_recommendation: { cpu_request_mc: 50, mem_request_mb: 64 },
        stats: { cpu: { avg_request_mc: 200 }, mem: { avg_request_mb: 256 } },
      },
    };
    const { created, updated } = await runScanner({ byId, scopes: SCOPES, portfolio: existing });
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(1);
    // 999 (not scanned this run) persists + 222 enters = 0.3 + 0.5
    expect(updated[0]!.observed_value as number).toBeCloseTo(0.8, 2);
  });
});

describe('wf7-rightsizing-closer (E2E)', () => {
  it('fans out per scope and aggregates verdicts + realized savings', async () => {
    const byId: Record<string, Record<string, unknown>> = {
      '111': { status: 'verified', action_item_id: 'ai_1', realized_savings_usd_month: 2.5 },
      '222': { status: 'no_item', action_item_id: null, realized_savings_usd_month: 0 },
    };
    const result = await runWorkflowE2E({
      yamlPath: resolve(DIR, FILES.closer),
      inputs: {},
      pluginStubs: {
        manual: passthroughTrigger,
        cron: passthroughTrigger,
        'np-lake-query': lakeStub(SCOPES),
        'sub-workflow': {
          handler: (ctx: { inputs: Record<string, unknown> }) => {
            const scope = ctx.inputs.scope as Record<string, unknown>;
            return ok(byId[String(scope.scope_id)]!);
          },
          executeMode: 'all' as const,
        },
      },
    });
    expect(result.outputs.scopes).toBe(2);
    expect(result.outputs.verified).toBe(1);
    expect(result.outputs.no_item).toBe(1);
    expect(result.outputs.realized_savings_usd_month).toBe(2.5);
    expect(result.outputs.closed_item_ids).toEqual(['ai_1']);
  });
});
