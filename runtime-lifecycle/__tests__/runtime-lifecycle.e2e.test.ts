/**
 * @file E2E tests for wf-r1 (runtime catalog sync).
 *
 * Covers: good scrape → PATCH + applied true; migration `target` precompute
 * (per runtime, stored on the written catalog rows; null when no supported
 * same-language successor exists); validation failures (too few runtimes,
 * unparseable dates, prose runtime ids) → the execution FAILS and no PATCH is
 * made (v4: no more "alert" action items); change detection vs the current
 * metadata instance (identical modulo scraped_at/counts → no PATCH, one field
 * different → PATCH); dry_run → no PATCH even when changed.
 *
 * Plugin stubs cannot see step config, so payload constants are asserted by
 * parsing the YAML directly in the shape block.
 */
import { readFile, readdir } from 'node:fs/promises';
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
  catalogSync: 'wf-r1-catalog-sync.yaml',
  scanner: 'wf-r2-scanner.yaml',
  apply: 'wf-r4-apply.yaml',
  events: 'wf-r3-events.yaml',
  closer: 'wf-r5-closer.yaml',
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

// ── Fixture catalog: 18 rows, sanity ids supported, 7 deprecated ────────

interface RuntimeRow {
  id: string;
  language: string;
  version: string;
  status: 'supported' | 'deprecated';
  deprecation_date: string | null;
  block_function_create: string | null;
  block_function_update: string | null;
  os: string | null;
}

function row(
  id: string,
  language: string,
  version: string,
  status: 'supported' | 'deprecated',
  deprecation_date: string | null = null,
): RuntimeRow {
  return {
    id,
    language,
    version,
    status,
    deprecation_date,
    block_function_create: deprecation_date,
    block_function_update: deprecation_date,
    os: 'Amazon Linux 2023',
  };
}

const GOOD_RUNTIMES: RuntimeRow[] = [
  row('nodejs22.x', 'nodejs', '22', 'supported'),
  row('nodejs20.x', 'nodejs', '20', 'supported'),
  row('nodejs18.x', 'nodejs', '18', 'deprecated', '2025-01-06'),
  row('python3.13', 'python', '3.13', 'supported'),
  row('python3.12', 'python', '3.12', 'supported'),
  row('python3.9', 'python', '3.9', 'deprecated', '2025-12-15'),
  row('java21', 'java', '21', 'supported'),
  row('java17', 'java', '17', 'supported'),
  row('java11', 'java', '11', 'deprecated', '2024-06-01'),
  row('java8.al2', 'java', '8', 'deprecated', '2024-06-01'),
  row('dotnet8', 'dotnet', '8', 'supported'),
  row('dotnet6', 'dotnet', '6', 'deprecated', '2024-11-12'),
  row('go1.x', 'go', '1', 'deprecated', '2023-12-31'),
  row('ruby3.3', 'ruby', '3.3', 'supported'),
  row('ruby3.2', 'ruby', '3.2', 'supported'),
  row('ruby2.7', 'ruby', '2.7', 'deprecated', '2023-12-07'),
  row('provided.al2023', 'provided', 'al2023', 'supported'),
  row('provided.al2', 'provided', 'al2', 'supported'),
  // Historical Lambda@Edge id — hyphenated, pins the id-regex fix (live-run
  // finding: the original regex rejected this real AWS identifier).
  {
    id: 'nodejs4.3-edge',
    language: 'nodejs',
    version: '4.3',
    status: 'deprecated',
    deprecation_date: '2020-11-30',
    block_function_create: null,
    block_function_update: null,
    os: null,
  },
];
const SOURCE_URLS = [
  'https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html',
  'https://docs.aws.amazon.com/lambda/latest/dg/runtime-support-policy.html',
];
const GOOD_SUPPORTED_COUNT = GOOD_RUNTIMES.filter((r) => r.status === 'supported').length; // 11
const GOOD_DEPRECATED_COUNT = GOOD_RUNTIMES.filter((r) => r.status === 'deprecated').length; // 8

function goodScrapeOutput(overrideRuntimes?: RuntimeRow[]) {
  return { runtimes: overrideRuntimes ?? GOOD_RUNTIMES, source_urls: SOURCE_URLS };
}

// ── Harness ───────────────────────────────────────────────────────────

interface RunOpts {
  inputs?: Record<string, unknown>;
  scrapeOutput?: unknown;
  currentInstance?: { status: number; body: unknown };
}

// A scrape that fails validation now FAILS the execution (the `fail_invalid`
// code-exec step throws), so runWorkflowE2E rejects. This wrapper captures
// that rejection (and the calls made up to it) so a test can assert BOTH that
// the run failed AND that no PATCH happened.
async function runCatalogSync(opts: RunOpts) {
  const patchCalls: Record<string, unknown>[] = [];
  let result: Awaited<ReturnType<typeof runWorkflowE2E>> | undefined;
  let error: Error | undefined;
  try {
    result = await runWorkflowE2E({
      yamlPath: resolve(DIR, FILES.catalogSync),
      inputs: opts.inputs ?? {},
      pluginStubs: {
        manual: passthroughTrigger,
        cron: passthroughTrigger,
        'claude-code-agent': {
          handler: () => ok((opts.scrapeOutput as Record<string, unknown>) ?? goodScrapeOutput()),
          executeMode: 'all' as const,
        },
        'np-api-call': {
          handler: (ctx: { stepId: string; inputs: Record<string, unknown> }) => {
            if (ctx.stepId === 'read_current') {
              return ok(opts.currentInstance ?? { status: 404, body: {} });
            }
            if (ctx.stepId === 'write_metadata') {
              patchCalls.push(ctx.inputs);
              return ok({ status: 200, body: {} });
            }
            return ok({ status: 200, body: {} });
          },
          executeMode: 'all' as const,
        },
      },
    });
  } catch (err) {
    error = err as Error;
  }
  return { result, error, patchCalls };
}

// ── Shape ─────────────────────────────────────────────────────────────

describe('wf-r1-catalog-sync (shape)', () => {
  it('parses + validates', async () => {
    const def = await loadYaml(FILES.catalogSync);
    expect(def.id).toBeTruthy();
    expect(Object.keys(def.steps ?? {}).length).toBeGreaterThan(0);
  });

  it('precomputes target, fails (never alerts) on invalid, path moved to /action-items', async () => {
    const raw = await readFile(join(DIR, FILES.catalogSync), 'utf8');
    expect(raw).toMatch(/path:\s*"\/action-items\/runtime-lifecycle"/);
    // Target precompute logic MOVED here from wf-r2.
    expect(raw).toMatch(/function pickTarget/);
    expect(raw).toMatch(/target: pickTarget\(/);
    // Invalid scrape → fail the execution, never write, never alert.
    expect(raw).toMatch(/id: fail_invalid/);
    expect(raw).toMatch(/throw new Error\('Runtime catalog scrape failed validation/);
    expect(raw).not.toMatch(/np-action-item-find/);
    expect(raw).not.toMatch(/np-action-item-create/);
    expect(raw).not.toMatch(/alert_key/);
  });
});

// ── E2E ───────────────────────────────────────────────────────────────

describe('wf-r1-catalog-sync (E2E)', () => {
  it('good scrape: PATCHes metadata once with correct counts, applied true', async () => {
    const { result, patchCalls } = await runCatalogSync({
      currentInstance: { status: 404, body: {} },
    });
    expect(patchCalls).toHaveLength(1);
    expect(result?.outputs.applied).toBe(true);
    expect(result?.outputs.supported_count).toBe(GOOD_SUPPORTED_COUNT);
    expect(result?.outputs.deprecated_count).toBe(GOOD_DEPRECATED_COUNT);
  });

  // ── Target precompute (moved here from the retired wf-r2 pickTarget) ──

  it('precomputes each runtime target on the written catalog rows (smallest supported same-language jump)', async () => {
    const { patchCalls } = await runCatalogSync({ currentInstance: { status: 404, body: {} } });
    expect(patchCalls).toHaveLength(1);
    const written = patchCalls[0]?.catalog as {
      runtimes: { id: string; target: string | null }[];
    };
    const byId = Object.fromEntries(written.runtimes.map((r) => [r.id, r.target]));
    // nodejs18.x (deprecated) → nodejs20.x (smallest supported node > 18;
    // nodejs20.x has no deprecation date so it clears the horizon).
    expect(byId['nodejs18.x']).toBe('nodejs20.x');
    // python3.9 (deprecated) → python3.12 (smallest supported python > 3.9).
    expect(byId['python3.9']).toBe('python3.12');
  });

  it('no supported same-language successor: target is null (go1.x)', async () => {
    const { patchCalls } = await runCatalogSync({ currentInstance: { status: 404, body: {} } });
    const written = patchCalls[0]?.catalog as {
      runtimes: { id: string; target: string | null }[];
    };
    // go1.x is the only 'go' runtime and it is deprecated → no successor.
    const go = written.runtimes.find((r) => r.id === 'go1.x');
    expect(go?.target).toBeNull();
  });

  // ── Invalid scrape → the execution FAILS, catalog untouched (no alerts) ──

  it('broken scrape (12 runtimes): execution fails, no PATCH, error mentions min 15', async () => {
    const { error, patchCalls } = await runCatalogSync({
      scrapeOutput: goodScrapeOutput(GOOD_RUNTIMES.slice(0, 12)),
      currentInstance: { status: 404, body: {} },
    });
    expect(patchCalls).toHaveLength(0);
    expect(error).toBeDefined();
    expect(String(error?.message)).toMatch(/min 15/);
  });

  it('broken dates: execution fails, no PATCH, error mentions the runtime id', async () => {
    const bad = GOOD_RUNTIMES.map((r) =>
      r.id === 'java17' ? { ...r, deprecation_date: 'soonish' } : r,
    );
    const { error, patchCalls } = await runCatalogSync({
      scrapeOutput: goodScrapeOutput(bad),
      currentInstance: { status: 404, body: {} },
    });
    expect(patchCalls).toHaveLength(0);
    expect(error).toBeDefined();
    expect(String(error?.message)).toMatch(/java17/);
  });

  it('prose runtime id: execution fails, error mentions the id format rule', async () => {
    const bad = GOOD_RUNTIMES.map((r) => (r.id === 'java17' ? { ...r, id: 'Node.js 20' } : r));
    const { error, patchCalls } = await runCatalogSync({
      scrapeOutput: goodScrapeOutput(bad),
      currentInstance: { status: 404, body: {} },
    });
    expect(patchCalls).toHaveLength(0);
    expect(error).toBeDefined();
    expect(String(error?.message)).toMatch(/Node\.js 20/);
    expect(String(error?.message)).toMatch(/format/);
  });

  // The stored side keeps its `target` AS-IS (never re-derived), so an
  // up-to-date stored catalog is one that already carries the computed
  // targets — exactly what a previous wf-r1 run wrote. Capture that write
  // once and use it as the stored fixture.
  async function storedCatalogFromPriorRun(): Promise<{
    runtimes: Record<string, unknown>[];
  }> {
    const { patchCalls } = await runCatalogSync({
      currentInstance: { status: 404, body: {} },
    });
    return patchCalls[0]?.catalog as { runtimes: Record<string, unknown>[] };
  }

  it('scrape identical to current (modulo scraped_at/counts): no PATCH, reason unchanged', async () => {
    const stored = await storedCatalogFromPriorRun();
    const { result, patchCalls } = await runCatalogSync({
      currentInstance: {
        status: 200,
        body: {
          runtimes: stored.runtimes,
          source_urls: SOURCE_URLS,
          scraped_at: '1970-01-01T00:00:00Z',
          supported_count: 999,
          deprecated_count: 999,
        },
      },
    });
    expect(patchCalls).toHaveLength(0);
    expect(result?.outputs.applied).toBe(false);
    expect(result?.outputs.reason).toBe('unchanged');
  });

  it('MIGRATION: stored catalog predates targets (same rows, no target) → PATCH fires and writes them', async () => {
    // Live 2026-07-21 regression: re-deriving targets on the stored side
    // made "stored without targets" compare equal to "new with targets" —
    // v4's first run read `unchanged` and never wrote a single target.
    const { result, patchCalls } = await runCatalogSync({
      currentInstance: {
        status: 200,
        body: {
          runtimes: GOOD_RUNTIMES, // pre-v4 shape: no `target` key at all
          source_urls: SOURCE_URLS,
          scraped_at: '2026-07-01T00:00:00Z',
          supported_count: GOOD_SUPPORTED_COUNT,
          deprecated_count: GOOD_DEPRECATED_COUNT,
        },
      },
    });
    expect(patchCalls).toHaveLength(1);
    expect(result?.outputs.applied).toBe(true);
    const written = patchCalls[0]?.catalog as {
      runtimes: { id: string; target?: string | null }[];
    };
    for (const r of written.runtimes) expect(r).toHaveProperty('target');
  });

  it('one deprecation_date differs from current: PATCH called', async () => {
    const currentRuntimes = GOOD_RUNTIMES.map((r) =>
      r.id === 'python3.9' ? { ...r, deprecation_date: '2099-01-01' } : r,
    );
    const { result, patchCalls } = await runCatalogSync({
      currentInstance: {
        status: 200,
        body: {
          runtimes: currentRuntimes,
          source_urls: SOURCE_URLS,
          scraped_at: '2026-07-01T00:00:00Z',
          supported_count: GOOD_SUPPORTED_COUNT,
          deprecated_count: GOOD_DEPRECATED_COUNT,
        },
      },
    });
    expect(patchCalls).toHaveLength(1);
    expect(result?.outputs.applied).toBe(true);
  });

  it('dry_run: changes detected but no PATCH is made', async () => {
    const { result, patchCalls } = await runCatalogSync({
      inputs: { dry_run: true },
      currentInstance: { status: 404, body: {} },
    });
    expect(patchCalls).toHaveLength(0);
    expect(result?.outputs.applied).toBe(false);
    expect(result?.outputs.reason).toBe('dry_run');
  });

  // ── Agent variance on derivable fields (live-run finding round 2) ─────

  it('agent variance on a derivable field (version) does not trigger a spurious PATCH', async () => {
    // Current instance carries "provided" version drift from a previous run
    // ("al"); the fresh scrape drifts differently ("") for the SAME id.
    // Both are wrong per the id, but language/version are re-derived from
    // id before comparison, so this must NOT look like a change.
    const stored = await storedCatalogFromPriorRun();
    const currentRuntimes = stored.runtimes.map((r) =>
      r.id === 'provided.al2023' ? { ...r, version: 'al' } : r,
    );
    const scraped = GOOD_RUNTIMES.map((r) =>
      r.id === 'provided.al2023' ? { ...r, version: '' } : r,
    );
    const { result, patchCalls } = await runCatalogSync({
      scrapeOutput: goodScrapeOutput(scraped),
      currentInstance: {
        status: 200,
        body: {
          runtimes: currentRuntimes,
          source_urls: SOURCE_URLS,
          scraped_at: '2026-07-01T00:00:00Z',
          supported_count: GOOD_SUPPORTED_COUNT,
          deprecated_count: GOOD_DEPRECATED_COUNT,
        },
      },
    });
    expect(patchCalls).toHaveLength(0);
    expect(result?.outputs.reason).toBe('unchanged');
  });

  it('writes the DERIVED version, not whatever the agent emitted', async () => {
    const scraped = GOOD_RUNTIMES.map((r) =>
      r.id === 'provided.al2023' ? { ...r, version: 'garbage-from-agent' } : r,
    );
    const { patchCalls } = await runCatalogSync({
      scrapeOutput: goodScrapeOutput(scraped),
      currentInstance: { status: 404, body: {} },
    });
    expect(patchCalls).toHaveLength(1);
    const written = patchCalls[0]?.catalog as { runtimes: { id: string; version: string }[] };
    const writtenRow = written.runtimes.find((r) => r.id === 'provided.al2023');
    expect(writtenRow?.version).toBe('al2023');
  });
});

// ── Runtime catalog fixture (wf-r2 scanner + wf-r3 events) ───────────────
//
// classify's code-exec runs Date.now() for real (CLAUDE.md: code-exec is
// activity-side, real Date is fine there) — the harness's fixed `clock`
// only governs the runner's own timestamps, not sandboxed step code. So
// every catalog date below is computed relative to the REAL current time
// at test-file load, not hardcoded — deterministic regardless of when the
// suite runs (mirrors "pass todayMs implicitly by fixture dates").

const DAY_MS = 86400000;
const NOW_MS = Date.now();
function daysFromNow(n: number): string {
  return new Date(NOW_MS + n * DAY_MS).toISOString().slice(0, 10);
}

const RUNTIME_CATALOG = {
  runtimes: [
    {
      id: 'nodejs16.x',
      language: 'nodejs',
      version: '16',
      status: 'deprecated',
      deprecation_date: daysFromNow(-400),
      block_function_create: daysFromNow(-450),
      block_function_update: daysFromNow(-420),
      os: 'Amazon Linux 2',
    },
    {
      id: 'nodejs18.x',
      language: 'nodejs',
      version: '18',
      status: 'deprecated',
      deprecation_date: daysFromNow(-200),
      block_function_create: daysFromNow(-250),
      block_function_update: daysFromNow(-220),
      os: 'Amazon Linux 2',
    },
    // Supported but deprecates in 60 days — inside the 180-day pickTarget
    // horizon, so it must be REJECTED as a migration target (exercises the
    // horizon rule: nodejs16.x must jump straight to nodejs22.x).
    {
      id: 'nodejs20.x',
      language: 'nodejs',
      version: '20',
      status: 'supported',
      deprecation_date: daysFromNow(60),
      block_function_create: daysFromNow(120),
      block_function_update: daysFromNow(150),
      os: 'Amazon Linux 2023',
    },
    {
      id: 'nodejs22.x',
      language: 'nodejs',
      version: '22',
      status: 'supported',
      deprecation_date: null,
      block_function_create: null,
      block_function_update: null,
      os: 'Amazon Linux 2023',
    },
    {
      id: 'python3.8',
      language: 'python',
      version: '3.8',
      status: 'deprecated',
      deprecation_date: daysFromNow(-300),
      block_function_create: daysFromNow(-350),
      block_function_update: daysFromNow(-320),
      os: 'Amazon Linux 2',
    },
    // Still "supported" per catalog status but deprecates in 20 days —
    // inside the 31-day expiring window (priority high, verdict expiring).
    {
      id: 'python3.9',
      language: 'python',
      version: '3.9',
      status: 'supported',
      deprecation_date: daysFromNow(20),
      block_function_create: daysFromNow(80),
      block_function_update: daysFromNow(110),
      os: 'Amazon Linux 2',
    },
    {
      id: 'python3.13',
      language: 'python',
      version: '3.13',
      status: 'supported',
      deprecation_date: null,
      block_function_create: null,
      block_function_update: null,
      os: 'Amazon Linux 2023',
    },
    // Deprecated with NO other 'go' row in the catalog — pickTarget must
    // return null (has_target false; item still opens, no suggestion).
    {
      id: 'go1.x',
      language: 'go',
      version: '1',
      status: 'deprecated',
      deprecation_date: daysFromNow(-500),
      block_function_create: daysFromNow(-550),
      block_function_update: daysFromNow(-520),
      os: 'Amazon Linux',
    },
  ],
  source_urls: SOURCE_URLS,
  scraped_at: '2026-07-01T00:00:00Z',
  supported_count: 4,
  deprecated_count: 4,
};

// ── wf-r2 (Runtime Deprecation Scanner) — lake-first, FLAT writes ────────
//
// Every write is a flat per-item np-api-call pass (find-before-create → create
// item → create suggestion → bump priority) — no wf-r2b sub-workflow child.
// The stubs below drive np-api-call per step id and per forEach item:
// `spreadItem: true` merges each request's {path, method, body|query} into
// ctx.inputs, so the same generic np-api-call step parameterizes itself per
// iteration. v4: the catalog is JOINed into the lake rows (status/dates/target
// columns), NOT read over the API — RUNTIME_CATALOG below defines the catalog
// and `scanRow` derives each row's catalog columns from it (the diff classifies
// each row against its own columns, folding the retired wf-r2b's classify/build
// logic verbatim).

// v4: wf-r1 precomputes each runtime's migration `target` and the scanner's
// lake query JOINs the catalog, so every lake row now carries the catalog
// columns (status/dates/target) plus a `catalog_count` sanity scalar. These
// tables mirror what wf-r1 would have stored + what the query would emit.
const SCAN_TARGET: Record<string, string> = {
  'nodejs16.x': 'nodejs22.x',
  'nodejs18.x': 'nodejs22.x',
  'nodejs20.x': 'nodejs22.x',
  'python3.8': 'python3.13',
  'python3.9': 'python3.13',
};

// The catalog columns the lake JOIN emits for a given runtime. A runtime NOT
// in the catalog (unknown) yields empty strings — the diff reads catalog_status
// '' as "no entry" → classify unknown_runtime → prefiltered.
function lakeCatalogCols(runtimeId: string) {
  const r = RUNTIME_CATALOG.runtimes.find((x) => x.id === runtimeId);
  if (!r)
    return {
      catalog_status: '',
      deprecation_date: '',
      block_function_create: '',
      block_function_update: '',
      target: '',
    };
  return {
    catalog_status: r.status,
    deprecation_date: r.deprecation_date ?? '',
    block_function_create: r.block_function_create ?? '',
    block_function_update: r.block_function_update ?? '',
    target: SCAN_TARGET[runtimeId] ?? '',
  };
}

// One lake_detect row (raw SQL row shape — flat, snake_case columns, as
// np-lake-query returns it). `existing_item_id: ''` / catalog columns as empty
// strings (not null) mirror the live query's behavior for an unmatched LEFT
// JOIN against a non-nullable String column (verified live 2026-07-21).
// `catalog_count` defaults to a non-zero count (catalog present); pass 0 to
// exercise the catalog_missing abort.
function scanRow(scopeId: string, overrides: Record<string, unknown> = {}) {
  const runtime = (overrides.runtime as string | undefined) ?? 'nodejs16.x';
  return {
    scope_id: scopeId,
    scope_nrn: `organization=100000001:account=1:namespace=1:application=app_${scopeId}:scope=${scopeId}`,
    scope_name: `${scopeId}-worker`,
    application_id: `app_${scopeId}`,
    application_name: `app-${scopeId}`,
    runtime,
    environment: 'development',
    ...lakeCatalogCols(runtime),
    catalog_count: RUNTIME_CATALOG.runtimes.length,
    existing_item_id: '',
    existing_priority: null,
    existing_status: null,
    ...overrides,
  };
}

interface ScannerOpts {
  inputs?: Record<string, unknown>;
  rows?: Record<string, unknown>[];
  /**
   * Per-scope live-find results for find_existing, keyed by
   * `metadata.scope_id`. Default: no live item ({results: []}) for every
   * scope, so every create candidate is confirmed.
   */
  findByScopeId?: Record<string, Record<string, unknown>[]>;
  /**
   * scope_ids whose find_existing returns a PERMANENT (4xx, `retryable:
   * false`) failure — settled after ONE attempt, absorbed as `{}` → skipped
   * as find_failed.
   */
  findFailScopeIds?: string[];
  /** scope_ids whose create_item PERMANENTLY (4xx) fails → 1 call → create_failed. */
  createFailScopeIds?: string[];
  /** scope_ids whose create_suggestion PERMANENTLY (4xx) fails → 1 call → suggestion_failed. */
  suggestFailScopeIds?: string[];
  /** existing item ids (bump path) whose bump_priority PERMANENTLY (4xx) fails → 1 call. */
  bumpFailItemIds?: string[];

  // ── Retryable (5xx) / HTTP-error-slot variants (per-iteration retry) ──
  //
  // Only the idempotent GET/PATCH steps (find_existing, bump_priority) carry a
  // retry_policy; the non-idempotent POSTs (create_item, create_suggestion) do
  // NOT retry, so a 5xx there settles after a SINGLE attempt.
  /**
   * Per scope_id: how many RETRYABLE (5xx) failures find_existing returns
   * before it succeeds. `{scope_1: 1}` → fails once, retried, succeeds on the
   * 2nd attempt. Exercises the transient-then-success path on a retried GET.
   */
  findTransientFails?: Record<string, number>;
  /**
   * Per existing item id: how many RETRYABLE (5xx) failures bump_priority
   * returns before it succeeds. Transient-then-success on the idempotent PATCH.
   */
  bumpTransientFails?: Record<string, number>;
  /**
   * scope_ids whose create_item returns a RETRYABLE (5xx) failure. Because the
   * POST carries NO retry_policy, this settles after ONE attempt → create_failed.
   */
  create5xxScopeIds?: string[];
  /** scope_ids whose create_suggestion returns a 5xx → ONE attempt → suggestion_failed. */
  suggest5xxScopeIds?: string[];
  /** existing item ids whose bump fails RETRYABLY on EVERY attempt → 3 attempts → bump_failed. */
  bumpExhaustItemIds?: string[];
  /**
   * scope_ids whose create_item resolves SUCCESS carrying an HTTP-error
   * status slot (`{status: 500|409, body: {}}`) — models a
   * failOnHttpError:false-style response slot the summary must still bucket
   * as a failure (no `body.id`). Belt-and-suspenders for the two shapes.
   */
  createHttpErrorSlotScopeIds?: string[];
}

async function runScanner(opts: ScannerOpts) {
  const findCalls: Record<string, unknown>[] = [];
  const createCalls: Record<string, unknown>[] = [];
  const suggestCalls: Record<string, unknown>[] = [];
  const bumpCalls: Record<string, unknown>[] = [];
  // Per-iteration attempt counter so a transient stub can fail retryably N
  // times then succeed. Keyed `${stepId}:${key}`; the harness injects an
  // instant sleep, so the retry backoff is free in tests.
  const attempts = new Map<string, number>();
  const nthAttempt = (key: string): number => {
    const n = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, n);
    return n;
  };
  const rows = opts.rows ?? [];
  const result = await runWorkflowE2E({
    yamlPath: resolve(DIR, FILES.scanner),
    inputs: opts.inputs ?? {},
    pluginStubs: {
      manual: passthroughTrigger,
      cron: passthroughTrigger,
      'np-lake-query': {
        handler: () => ok({ rows, rowCount: rows.length }),
        executeMode: 'all' as const,
      },
      'np-api-call': {
        handler: (ctx: { stepId: string; inputs: Record<string, unknown> }): IStepResult => {
          if (ctx.stepId === 'find_existing') {
            const query = (ctx.inputs.query ?? {}) as Record<string, unknown>;
            const scopeId = String(query['metadata.scope_id'] ?? '');
            findCalls.push(ctx.inputs);
            // Permanent (4xx): settles after one attempt, absorbed → find_failed.
            if ((opts.findFailScopeIds ?? []).includes(scopeId)) {
              return stepFailurePermanent(`find failed for ${scopeId}`);
            }
            // Transient (5xx): fail retryably N times, then succeed.
            const tf = opts.findTransientFails?.[scopeId];
            if (tf !== undefined && nthAttempt(`find:${scopeId}`) <= tf) {
              return stepFailure(`find transient for ${scopeId}`);
            }
            const results = opts.findByScopeId?.[scopeId] ?? [];
            return ok({ status: 200, body: { results } });
          }
          if (ctx.stepId === 'create_item') {
            const body = (ctx.inputs.body ?? {}) as { metadata?: { scope_id?: string } };
            const scopeId = String(body.metadata?.scope_id ?? '');
            createCalls.push(ctx.inputs);
            // Permanent (4xx): 1 attempt → absorbed → create_failed.
            if ((opts.createFailScopeIds ?? []).includes(scopeId)) {
              return stepFailurePermanent(`create failed for ${scopeId}`);
            }
            // Retryable (5xx) but the POST does NOT retry → 1 attempt → create_failed.
            if ((opts.create5xxScopeIds ?? []).includes(scopeId)) {
              return stepFailure(`create 5xx for ${scopeId}`);
            }
            // Response-slot shape: SUCCESS result carrying an HTTP error status
            // (models failOnHttpError:false); no body.id → summary buckets it.
            if ((opts.createHttpErrorSlotScopeIds ?? []).includes(scopeId)) {
              return ok({ status: 500, body: {} });
            }
            return ok({
              status: 200,
              body: { id: `ai_${scopeId}`, slug: `item-${scopeId}`, status: 'open' },
            });
          }
          if (ctx.stepId === 'create_suggestion') {
            const body = (ctx.inputs.body ?? {}) as { metadata?: { scope_id?: string } };
            const scopeId = String(body.metadata?.scope_id ?? '');
            suggestCalls.push(ctx.inputs);
            if ((opts.suggestFailScopeIds ?? []).includes(scopeId)) {
              return stepFailurePermanent(`suggestion failed for ${scopeId}`);
            }
            // Retryable (5xx) but the POST does NOT retry → 1 attempt → suggestion_failed.
            if ((opts.suggest5xxScopeIds ?? []).includes(scopeId)) {
              return stepFailure(`suggestion 5xx for ${scopeId}`);
            }
            return ok({ status: 200, body: { id: `sg_${scopeId}` } });
          }
          if (ctx.stepId === 'bump_priority') {
            const path = String(ctx.inputs.path ?? '');
            const itemId = path.split('/').pop() ?? '';
            bumpCalls.push(ctx.inputs);
            if ((opts.bumpFailItemIds ?? []).includes(itemId)) {
              return stepFailurePermanent(`bump failed for ${itemId}`);
            }
            // Always-5xx: the idempotent PATCH retries → exhausts (3 attempts) → bump_failed.
            if ((opts.bumpExhaustItemIds ?? []).includes(itemId)) {
              return stepFailure(`bump 5xx for ${itemId}`);
            }
            // Transient (5xx): fail retryably N times, then succeed (PATCH retried).
            const tf = opts.bumpTransientFails?.[itemId];
            if (tf !== undefined && nthAttempt(`bump:${itemId}`) <= tf) {
              return stepFailure(`bump transient for ${itemId}`);
            }
            return ok({ status: 200, body: { id: itemId, status: 'open' } });
          }
          return ok({ status: 200, body: {} });
        },
        executeMode: 'all' as const,
      },
    },
  });
  return { result, findCalls, createCalls, suggestCalls, bumpCalls };
}

describe('wf-r2-scanner (shape)', () => {
  it('parses + validates', async () => {
    const def = await loadYaml(FILES.scanner);
    expect(def.id).toBe('runtime_deprecation_scanner');
    expect(Object.keys(def.steps ?? {}).length).toBeGreaterThan(0);
  });

  it('one lake query, diff classifies, flat spreadItem forEach write passes (no sub-workflow child)', async () => {
    const raw = await readFile(join(DIR, FILES.scanner), 'utf8');
    expect(raw).toMatch(/plugin_type:\s*np-lake-query/);
    expect(raw).toMatch(/FROM core_entities_scope/);
    expect(raw).toMatch(/lambda_runtimes/);
    expect(raw).toMatch(/governance_action_items_action_items/);
    expect(raw).toMatch(/schedule:\s*"0 7 \* \* \*"/);
    expect(raw).toMatch(/spreadItem:\s*true/);
    expect(raw).toMatch(/parallel:\s*true/);
    // v4: catalog comes from the lake JOIN (target + catalog_count columns),
    // NOT an API read — the read_catalog/catalog_guard steps are GONE.
    expect(raw).toMatch(/cat\.target AS target/);
    expect(raw).toMatch(/catalog_count/);
    expect(raw).not.toMatch(/id: read_catalog/);
    expect(raw).not.toMatch(/id: catalog_guard/);
    // The candidate filter stays IN the query (lake-first: only actionable
    // rows), and a UNION ALL sentinel row carries catalog_count so a missing
    // catalog is detectable even with zero candidates.
    expect(raw).toMatch(/cat\.status = 'deprecated'/);
    expect(raw).toMatch(/UNION ALL/);
    expect(raw).toMatch(/is_sentinel/);
    // The retired sub-workflow child and streaming scaffolding must be GONE.
    expect(raw).not.toMatch(/plugin_type:\s*sub-workflow/);
    expect(raw).not.toMatch(/runtime_lifecycle_analyze_scope/);
    expect(raw).not.toMatch(/np-entity-paginated-fetch/);
  });

  it('no step declares error_handling.fallback_step (forEach does not honor it — structural check)', async () => {
    const def = await loadYaml(FILES.scanner);
    for (const step of Object.values(
      (def.steps ?? {}) as Record<string, { errorHandling?: { fallbackStep?: unknown } }>,
    )) {
      expect(step.errorHandling?.fallbackStep).toBeUndefined();
    }
  });

  it('every write pass is a parallel spreadItem forEach np-api-call with a failOnHttpError shield; only the idempotent GET/PATCH retry', async () => {
    const def = await loadYaml(FILES.scanner);
    const steps = def.steps as unknown as Record<
      string,
      {
        pluginType?: string;
        forEach?: { spreadItem?: boolean; parallel?: boolean };
        inputs?: Record<string, unknown>;
        config?: { failOnHttpError?: unknown };
        errorHandling?: { retryPolicy?: { maxAttempts?: number } };
      }
    >;
    for (const id of ['find_existing', 'create_item', 'create_suggestion', 'bump_priority']) {
      const step = steps[id];
      expect(step, id).toBeDefined();
      expect(step?.pluginType).toBe('np-api-call');
      expect(step?.forEach?.spreadItem, `${id} spreadItem`).toBe(true);
      expect(step?.forEach?.parallel, `${id} parallel`).toBe(true);
      // Payload diet: the per-item request rides the forEach item, never a
      // declared input — spreadItem provides the inputs per iteration, so there
      // is NO predecessor-output fallback to shield against here.
      expect(Object.keys(step?.inputs ?? {}), `${id} inputs`).toEqual([]);
      // Every write step turns a >=400 into a real per-iteration failure.
      expect(step?.config?.failOnHttpError, `${id} failOnHttpError`).toBe(true);
    }
    // Idempotent reads/updates retry; the non-idempotent POSTs must NOT (a
    // lost-ack 5xx retry would duplicate the created item/suggestion).
    expect(steps.find_existing?.errorHandling?.retryPolicy?.maxAttempts).toBe(3);
    expect(steps.bump_priority?.errorHandling?.retryPolicy?.maxAttempts).toBe(3);
    expect(steps.create_item?.errorHandling?.retryPolicy).toBeUndefined();
    expect(steps.create_suggestion?.errorHandling?.retryPolicy).toBeUndefined();
  });
});

describe('wf-r2-scanner (E2E)', () => {
  it('mixed lake set: creates only the create rows, bumps only the stale rows, never touches already-correct rows', async () => {
    const rows = [
      scanRow('scope_1'), // no live item → create
      scanRow('scope_2', {
        existing_item_id: 'ai_1',
        existing_priority: 'critical',
        existing_status: 'open',
      }), // already critical → prefiltered
      scanRow('scope_3', {
        existing_item_id: 'ai_2',
        existing_priority: 'high',
        existing_status: 'open',
      }), // deprecated + not critical → bump
      scanRow('scope_4', {
        existing_item_id: 'ai_3',
        existing_priority: 'critical',
        existing_status: 'open',
      }), // already critical → prefiltered
    ];
    const { result, findCalls, createCalls, bumpCalls } = await runScanner({ rows });
    // Create path: one find-before-create + one create, for scope_1 only.
    expect(findCalls).toHaveLength(1);
    expect((findCalls[0]?.query as Record<string, unknown>)['metadata.scope_id']).toBe('scope_1');
    expect(createCalls).toHaveLength(1);
    expect((createCalls[0]?.body as { metadata: { scope_id: string } }).metadata.scope_id).toBe(
      'scope_1',
    );
    // Bump path: one PATCH for scope_3's existing item, to critical.
    expect(bumpCalls).toHaveLength(1);
    expect(String(bumpCalls[0]?.path)).toContain('ai_2');
    expect((bumpCalls[0]?.body as { priority: string }).priority).toBe('critical');
    expect(result.outputs.scopes_scanned).toBe(4);
    expect(result.outputs.candidates_create).toBe(1);
    expect(result.outputs.candidates_bump).toBe(1);
    expect(result.outputs.prefiltered).toBe(2);
    expect(result.outputs.created).toBe(1);
    expect(result.outputs.bumped).toBe(1);
  });

  it('all-skip lake result: no find, create, or bump calls', async () => {
    const rows = [
      scanRow('scope_1', {
        existing_item_id: 'ai_1',
        existing_priority: 'critical',
        existing_status: 'open',
      }),
      scanRow('scope_2', {
        existing_item_id: 'ai_2',
        existing_priority: 'critical',
        existing_status: 'open',
      }),
    ];
    const { result, findCalls, createCalls, bumpCalls } = await runScanner({ rows });
    expect(findCalls).toHaveLength(0);
    expect(createCalls).toHaveLength(0);
    expect(bumpCalls).toHaveLength(0);
    expect(result.outputs.candidates_create).toBe(0);
    expect(result.outputs.candidates_bump).toBe(0);
    expect(result.outputs.prefiltered).toBe(2);
    expect(result.outputs.catalog_ok).toBe(true);
  });

  // The query UNION ALLs a sentinel row (is_sentinel:1) that carries
  // catalog_count so a missing catalog is distinguishable from "catalog present
  // but zero deprecated candidates". These two tests pin both sides.
  const sentinelRow = (catalogCount: number) => ({ is_sentinel: 1, catalog_count: catalogCount });

  it('catalog_missing (catalog_count 0): aborts the sweep, no writes, reason catalog_missing', async () => {
    // Sentinel carries catalog_count 0 → the lambda_runtimes instance is
    // missing/empty — diff must abort rather than create items with null dates.
    const { result, findCalls, createCalls } = await runScanner({
      rows: [scanRow('scope_1', { catalog_count: 0 }), sentinelRow(0)],
    });
    expect(findCalls).toHaveLength(0);
    expect(createCalls).toHaveLength(0);
    expect(result.outputs.catalog_ok).toBe(false);
    expect(String(result.outputs.reason)).toMatch(/catalog_missing/);
    expect(result.outputs.scopes_scanned).toBe(0);
  });

  it('catalog present, zero candidates (only the sentinel row): NOT catalog_missing — a clean no-op', async () => {
    // Live behaviour when nothing is deprecated: the filtered query returns no
    // real rows, only the sentinel (catalog_count > 0).
    const { result, findCalls, createCalls } = await runScanner({ rows: [sentinelRow(8)] });
    expect(findCalls).toHaveLength(0);
    expect(createCalls).toHaveLength(0);
    expect(result.outputs.catalog_ok).toBe(true);
    expect(result.outputs.scopes_scanned).toBe(0);
  });

  it('the sentinel row is never treated as a scope (skipped alongside real candidates)', async () => {
    const { result, createCalls } = await runScanner({
      rows: [scanRow('scope_1'), sentinelRow(8)],
    });
    // Only the real candidate is scanned/created; the sentinel is dropped.
    expect(result.outputs.scopes_scanned).toBe(1);
    expect(createCalls).toHaveLength(1);
  });

  // ── Classification + build (migrated from the retired wf-r2b E2E) ──────

  it('nodejs16.x deprecated (dev): creates a critical item targeting nodejs22.x (horizon rule), with a suggestion, nrn from the lake row', async () => {
    const { result, createCalls, suggestCalls } = await runScanner({ rows: [scanRow('scope_1')] });
    expect(createCalls).toHaveLength(1);
    const body = createCalls[0]?.body as {
      priority: string;
      nrn: string;
      metadata: Record<string, unknown>;
    };
    expect(body.priority).toBe('critical');
    expect(body.metadata.current_runtime).toBe('nodejs16.x');
    expect(body.metadata.target_runtime).toBe('nodejs22.x');
    // nrn comes straight from the lake row (no fetch_scope_detail in v3).
    expect(body.nrn).toBe(scanRow('scope_1').scope_nrn);
    expect(suggestCalls).toHaveLength(1);
    const sgBody = suggestCalls[0]?.body as { metadata: Record<string, unknown> };
    expect(sgBody.metadata.to_runtime).toBe('nodejs22.x');
    expect(sgBody.metadata.from_runtime).toBe('nodejs16.x');
    expect(sgBody.metadata.action_type).toBe('runtime_upgrade');
    expect(result.outputs.created).toBe(1);
    expect(result.outputs.suggestion_created).toBe(1);
  });

  it('python3.9 deprecating in 20 days: creates a high-priority item', async () => {
    const { result, createCalls } = await runScanner({
      rows: [scanRow('scope_p', { runtime: 'python3.9' })],
    });
    expect(createCalls).toHaveLength(1);
    expect((createCalls[0]?.body as { priority: string }).priority).toBe('high');
    expect(result.outputs.candidates_create).toBe(1);
  });

  it('python3.13 (supported, no deprecation): prefiltered, never a candidate', async () => {
    const { result, createCalls } = await runScanner({
      rows: [scanRow('scope_ok', { runtime: 'python3.13' })],
    });
    expect(createCalls).toHaveLength(0);
    expect(result.outputs.candidates_create).toBe(0);
    expect(result.outputs.prefiltered).toBe(1);
  });

  it('unknown runtime (not in catalog): prefiltered, no create', async () => {
    const { result, createCalls } = await runScanner({
      rows: [scanRow('scope_u', { runtime: 'ruby3.2' })],
    });
    expect(createCalls).toHaveLength(0);
    expect(result.outputs.prefiltered).toBe(1);
  });

  it('existing live item already critical: prefiltered (no find, create, or bump)', async () => {
    const { result, findCalls, createCalls, bumpCalls } = await runScanner({
      rows: [
        scanRow('scope_1', {
          existing_item_id: 'ai_x',
          existing_priority: 'critical',
          existing_status: 'open',
        }),
      ],
    });
    expect(findCalls).toHaveLength(0);
    expect(createCalls).toHaveLength(0);
    expect(bumpCalls).toHaveLength(0);
    expect(result.outputs.prefiltered).toBe(1);
  });

  it('existing high item, runtime now deprecated: bumps priority to critical', async () => {
    const { result, bumpCalls, createCalls } = await runScanner({
      rows: [
        scanRow('scope_1', {
          existing_item_id: 'ai_hi',
          existing_priority: 'high',
          existing_status: 'open',
        }),
      ],
    });
    expect(createCalls).toHaveLength(0);
    expect(bumpCalls).toHaveLength(1);
    expect(String(bumpCalls[0]?.path)).toContain('ai_hi');
    expect((bumpCalls[0]?.body as { priority: string }).priority).toBe('critical');
    expect(result.outputs.candidates_bump).toBe(1);
    expect(result.outputs.bumped).toBe(1);
  });

  it('a resolved (non-live) existing item: treated as no item, a new one is created', async () => {
    const { result, createCalls } = await runScanner({
      rows: [
        scanRow('scope_1', {
          existing_item_id: 'ai_old',
          existing_priority: 'critical',
          existing_status: 'closed',
        }),
      ],
    });
    expect(createCalls).toHaveLength(1);
    expect(result.outputs.created).toBe(1);
  });

  it('production scope: suggestion offers exactly one apply-only option, seeded apply-only', async () => {
    const { suggestCalls } = await runScanner({
      rows: [scanRow('scope_1', { environment: 'production' })],
    });
    expect(suggestCalls).toHaveLength(1);
    const body = suggestCalls[0]?.body as {
      user_metadata_config: { properties: { deploy_timing: { oneOf: { const: string }[] } } };
      user_metadata: Record<string, unknown>;
    };
    expect(body.user_metadata_config.properties.deploy_timing.oneOf).toHaveLength(1);
    expect(body.user_metadata_config.properties.deploy_timing.oneOf[0]?.const).toBe('apply-only');
    expect(body.user_metadata.deploy_timing).toBe('apply-only');
  });

  it('non-production scope: suggestion offers deploy-now / next-deploy / scheduled, seeded deploy-now', async () => {
    const { suggestCalls } = await runScanner({ rows: [scanRow('scope_1')] });
    const body = suggestCalls[0]?.body as {
      user_metadata_config: {
        properties: {
          deploy_timing: { oneOf: { const: string }[] };
          deploy_at: { default: string };
        };
      };
      user_metadata: Record<string, unknown>;
    };
    const consts = body.user_metadata_config.properties.deploy_timing.oneOf.map((o) => o.const);
    expect(consts).toEqual(['deploy-now', 'next-deploy', 'scheduled']);
    expect(body.user_metadata_config.properties.deploy_at.default).toBe('');
    expect(body.user_metadata).toEqual({ deploy_timing: 'deploy-now', deploy_at: '' });
  });

  it('go1.x (deprecated, no successor in catalog): item created, no suggestion', async () => {
    const { result, createCalls, suggestCalls } = await runScanner({
      rows: [scanRow('scope_1', { runtime: 'go1.x' })],
    });
    expect(createCalls).toHaveLength(1);
    expect(
      (createCalls[0]?.body as { metadata: { target_runtime: unknown } }).metadata.target_runtime,
    ).toBeNull();
    expect(suggestCalls).toHaveLength(0);
    expect(result.outputs.created).toBe(1);
    expect(result.outputs.suggestion_created).toBe(0);
  });

  // ── Idempotency race + find-failure (the flat find-before-create guard) ──

  it('idempotency race: a find that turns up a LIVE item drops the create (skipped_existing)', async () => {
    const { result, findCalls, createCalls } = await runScanner({
      rows: [scanRow('scope_1')],
      findByScopeId: { scope_1: [{ id: 'ai_live', status: 'open', priority: 'critical' }] },
    });
    expect(findCalls).toHaveLength(1);
    expect(createCalls).toHaveLength(0);
    expect(result.outputs.skipped_existing).toBe(1);
    expect(result.outputs.created).toBe(0);
  });

  it('a find that only returns a resolved item still creates (resolved is not live)', async () => {
    const { result, createCalls } = await runScanner({
      rows: [scanRow('scope_1')],
      findByScopeId: { scope_1: [{ id: 'ai_dead', status: 'closed', priority: 'critical' }] },
    });
    expect(createCalls).toHaveLength(1);
    expect(result.outputs.created).toBe(1);
  });

  it('find failure: the create is skipped (not risked as a duplicate), counted as find_failed', async () => {
    const { result, createCalls } = await runScanner({
      rows: [scanRow('scope_1')],
      findFailScopeIds: ['scope_1'],
    });
    expect(createCalls).toHaveLength(0);
    expect(result.outputs.find_failed).toBe(1);
    expect(result.outputs.created).toBe(0);
  });

  // ── force (recalibration re-run) ──────────────────────────────────────

  it('force=true widens the bump set: an already-critical live item is re-PATCHed', async () => {
    const { result, bumpCalls } = await runScanner({
      inputs: { force: true },
      rows: [
        scanRow('scope_1', {
          existing_item_id: 'ai_c',
          existing_priority: 'critical',
          existing_status: 'open',
        }),
      ],
    });
    expect(bumpCalls).toHaveLength(1);
    expect((bumpCalls[0]?.body as { priority: string }).priority).toBe('critical');
    expect(result.outputs.candidates_bump).toBe(1);
    expect(result.outputs.prefiltered).toBe(0);
  });

  it('force omitted: an already-critical live item is prefiltered, not bumped', async () => {
    const { result, bumpCalls } = await runScanner({
      rows: [
        scanRow('scope_1', {
          existing_item_id: 'ai_c',
          existing_priority: 'critical',
          existing_status: 'open',
        }),
      ],
    });
    expect(bumpCalls).toHaveLength(0);
    expect(result.outputs.prefiltered).toBe(1);
  });

  // ── Failure isolation (forEach parallel absorption, engine gap) ────────
  //
  // forEach has no per-item fallback_step: a write failure that settles
  // (a permanent 4xx, or a 5xx whose per-iteration retries are exhausted) is
  // absorbed as `{}` in the aggregated results array rather than aborting the
  // sweep. Each post-pass pure step buckets the failure by index alignment (a
  // create/suggest with no body.id, a bump with no 2xx status). These tests
  // use a PERMANENT (4xx, retryable:false) failure so each settles after a
  // single attempt; the retryable-5xx and transient paths are covered in the
  // "per-iteration retry" block below.

  it('a create failure on one candidate does not kill the sweep: others still create, failure bucketed, index alignment survives (Finding D)', async () => {
    const { result, createCalls, suggestCalls } = await runScanner({
      rows: [scanRow('scope_1'), scanRow('scope_2'), scanRow('scope_3')],
      createFailScopeIds: ['scope_2'],
    });
    // Permanent 4xx → 1 attempt each, no retries.
    expect(createCalls).toHaveLength(3);
    expect(result.outputs.created).toBe(2);
    expect(result.outputs.create_failed).toBe(1);
    // A failed create drops its suggestion (no id to attach it to).
    expect(result.outputs.suggestion_created).toBe(2);
    // Positional pairing (Finding D): the two surviving suggestions attach to
    // the CORRECT new item ids (scope_1 → ai_scope_1, scope_3 → ai_scope_3) —
    // index alignment holds across the absorbed middle slot, never shifting
    // scope_3's suggestion onto scope_1's id or vice versa.
    const suggestPaths = suggestCalls.map((c) => String(c.path)).sort();
    expect(suggestPaths).toHaveLength(2);
    expect(suggestPaths[0]).toContain('ai_scope_1');
    expect(suggestPaths[1]).toContain('ai_scope_3');
    expect(suggestPaths.some((p) => p.includes('ai_scope_2'))).toBe(false);
  });

  it('a suggestion failure is bucketed without affecting the created item', async () => {
    const { result, createCalls, suggestCalls } = await runScanner({
      rows: [scanRow('scope_1')],
      suggestFailScopeIds: ['scope_1'],
    });
    expect(createCalls).toHaveLength(1);
    expect(suggestCalls).toHaveLength(1);
    expect(result.outputs.created).toBe(1);
    expect(result.outputs.suggestion_failed).toBe(1);
    expect(result.outputs.suggestion_created).toBe(0);
  });

  it('a bump failure is bucketed as bump_failed without killing the sweep', async () => {
    const { result, bumpCalls } = await runScanner({
      rows: [
        scanRow('scope_1', {
          existing_item_id: 'ai_hi',
          existing_priority: 'high',
          existing_status: 'open',
        }),
        scanRow('scope_2', {
          existing_item_id: 'ai_hi2',
          existing_priority: 'high',
          existing_status: 'open',
        }),
      ],
      bumpFailItemIds: ['ai_hi'],
    });
    expect(bumpCalls).toHaveLength(2);
    expect(result.outputs.bumped).toBe(1);
    expect(result.outputs.bump_failed).toBe(1);
  });

  it('create set exceeding the 200-row cap truncates the dispatched writes but reports the full candidate count', async () => {
    const rows = Array.from({ length: 210 }, (_, i) => scanRow(`scope_${i}`));
    const { result, createCalls } = await runScanner({ rows });
    expect(createCalls).toHaveLength(200);
    expect(result.outputs.truncated).toBe(true);
    expect(result.outputs.candidates_create).toBe(210);
  });

  // ── Per-iteration retry (failOnHttpError:true; only idempotent GET/PATCH) ──
  //
  // A >=400 is a real per-iteration failure. The idempotent find (GET) and
  // bump (PATCH) carry a retry_policy → a transient 5xx is retried; the
  // non-idempotent POSTs (create_item, create_suggestion) do NOT retry → a 5xx
  // settles after ONE attempt and is bucketed (avoids duplicate creates on a
  // lost-ack retry; a missed create self-heals next run). Also covers the
  // {status>=400} response-slot detection (belt-and-suspenders).

  it('transient 5xx on find (GET, idempotent): the retry loop re-dispatches and the create is confirmed', async () => {
    const { result, findCalls, createCalls } = await runScanner({
      rows: [scanRow('scope_1')],
      findTransientFails: { scope_1: 1 },
    });
    const scope1Finds = findCalls.filter(
      (c) => (c.query as Record<string, unknown>)['metadata.scope_id'] === 'scope_1',
    );
    expect(scope1Finds).toHaveLength(2); // 5xx then success
    expect(createCalls).toHaveLength(1);
    expect(result.outputs.created).toBe(1);
    expect(result.outputs.find_failed).toBe(0);
  });

  it('transient 5xx on bump (PATCH, idempotent): the retry loop re-dispatches and the bump succeeds', async () => {
    const { result, bumpCalls } = await runScanner({
      rows: [
        scanRow('scope_1', {
          existing_item_id: 'ai_hi',
          existing_priority: 'high',
          existing_status: 'open',
        }),
      ],
      bumpTransientFails: { ai_hi: 1 },
    });
    const aiHiBumps = bumpCalls.filter((c) => String(c.path).split('/').pop() === 'ai_hi');
    expect(aiHiBumps).toHaveLength(2); // 5xx then success
    expect(result.outputs.bumped).toBe(1);
    expect(result.outputs.bump_failed).toBe(0);
  });

  it('5xx on create (non-idempotent POST): NOT retried — a single attempt lands in create_failed, sweep survives', async () => {
    const { result, createCalls } = await runScanner({
      rows: [scanRow('scope_1'), scanRow('scope_2')],
      create5xxScopeIds: ['scope_1'],
    });
    const scope1Creates = createCalls.filter(
      (c) => (c.body as { metadata?: { scope_id?: string } }).metadata?.scope_id === 'scope_1',
    );
    // No retry_policy on the POST → exactly ONE dispatch for the failing item.
    expect(scope1Creates).toHaveLength(1);
    expect(result.outputs.created).toBe(1); // scope_2 still created
    expect(result.outputs.create_failed).toBe(1);
    expect(result.outputs.suggestion_created).toBe(1);
  });

  it('5xx on a suggestion (non-idempotent POST): NOT retried — one attempt → suggestion_failed; the item stays created', async () => {
    const { result, createCalls, suggestCalls } = await runScanner({
      rows: [scanRow('scope_1')],
      suggest5xxScopeIds: ['scope_1'],
    });
    expect(createCalls).toHaveLength(1);
    expect(suggestCalls).toHaveLength(1); // single attempt, no retry
    expect(result.outputs.created).toBe(1);
    expect(result.outputs.suggestion_failed).toBe(1);
    expect(result.outputs.suggestion_created).toBe(0);
  });

  it('exhausted 5xx retries on a bump land in bump_failed (3 attempts), the other bump survives', async () => {
    const { result, bumpCalls } = await runScanner({
      rows: [
        scanRow('scope_1', {
          existing_item_id: 'ai_hi',
          existing_priority: 'high',
          existing_status: 'open',
        }),
        scanRow('scope_2', {
          existing_item_id: 'ai_hi2',
          existing_priority: 'high',
          existing_status: 'open',
        }),
      ],
      bumpExhaustItemIds: ['ai_hi'],
    });
    const aiHiBumps = bumpCalls.filter((c) => String(c.path).split('/').pop() === 'ai_hi');
    expect(aiHiBumps).toHaveLength(3);
    expect(result.outputs.bumped).toBe(1);
    expect(result.outputs.bump_failed).toBe(1);
  });

  it('response-slot shape ({status:500}, no body.id) is bucketed as create_failed without retrying (belt-and-suspenders)', async () => {
    const { result, createCalls } = await runScanner({
      rows: [scanRow('scope_1'), scanRow('scope_2'), scanRow('scope_3')],
      createHttpErrorSlotScopeIds: ['scope_2'],
    });
    // A SUCCESS result carrying a >=400 status is not a failure to the runner,
    // so it is NOT retried — one dispatch per candidate.
    expect(createCalls).toHaveLength(3);
    expect(result.outputs.created).toBe(2);
    // zip_ids buckets the {status:500} slot by its missing body.id.
    expect(result.outputs.create_failed).toBe(1);
  });

  it('permanent 4xx on find still skips the create (no retry), counted as find_failed', async () => {
    const { result, findCalls, createCalls } = await runScanner({
      rows: [scanRow('scope_1')],
      findFailScopeIds: ['scope_1'],
    });
    // 4xx is non-retryable → a single find attempt, then skip.
    expect(findCalls).toHaveLength(1);
    expect(createCalls).toHaveLength(0);
    expect(result.outputs.find_failed).toBe(1);
    expect(result.outputs.created).toBe(0);
  });
});

// ── wf-r4-apply ───────────────────────────────────────────────────────

describe('wf-r4-apply (shape)', () => {
  it('parses + validates', async () => {
    const def = await loadYaml(FILES.apply);
    expect(def.id).toBe('runtime_lifecycle_apply');
    expect(Object.keys(def.steps ?? {}).length).toBeGreaterThan(0);
  });

  it('signal-wait uses onTimeout continue (no timeout port on connections)', async () => {
    const raw = await readFile(join(DIR, FILES.apply), 'utf8');
    const parsed = parseYamlDocument(raw);
    // normalizeWorkflowDocument renames `source_port` -> `sourcePort`
    // (packages/dsl/src/yaml/normalize.ts KEY_RENAMES) — read the
    // POST-normalization field name or this check silently no-ops.
    const normalized = normalizeWorkflowDocument(parsed.document) as unknown as {
      connections?: { sourcePort?: string }[];
    };
    for (const c of normalized.connections ?? []) {
      expect(c.sourcePort).not.toBe('timeout');
    }
    expect(raw).toMatch(/onTimeout:\s*continue/);
  });

  it('every resolve_*_failure node has EXACTLY ONE declared, permanently-false incoming edge (fallback target, never a normal successor)', async () => {
    // A shared resolve node fed by more than one fallback_step source can
    // never become ready: the engine's fallback dispatch (workflow-runner.ts,
    // `errorHandling.fallbackStep` branch) marks only the actually-failed
    // edge settled, then asks the join coordinator to evaluate the target —
    // with the default `all` strategy the other declared-but-never-
    // exercised edges stay unsettled forever, and `any` explicitly excludes
    // FAILED edges from satisfying it (CLAUDE.md join-strategy notes), so
    // NEITHER strategy is ever ready. Confirmed empirically (a shared node
    // never fired in a live debug run) — this is why fetch_item/
    // fetch_suggestion/fetch_scope/fetch_catalog each get their OWN
    // dedicated resolve_fetch_*_failure node instead of one shared node.
    const raw = await readFile(join(DIR, FILES.apply), 'utf8');
    const parsed = parseYamlDocument(raw);
    const normalized = normalizeWorkflowDocument(parsed.document) as unknown as {
      connections?: { to?: string; condition?: string }[];
    };
    const conns = normalized.connections ?? [];
    for (const target of [
      'resolve_failure',
      'resolve_fetch_item_failure',
      'resolve_fetch_suggestion_failure',
      'resolve_fetch_scope_failure',
    ]) {
      const incoming = conns.filter((c) => c.to === target);
      expect(incoming, `${target} incoming edges`).toHaveLength(1);
      expect(incoming[0]!.condition, `${target} incoming edge condition`).toBe('false');
    }
  });
});

describe('np-api-call inputs shield (regression, every wf-r*.yaml)', () => {
  it('every np-api-call step declares a non-empty inputs: block', async () => {
    // Live E2E finding on a demo org: np-api-call's execute() does
    // `cfg = {...config, ...ctx.inputs}` (inputs OVERRIDE config), and
    // when a step declares no `inputs:` map the engine falls back to
    // passing the single upstream predecessor's raw output object through
    // as `ctx.inputs` (workflow-runner.ts `hasExplicitInputs`). Chained
    // after another np-api-call step, that upstream output is
    // `{status, body, headers}` — its RESPONSE headers clobber this
    // step's REQUEST headers and undici throws "fetch failed". Plugin
    // STUBS in this test file cannot catch this class of bug (they bypass
    // the real np-api-call plugin's config/input merge entirely, which is
    // exactly why 69 green stub-based tests missed it) — this is a static
    // shape check instead, over every wf-r*.yaml in the suite.
    const files = (await readdir(DIR)).filter((f) => /^wf-r\d.*\.yaml$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const def = await loadYaml(file);
      for (const step of Object.values(
        (def.steps ?? {}) as Record<
          string,
          {
            id?: string;
            pluginType?: string;
            inputs?: Record<string, unknown>;
            forEach?: { spreadItem?: boolean };
          }
        >,
      )) {
        if (step.pluginType !== 'np-api-call') continue;
        // A forEach + spreadItem step gets its per-iteration inputs from the
        // spread item (the runner resolves `step.inputs ?? {}` and never falls
        // back to the predecessor output for a forEach step), so the
        // predecessor-clobber bug this guard catches cannot occur — it carries
        // a config-level failOnHttpError shield instead of a declared input.
        if (step.forEach?.spreadItem === true) continue;
        expect(
          step.inputs && Object.keys(step.inputs).length > 0,
          `${file}: np-api-call step '${step.id}' has no declared (non-empty) inputs: block`,
        ).toBe(true);
      }
    }
  });
});

const DEFAULT_APPLY_ITEM = {
  id: 'ai-42',
  status: 'open',
  metadata: {
    scope_id: '777',
    environment: 'development',
    target_runtime: 'nodejs20.x',
    current_runtime: 'nodejs18.x',
  },
};
const DEFAULT_APPLY_SUGGESTION = {
  id: 'sug-7',
  metadata: { to_runtime: 'nodejs20.x' },
  user_metadata: { deploy_timing: 'deploy-now' },
};
const DEFAULT_APPLY_SCOPE = {
  id: 777,
  capabilities: { serverless_runtime: { id: 'nodejs18.x', memory: 512, timeout: 30 } },
};

interface ApplyStubOpts {
  item?: Record<string, unknown>;
  suggestion?: Record<string, unknown>;
  scope?: Record<string, unknown>;
  /** HTTP status the scope PATCH returns (default 200). */
  patchStatus?: number;
  /** Outcome the stubbed progressive_deploy sub-workflow reports. */
  progressiveOutcome?: Record<string, unknown>;
  /**
   * Simulate one of fetch_item/fetch_suggestion/fetch_scope failing (e.g. the
   * live E2E's "fetch failed" network error) instead of resolving normally —
   * exercises error_handling.fallback_step -> resolve_fetch_failure. v4 no
   * longer fetches the catalog (no re-validation).
   */
  failStep?: 'fetch_item' | 'fetch_suggestion' | 'fetch_scope';
}

interface CommentCall {
  stepId: string;
  inputs: Record<string, unknown>;
}
interface UpdateCall {
  stepId: string;
  inputs: Record<string, unknown>;
}

const stepFailure = (message: string): IStepResult => ({
  status: 'failure',
  error: { message, code: 'NP_API_NETWORK', retryable: true },
});

/**
 * A PERMANENT (4xx, `retryable: false`) failure — the per-iteration retry
 * loop classifies it as non-retryable and settles it after ONE attempt (no
 * backoff), mirroring np-api-call's `failOnHttpError` shape for a 4xx.
 */
const stepFailurePermanent = (message: string): IStepResult => ({
  status: 'failure',
  error: { message, code: 'NP_API_404', retryable: false },
});

async function runApply(opts: ApplyStubOpts) {
  const patches: Record<string, unknown>[] = [];
  const comments: CommentCall[] = [];
  const suggestionUpdates: UpdateCall[] = [];
  const itemUpdates: UpdateCall[] = [];
  let progressiveCalls = 0;
  const result = await runWorkflowE2E({
    yamlPath: resolve(DIR, FILES.apply),
    inputs: { action_item_id: 'ai-42', suggestion_id: 'sug-7' },
    pluginStubs: {
      manual: passthroughTrigger,
      'np-action-item-get': {
        handler: () =>
          opts.failStep === 'fetch_item'
            ? stepFailure('fetch failed: network error reading the action item')
            : ok({ actionItem: opts.item ?? DEFAULT_APPLY_ITEM }),
        executeMode: 'all' as const,
      },
      'np-api-call': {
        handler: (ctx: { stepId: string; inputs: Record<string, unknown> }) => {
          if (opts.failStep === ctx.stepId) {
            return stepFailure(`fetch failed: network error on ${ctx.stepId}`);
          }
          switch (ctx.stepId) {
            case 'fetch_suggestion':
              return ok({ status: 200, body: opts.suggestion ?? DEFAULT_APPLY_SUGGESTION });
            case 'fetch_scope':
              return ok({ status: 200, body: opts.scope ?? DEFAULT_APPLY_SCOPE });
            case 'patch_scope':
              patches.push(ctx.inputs.payload as Record<string, unknown>);
              return ok({
                status: opts.patchStatus ?? 200,
                body:
                  opts.patchStatus && opts.patchStatus >= 400
                    ? { message: 'Blocked by approval policy' }
                    : {},
              });
            default:
              throw new Error(`unexpected np-api-call step: ${ctx.stepId}`);
          }
        },
        executeMode: 'all' as const,
      },
      'sub-workflow': {
        handler: () => {
          progressiveCalls++;
          return ok(
            (opts.progressiveOutcome ?? {
              status: 'deployed',
              deployment_id: '9001',
              detail: 'finalized',
            }) as Record<string, unknown>,
          );
        },
        executeMode: 'all' as const,
      },
      'np-action-item-add-comment': {
        handler: (ctx: { stepId: string; inputs: Record<string, unknown> }) => {
          comments.push({ stepId: ctx.stepId, inputs: ctx.inputs });
          return ok({ commentId: 'c1', comment: {} });
        },
        executeMode: 'all' as const,
      },
      'np-action-item-suggestion-update': {
        handler: (ctx: { stepId: string; inputs: Record<string, unknown> }) => {
          suggestionUpdates.push({ stepId: ctx.stepId, inputs: ctx.inputs });
          return ok({ suggestion: {}, status: 'ok' });
        },
        executeMode: 'all' as const,
      },
      'np-action-item-update': {
        handler: (ctx: { stepId: string; inputs: Record<string, unknown> }) => {
          itemUpdates.push({ stepId: ctx.stepId, inputs: ctx.inputs });
          return ok({ actionItem: {} });
        },
        executeMode: 'all' as const,
      },
      'signal-wait': {
        // deploy_at (if any) always "arrives" — onTimeout: continue.
        handler: () => ok({ timedOut: true, payload: null }),
        executeMode: 'all' as const,
      },
    },
  });
  return { result, patches, comments, suggestionUpdates, itemUpdates, progressiveCalls };
}

describe('wf-r4-apply (E2E)', () => {
  it('dev deploy-now: PATCHes the full serverless_runtime object (only id swapped), stamps runtime_patched_at, and deploys', async () => {
    const { result, patches, itemUpdates, suggestionUpdates, progressiveCalls } = await runApply(
      {},
    );

    expect(patches).toHaveLength(1);
    expect(patches[0]).toEqual({
      capabilities: { serverless_runtime: { id: 'nodejs20.x', memory: 512, timeout: 30 } },
    });

    expect(progressiveCalls).toBe(1);

    const stamp = itemUpdates.find((u) => u.stepId === 'patch_item_metadata');
    expect(stamp).toBeDefined();
    const stampedMeta = stamp!.inputs.metadata as Record<string, unknown>;
    // Merge, don't clobber: existing keys survive alongside the new stamp.
    expect(stampedMeta.scope_id).toBe('777');
    expect(stampedMeta.environment).toBe('development');
    expect(typeof stampedMeta.runtime_patched_at).toBe('string');
    expect(() => new Date(stampedMeta.runtime_patched_at as string).toISOString()).not.toThrow();

    const applied = suggestionUpdates.find((u) => u.stepId === 'mark_applied_deploy');
    expect(applied).toBeDefined();
    expect(applied!.inputs.fr).toBe('nodejs18.x');
    expect(applied!.inputs.tr).toBe('nodejs20.x');
    expect(applied!.inputs.did).toBe('9001');

    expect(result.outputs.status).toBe('deployed');
    expect(result.outputs.deployment_id).toBe('9001');
    expect(result.outputs.from_runtime).toBe('nodejs18.x');
    expect(result.outputs.to_runtime).toBe('nodejs20.x');
  });

  it('production: a tampered deploy-now accept answer is forced to apply-only — PATCH applied, no deploy', async () => {
    const { result, patches, progressiveCalls, comments, suggestionUpdates } = await runApply({
      item: {
        id: 'ai-42',
        status: 'open',
        metadata: { scope_id: '777', environment: 'production', target_runtime: 'nodejs20.x' },
      },
      // Tampered client-side: production must never honor this.
      suggestion: {
        id: 'sug-7',
        metadata: { to_runtime: 'nodejs20.x' },
        user_metadata: { deploy_timing: 'deploy-now' },
      },
    });

    expect(patches).toHaveLength(1);
    expect(progressiveCalls).toBe(0);

    const applyComment = comments.find((c) => c.stepId === 'comment_apply_only');
    expect(applyComment).toBeDefined();
    expect(String(applyComment!.inputs.text)).toMatch(/apply-only/i);

    const applied = suggestionUpdates.find((u) => u.stepId === 'mark_applied_only');
    expect(applied).toBeDefined();
    expect(applied!.inputs.fr).toBe('nodejs18.x');
    expect(applied!.inputs.tr).toBe('nodejs20.x');

    expect(result.outputs.status).toBe('applied-no-deploy');
    expect(result.outputs.deployment_id).toBeNull();
  });

  // v4: the old "target no longer supported in the live catalog" and "already
  // on target" compute_plan guards are GONE (no live-catalog re-validation).
  // A stale target self-heals on the next daily scan. The one remaining
  // compute_plan failure is "no target at all" (covered below).

  it('no migration target on the suggestion/item: compute_plan fails, suggestion marked failed, NO scope PATCH', async () => {
    const { result, patches, suggestionUpdates, itemUpdates } = await runApply({
      item: {
        id: 'ai-42',
        status: 'open',
        metadata: { scope_id: '777', environment: 'development' },
      },
      suggestion: { id: 'sug-7', metadata: {}, user_metadata: { deploy_timing: 'deploy-now' } },
    });

    expect(patches).toHaveLength(0);
    expect(itemUpdates).toHaveLength(0);

    const failed = suggestionUpdates.find((u) => u.stepId === 'mark_suggestion_failed');
    expect(failed).toBeDefined();
    expect(String(failed!.inputs.errmsg)).toMatch(/no migration target/i);

    expect(result.outputs.status).toBe('failed');
  });

  it('a blocked scope PATCH marks the suggestion failed and never stamps the item', async () => {
    const { result, comments, suggestionUpdates, itemUpdates } = await runApply({
      patchStatus: 403,
    });

    const blockedComment = comments.find((c) => c.stepId === 'comment_patch_blocked');
    expect(blockedComment).toBeDefined();

    const failed = suggestionUpdates.find((u) => u.stepId === 'mark_failed_patch_blocked');
    expect(failed).toBeDefined();
    expect(itemUpdates.find((u) => u.stepId === 'patch_item_metadata')).toBeUndefined();

    expect(result.outputs.status).toBe('blocked');
  });

  // Live E2E finding: fetch_scope failed deterministically (see the
  // np-api-call inputs-shield fix above) and, before this fix, that left
  // the suggestion stuck 'approved' with zero human-visible feedback —
  // there was no fallback wired from the fetch_* steps at all. Covers
  // every fetch_* step's OWN dedicated error_handling.fallback_step ->
  // resolve_fetch_<step>_failure (a SHARED resolve node across all four
  // was tried first and never fires — see the shape test above).
  const RESOLVE_NODE_BY_FETCH_STEP = {
    fetch_item: 'resolve_fetch_item_failure',
    fetch_suggestion: 'resolve_fetch_suggestion_failure',
    fetch_scope: 'resolve_fetch_scope_failure',
  } as const;

  it.each(['fetch_item', 'fetch_suggestion', 'fetch_scope'] as const)(
    '%s failing marks the suggestion failed, comments on the item, and never PATCHes the scope',
    async (failStep) => {
      const { result, patches, comments, suggestionUpdates, itemUpdates, progressiveCalls } =
        await runApply({ failStep });

      expect(patches).toHaveLength(0);
      expect(itemUpdates).toHaveLength(0);
      expect(progressiveCalls).toBe(0);

      const failedComment = comments.find((c) => c.stepId === RESOLVE_NODE_BY_FETCH_STEP[failStep]);
      expect(failedComment).toBeDefined();
      expect(String(failedComment!.inputs.errmsg)).toMatch(/fetch failed/i);

      const failed = suggestionUpdates.find((u) => u.stepId === 'mark_suggestion_failed');
      expect(failed).toBeDefined();
      expect(String(failed!.inputs.errmsg)).toMatch(/fetch failed/i);

      expect(result.outputs.status).toBe('failed');
    },
  );
});

// ── wf-r3-events (router + resolve gate + comment answerer) ─────────────

const EVENTS_TRIGGER_OUTPUT_PORTS = [
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

// Reused across the resolve-gate and comment-answerer fixtures below.
const EVENTS_CATALOG = {
  runtimes: [
    {
      id: 'nodejs20.x',
      language: 'nodejs',
      version: '20',
      status: 'supported',
      deprecation_date: null,
    },
    {
      id: 'nodejs16.x',
      language: 'nodejs',
      version: '16',
      status: 'deprecated',
      deprecation_date: daysFromNow(-400),
    },
  ],
};

interface EventsOpts {
  inputs: Record<string, unknown>;
  scope?: Record<string, unknown>;
  deployments?: Record<string, unknown>[];
  catalog?: Record<string, unknown>;
  comments?: Record<string, unknown>[];
  aiAnswer?: Record<string, unknown>;
}

interface RecordedCall {
  stepId: string;
  inputs: Record<string, unknown>;
}

async function runEvents(opts: EventsOpts) {
  const started: Record<string, unknown>[] = [];
  const comments: RecordedCall[] = [];
  const reopens: RecordedCall[] = [];
  const aiCalls: Record<string, unknown>[] = [];
  const result = await runWorkflowE2E({
    yamlPath: resolve(DIR, FILES.events),
    inputs: opts.inputs,
    pluginStubs: {
      'np-action-item-trigger': {
        handler: () => ok({}),
        registryType: 'trigger' as const,
        outputPorts: EVENTS_TRIGGER_OUTPUT_PORTS,
      },
      'sub-workflow': {
        handler: (ctx: { inputs: Record<string, unknown> }) => {
          started.push(ctx.inputs);
          return ok({ _childExecutionId: 'child-1' });
        },
        executeMode: 'all' as const,
      },
      'np-api-call': {
        handler: (ctx: { stepId: string }) => {
          switch (ctx.stepId) {
            case 'gate_fetch_scope':
            case 'fetch_scope_qa':
              return ok({ status: 200, body: opts.scope ?? {} });
            case 'gate_fetch_deployments':
              return ok({ status: 200, body: { results: opts.deployments ?? [] } });
            case 'gate_fetch_catalog':
            case 'fetch_catalog_qa':
              return ok({ status: 200, body: opts.catalog ?? EVENTS_CATALOG });
            case 'fetch_comments':
              return ok({ status: 200, body: { results: opts.comments ?? [] } });
            default:
              throw new Error(`unexpected np-api-call step: ${ctx.stepId}`);
          }
        },
        executeMode: 'all' as const,
      },
      'np-action-item-add-comment': {
        handler: (ctx: { stepId: string; inputs: Record<string, unknown> }) => {
          comments.push({ stepId: ctx.stepId, inputs: ctx.inputs });
          return ok({ commentId: 'c1', comment: {} });
        },
        executeMode: 'all' as const,
      },
      'np-action-item-update': {
        handler: (ctx: { stepId: string; inputs: Record<string, unknown> }) => {
          reopens.push({ stepId: ctx.stepId, inputs: ctx.inputs });
          return ok({ actionItem: {}, status: 'open' });
        },
        executeMode: 'all' as const,
      },
      'claude-code-agent': {
        handler: (ctx: { inputs: Record<string, unknown> }) => {
          aiCalls.push(ctx.inputs);
          return ok(
            (opts.aiAnswer as Record<string, unknown>) ?? { answer: 'Here is the answer.' },
          );
        },
        executeMode: 'all' as const,
      },
    },
  });
  return { result, started, comments, reopens, aiCalls };
}

describe('wf-r3-events (shape)', () => {
  it('parses + validates', async () => {
    const def = await loadYaml(FILES.events);
    expect(def.id).toBe('runtime_lifecycle_events');
    expect(Object.keys(def.steps ?? {}).length).toBeGreaterThan(0);
  });

  it('trigger filters to lambda-runtime items; QA cap var + agent author referenced', async () => {
    const raw = await readFile(join(DIR, FILES.events), 'utf8');
    expect(raw).toMatch(/pathPrefix:\s*np-runtime-lifecycle-events/);
    expect(raw).toMatch(/workflow_type:\s*lambda-runtime/);
    expect(raw).toMatch(/RUNTIME_QA_MAX_REPLIES/);
    expect(raw).toMatch(/agent:runtime-lifecycle/);
    expect(raw).toMatch(/workflowId:\s*runtime_lifecycle_apply/);
  });

  it('non-compliant resolution comments (never reopens): the false branch is a comment step whose content promises a NEW item, and no step ever reopens', async () => {
    const raw = await readFile(join(DIR, FILES.events), 'utf8');
    const def = await loadYaml(FILES.events);
    const steps = def.steps as unknown as Record<string, { pluginType?: string }>;

    // The non-compliant path posts a comment, it does NOT reopen — the
    // np-action-item-update / reopen plugin must not appear anywhere.
    expect(raw).not.toMatch(/np-action-item-update/);
    expect(raw).not.toMatch(/action:\s*reopen/);
    expect(steps.reopen_item).toBeUndefined();

    // The false branch of the compliance decider lands on the comment step.
    const conns = (def.connections ?? []) as unknown as {
      from: string;
      to: string;
      sourcePort?: string;
    }[];
    const falseBranch = conns.find((c) => c.from === 'gate_compliant' && c.sourcePort === 'false');
    expect(falseBranch?.to).toBe('comment_not_verified');
    expect(steps.comment_not_verified?.pluginType).toBe('np-action-item-add-comment');

    // The comment content states the item stays resolved AND a new item is
    // opened automatically by the (daily) scan.
    expect(raw).toMatch(/comment_not_verified/);
    expect(raw).toMatch(/stays \*\*resolved\*\*/);
    expect(raw).toMatch(/open a NEW action item/);
  });
});

describe('wf-r3-events (E2E)', () => {
  it('suggestion accepted: starts the apply workflow with the right ids', async () => {
    const { started } = await runEvents({
      inputs: {
        _activePort: 'onSuggestionAccepted',
        actionItem: { id: 'ai-1' },
        suggestion: { id: 'sug-1' },
        userEmail: 'dev@demo.org',
      },
    });
    expect(started).toHaveLength(1);
    expect(started[0]!.action_item_id).toBe('ai-1');
    expect(started[0]!.suggestion_id).toBe('sug-1');
  });

  it('resolve gate: runtime still deprecated → NO reopen; a comment states the missing runtime + the new-item notice, status untouched', async () => {
    const { reopens, comments } = await runEvents({
      inputs: {
        _activePort: 'onResolved',
        actionItem: { id: 'ai-2', metadata: { scope_id: 'scope-2' } },
      },
      scope: {
        id: 'scope-2',
        capabilities: { serverless_runtime: { id: 'nodejs16.x' } },
        updated_at: '2020-01-01T00:00:00Z',
      },
      deployments: [],
    });
    // A resolved item is NEVER reopened (the platform API forbids it) — the
    // np-action-item-update path must not fire at all.
    expect(reopens).toHaveLength(0);
    const notVerified = comments.find((c) => c.stepId === 'comment_not_verified');
    expect(notVerified).toBeDefined();
    expect(notVerified!.inputs.item_id).toBe('ai-2');
    // The diagnostic (what's still missing) names the deprecated runtime. The
    // static "new item will be opened" notice lives in the step's config
    // content template (invisible to the stub, which only sees resolved
    // inputs) — it is asserted against the raw YAML in the shape block below.
    expect(String(notVerified!.inputs.reason)).toMatch(/nodejs16\.x/);
    expect(comments.find((c) => c.stepId === 'comment_confirm')).toBeUndefined();
  });

  it('resolve gate: config fixed but active deployment predates the patch → NO reopen; a comment names the missing deploy', async () => {
    const { reopens, comments } = await runEvents({
      inputs: {
        _activePort: 'onResolved',
        actionItem: {
          id: 'ai-3',
          metadata: { scope_id: 'scope-3', runtime_patched_at: '2026-07-15T00:00:00Z' },
        },
      },
      scope: {
        id: 'scope-3',
        capabilities: { serverless_runtime: { id: 'nodejs20.x' } },
        updated_at: '2020-01-01T00:00:00Z',
      },
      deployments: [
        { id: 'd1', status: 'finalized', status_in_scope: 'active', created_at: '2026-07-01T00:00:00Z' },
      ],
    });
    expect(reopens).toHaveLength(0);
    const notVerified = comments.find((c) => c.stepId === 'comment_not_verified');
    expect(notVerified).toBeDefined();
    expect(String(notVerified!.inputs.reason)).toMatch(/deploy/i);
  });

  it('resolve gate: fresh active deploy that is NOT finalized (failed/in-flight) is not evidence → non-compliant comment', async () => {
    // Live lake data 2026-07-21: failed/deleted/deleting deployments can still
    // read status_in_scope 'active'. Only finalized counts (owner rule).
    const { reopens, comments } = await runEvents({
      inputs: {
        _activePort: 'onResolved',
        actionItem: {
          id: 'ai-3b',
          metadata: { scope_id: 'scope-3', runtime_patched_at: '2026-07-01T00:00:00Z' },
        },
      },
      scope: {
        id: 'scope-3',
        capabilities: { serverless_runtime: { id: 'nodejs20.x' } },
        updated_at: '2020-01-01T00:00:00Z',
      },
      deployments: [
        { id: 'd1', status: 'failed', status_in_scope: 'active', created_at: '2026-07-10T00:00:00Z' },
      ],
    });
    expect(reopens).toHaveLength(0);
    const notVerified = comments.find((c) => c.stepId === 'comment_not_verified');
    expect(notVerified).toBeDefined();
    expect(String(notVerified!.inputs.reason)).toMatch(/FINALIZED|deploy/i);
    expect(comments.find((c) => c.stepId === 'comment_confirm')).toBeUndefined();
  });

  it('resolve gate: config fixed and the active deploy is fresh → stays resolved, confirmation comment only', async () => {
    const { reopens, comments } = await runEvents({
      inputs: {
        _activePort: 'onResolved',
        actionItem: {
          id: 'ai-4',
          metadata: { scope_id: 'scope-4', runtime_patched_at: '2026-07-01T00:00:00Z' },
        },
      },
      scope: {
        id: 'scope-4',
        capabilities: { serverless_runtime: { id: 'nodejs20.x' } },
        updated_at: '2020-01-01T00:00:00Z',
      },
      deployments: [
        { id: 'd1', status: 'finalized', status_in_scope: 'active', created_at: '2026-07-10T00:00:00Z' },
      ],
    });
    expect(reopens).toHaveLength(0);
    const confirm = comments.find((c) => c.stepId === 'comment_confirm');
    expect(confirm).toBeDefined();
    expect(String(confirm!.inputs.reason)).toMatch(/nodejs20\.x/);
    expect(comments.find((c) => c.stepId === 'comment_not_verified')).toBeUndefined();
  });

  it('comment from an agent author: no ack, no AI answer', async () => {
    const { comments, aiCalls, reopens } = await runEvents({
      inputs: {
        _activePort: 'onCommentAdded',
        actionItem: { id: 'ai-5', metadata: { scope_id: 'scope-5' } },
        userEmail: 'agent:runtime-lifecycle',
      },
    });
    expect(comments).toHaveLength(0);
    expect(aiCalls).toHaveLength(0);
    expect(reopens).toHaveLength(0);
  });

  it('human comment under the reply cap: ack posted, then a fact-grounded AI answer is posted', async () => {
    const { comments, aiCalls } = await runEvents({
      inputs: {
        _activePort: 'onCommentAdded',
        actionItem: {
          id: 'ai-6',
          title: 'Lambda runtime nodejs16.x is deprecated',
          description: 'Migrate to nodejs20.x.',
          metadata: { scope_id: 'scope-6' },
        },
        userEmail: 'dev@demo.org',
      },
      scope: { id: 'scope-6', capabilities: { serverless_runtime: { id: 'nodejs16.x' } } },
      comments: [{ author: 'dev@demo.org', content: 'Why is this deprecated already?' }],
    });

    const ack = comments.find((c) => c.stepId === 'post_ack');
    expect(ack).toBeDefined();
    expect(String(ack!.inputs.author_asked)).toBe('dev@demo.org');

    expect(aiCalls).toHaveLength(1);
    expect(aiCalls[0]!.question).toBe('Why is this deprecated already?');
    expect(aiCalls[0]!.question_author).toBe('dev@demo.org');
    expect((aiCalls[0]!.catalog_row as { id: string }).id).toBe('nodejs16.x');
    expect((aiCalls[0]!.scope_facts as { runtime: string }).runtime).toBe('nodejs16.x');

    const answer = comments.find((c) => c.stepId === 'post_answer');
    expect(answer).toBeDefined();
    expect(answer!.inputs.text).toBe('Here is the answer.');
  });

  it('reply cap reached: no ack, no AI answer', async () => {
    const priorReplies = Array.from({ length: 3 }, (_, i) => ({
      author: 'agent:runtime-lifecycle',
      content: `reply ${i}`,
    }));
    const { comments, aiCalls } = await runEvents({
      inputs: {
        _activePort: 'onCommentAdded',
        actionItem: { id: 'ai-7', metadata: { scope_id: 'scope-7' } },
        userEmail: 'dev@demo.org',
      },
      comments: [...priorReplies, { author: 'dev@demo.org', content: 'one more question' }],
    });
    expect(comments).toHaveLength(0);
    expect(aiCalls).toHaveLength(0);
  });
});

// ── wf-r5-closer — lake-first, verdict IN-QUERY, FLAT writes ─────────────
//
// v4: the closeability VERDICT is computed IN THE LAKE QUERY (close_compliant
// / close_scope_gone / still_open). There is NO live fetch_scope /
// fetch_deployments / verdicts re-verification pass and no separate catalog
// read — `prep` reads the verdict, double-guards the human-owned + stray
// cases, and builds the close requests; then close_item → zip_closed →
// close_comment run flat via forEach spreadItem. So the closer stubs only
// drive close_item / close_comment; the injected lake rows carry the verdict.

// One lake_candidates row as the in-query verdict step returns it. Defaults to
// an OPEN item whose verdict is `still_open`; override `verdict` to
// 'close_scope_gone' / 'close_compliant', `item_status` for the human-owned
// path, or `scope_id: ''` for a stray.
function closerLakeRow(itemId: string, overrides: Record<string, unknown> = {}) {
  return {
    item_id: itemId,
    item_status: 'open',
    scope_id: `scope_${itemId}`,
    live_runtime: 'nodejs16.x',
    verdict: 'still_open',
    ...overrides,
  };
}

interface CloserOpts {
  rows?: Record<string, unknown>[];
  /** item ids whose close_item PERMANENTLY (4xx) fails → close_failed. */
  closeFailItemIds?: string[];
  /** item ids whose close_comment PERMANENTLY (4xx) fails → comment_failed. */
  commentFailItemIds?: string[];
}

function parseCloserItemId(path: string, verb: 'close' | 'comments'): string {
  const m = path.match(new RegExp(`action_item\\/([^/]+)\\/${verb}`));
  return m ? m[1]! : '';
}

async function runCloser(opts: CloserOpts) {
  const closeCalls: { itemId: string; inputs: Record<string, unknown> }[] = [];
  const commentCalls: { itemId: string; inputs: Record<string, unknown> }[] = [];
  const rows = opts.rows ?? [];
  const result = await runWorkflowE2E({
    yamlPath: resolve(DIR, FILES.closer),
    inputs: {},
    pluginStubs: {
      manual: passthroughTrigger,
      cron: passthroughTrigger,
      'np-lake-query': {
        handler: () => ok({ rows, rowCount: rows.length }),
        executeMode: 'all' as const,
      },
      'np-api-call': {
        handler: (ctx: { stepId: string; inputs: Record<string, unknown> }): IStepResult => {
          if (ctx.stepId === 'close_item') {
            const itemId = parseCloserItemId(String(ctx.inputs.path ?? ''), 'close');
            closeCalls.push({ itemId, inputs: ctx.inputs });
            if ((opts.closeFailItemIds ?? []).includes(itemId)) {
              return stepFailurePermanent(`close failed for ${itemId}`);
            }
            return ok({ status: 200, body: { id: itemId, status: 'closed' } });
          }
          if (ctx.stepId === 'close_comment') {
            const itemId = parseCloserItemId(String(ctx.inputs.path ?? ''), 'comments');
            commentCalls.push({ itemId, inputs: ctx.inputs });
            if ((opts.commentFailItemIds ?? []).includes(itemId)) {
              return stepFailurePermanent(`comment failed for ${itemId}`);
            }
            return ok({ status: 200, body: { id: `c_${itemId}` } });
          }
          return ok({ status: 200, body: {} });
        },
        executeMode: 'all' as const,
      },
    },
  });
  return { result, closeCalls, commentCalls };
}

describe('wf-r5-closer (shape)', () => {
  it('parses + validates', async () => {
    const def = await loadYaml(FILES.closer);
    expect(def.id).toBe('runtime_lifecycle_closer');
    expect(Object.keys(def.steps ?? {}).length).toBeGreaterThan(0);
  });

  it('one lake query with the verdict in-query, daily 08:00 Buenos Aires, flat spreadItem passes (no fetch/verdicts pass, no sub-workflow child)', async () => {
    const raw = await readFile(join(DIR, FILES.closer), 'utf8');
    expect(raw).toMatch(/plugin_type:\s*np-lake-query/);
    expect(raw).toMatch(/governance_action_items_action_items/);
    expect(raw).toMatch(/lambda_runtimes/);
    expect(raw).toMatch(/core_entities_deployment/);
    // v4: the close verdict is computed in-query.
    expect(raw).toMatch(/AS verdict/);
    expect(raw).toMatch(/schedule:\s*"0 8 \* \* \*"/);
    expect(raw).toMatch(/America\/Argentina\/Buenos_Aires/);
    expect(raw).toMatch(/spreadItem:\s*true/);
    expect(raw).toMatch(/parallel:\s*true/);
    // v4: no live re-verification pass and no catalog read.
    expect(raw).not.toMatch(/id: fetch_scope/);
    expect(raw).not.toMatch(/id: fetch_deployments/);
    expect(raw).not.toMatch(/id: verdicts/);
    expect(raw).not.toMatch(/id: read_catalog/);
    // The retired sub-workflow child and streaming scaffolding must be GONE.
    expect(raw).not.toMatch(/plugin_type:\s*sub-workflow/);
    expect(raw).not.toMatch(/runtime_lifecycle_verify_item/);
    expect(raw).not.toMatch(/np-entity-paginated-fetch/);
  });

  it('no step declares error_handling.fallback_step (forEach does not honor it — structural check)', async () => {
    const def = await loadYaml(FILES.closer);
    for (const step of Object.values(
      (def.steps ?? {}) as Record<string, { errorHandling?: { fallbackStep?: unknown } }>,
    )) {
      expect(step.errorHandling?.fallbackStep).toBeUndefined();
    }
  });

  it('write passes are failOnHttpError:true + no retry, forEach spreadItem parallel', async () => {
    const def = await loadYaml(FILES.closer);
    const steps = def.steps as unknown as Record<
      string,
      {
        pluginType?: string;
        forEach?: { spreadItem?: boolean; parallel?: boolean };
        inputs?: Record<string, unknown>;
        config?: { failOnHttpError?: unknown };
        errorHandling?: { retryPolicy?: { maxAttempts?: number } };
      }
    >;
    // v4 has only write passes (no live-verification reads). Both turn a >=400
    // into a real per-iteration failure and do NOT retry (a lost-ack
    // close/comment retry re-hits the same item).
    for (const id of ['close_item', 'close_comment']) {
      const step = steps[id];
      expect(step, id).toBeDefined();
      expect(step?.pluginType).toBe('np-api-call');
      expect(step?.forEach?.spreadItem, `${id} spreadItem`).toBe(true);
      expect(step?.forEach?.parallel, `${id} parallel`).toBe(true);
      expect(Object.keys(step?.inputs ?? {}), `${id} inputs`).toEqual([]);
      expect(step?.config?.failOnHttpError, `${id} failOnHttpError`).toBe(true);
      expect(step?.errorHandling?.retryPolicy, `${id} retry`).toBeUndefined();
    }
  });

  it('closes via POST /…/close, comments via POST /…/comments, agent:runtime-lifecycle author, verbatim comment bodies', async () => {
    const raw = await readFile(join(DIR, FILES.closer), 'utf8');
    expect(raw).toMatch(/\/close/);
    expect(raw).toMatch(/\/comments/);
    expect(raw).toMatch(/agent:runtime-lifecycle/);
    expect(raw).toMatch(/scope no longer active/);
    expect(raw).toMatch(/resolved: active deployment on/);
  });
});

describe('wf-r5-closer (E2E)', () => {
  it('mixed lake set: closes the scope-gone and the compliant candidate, leaves still_open and human-owned', async () => {
    const rows = [
      closerLakeRow('ai-1', { verdict: 'close_scope_gone' }),
      closerLakeRow('ai-2', { verdict: 'close_compliant', live_runtime: 'nodejs20.x' }),
      closerLakeRow('ai-3', { verdict: 'still_open' }),
      closerLakeRow('ai-4', { item_status: 'deferred', verdict: 'close_compliant' }), // human-owned → skipped
    ];
    const { result, closeCalls, commentCalls } = await runCloser({ rows });
    expect(closeCalls.map((c) => c.itemId).sort()).toEqual(['ai-1', 'ai-2']);
    const commentByItem = Object.fromEntries(
      commentCalls.map((c) => [c.itemId, String((c.inputs.body as { content?: string }).content)]),
    );
    expect(commentByItem['ai-1']).toBe('scope no longer active');
    expect(commentByItem['ai-2']).toBe('resolved: active deployment on nodejs20.x');
    expect(result.outputs.live_items).toBe(4);
    expect(result.outputs.closeable).toBe(2);
    expect(result.outputs.closed_scope_gone).toBe(1);
    expect(result.outputs.closed_compliant).toBe(1);
    expect(result.outputs.still_open).toBe(1);
    expect(result.outputs.skipped_not_open).toBe(1);
  });

  it('scope-gone verdict: closed with comment "scope no longer active"', async () => {
    const { result, closeCalls, commentCalls } = await runCloser({
      rows: [closerLakeRow('ai-1', { verdict: 'close_scope_gone' })],
    });
    expect(result.outputs.closed_scope_gone).toBe(1);
    expect(closeCalls).toHaveLength(1);
    expect(commentCalls).toHaveLength(1);
    expect(String((commentCalls[0]?.inputs.body as { content?: string }).content)).toBe(
      'scope no longer active',
    );
  });

  it('compliant verdict: closed_compliant, comment names the live runtime', async () => {
    const { result, commentCalls } = await runCloser({
      rows: [closerLakeRow('ai-1', { verdict: 'close_compliant', live_runtime: 'nodejs20.x' })],
    });
    expect(result.outputs.closed_compliant).toBe(1);
    expect(String((commentCalls[0]?.inputs.body as { content?: string }).content)).toBe(
      'resolved: active deployment on nodejs20.x',
    );
  });

  it('still_open verdict: no close or comment, counted still_open', async () => {
    const { result, closeCalls, commentCalls } = await runCloser({
      rows: [closerLakeRow('ai-1', { verdict: 'still_open' })],
    });
    expect(result.outputs.still_open).toBe(1);
    expect(result.outputs.closeable).toBe(0);
    expect(closeCalls).toHaveLength(0);
    expect(commentCalls).toHaveLength(0);
  });

  it('stray item (no metadata.scope_id): bucketed as stray, never closed (never closes on lake evidence alone)', async () => {
    // Even with a close_scope_gone verdict, a row with no scope_id is a stray:
    // prep must override the verdict and never close it.
    const { result, closeCalls, commentCalls } = await runCloser({
      rows: [closerLakeRow('ai-1', { scope_id: '', verdict: 'close_scope_gone' })],
    });
    expect(result.outputs.stray).toBe(1);
    expect(result.outputs.closeable).toBe(0);
    expect(result.outputs.closed_scope_gone).toBe(0);
    expect(closeCalls).toHaveLength(0);
    expect(commentCalls).toHaveLength(0);
  });

  it.each(['deferred', 'pending_deferral', 'pending_verification', 'pending_rejection'])(
    'human-owned status %s: double-guarded as not-open, never closed even with a close verdict',
    async (status) => {
      const { result, closeCalls } = await runCloser({
        rows: [closerLakeRow('ai-1', { item_status: status, verdict: 'close_compliant' })],
      });
      expect(result.outputs.closeable).toBe(0);
      expect(result.outputs.skipped_not_open).toBe(1);
      expect(closeCalls).toHaveLength(0);
    },
  );

  it('zero closeable (all still_open / human-owned): no close or comment calls', async () => {
    const { result, closeCalls, commentCalls } = await runCloser({
      rows: [
        closerLakeRow('ai-1', { verdict: 'still_open' }),
        closerLakeRow('ai-2', { item_status: 'deferred' }),
      ],
    });
    expect(closeCalls).toHaveLength(0);
    expect(commentCalls).toHaveLength(0);
    expect(result.outputs.closeable).toBe(0);
    expect(result.outputs.live_items).toBe(2);
  });

  // ── Failure isolation (forEach parallel absorption, engine gap) ────────
  it('a close failure on one candidate does not kill the sweep: others close, failure bucketed by item id, comment only pairs to the closed item', async () => {
    const rows = [
      closerLakeRow('ai-1', { verdict: 'close_scope_gone' }),
      closerLakeRow('ai-2', { verdict: 'close_scope_gone' }),
    ];
    const { result, closeCalls, commentCalls } = await runCloser({
      rows,
      closeFailItemIds: ['ai-1'],
    });
    // Both closes attempted (permanent 4xx → one attempt each, no retry).
    expect(closeCalls.map((c) => c.itemId).sort()).toEqual(['ai-1', 'ai-2']);
    expect(result.outputs.closed_scope_gone).toBe(1);
    expect(result.outputs.close_failed).toBe(1);
    expect(result.outputs.close_failed_item_ids).toContain('ai-1');
    // The failed close drops its comment; only the item that actually closed
    // is commented — index alignment holds across the absorbed slot.
    expect(commentCalls.map((c) => c.itemId)).toEqual(['ai-2']);
    expect(result.outputs.comment_failed).toBe(0);
  });

  it('a comment failure is bucketed as comment_failed without un-closing the item', async () => {
    const { result, closeCalls, commentCalls } = await runCloser({
      rows: [closerLakeRow('ai-1', { verdict: 'close_scope_gone' })],
      commentFailItemIds: ['ai-1'],
    });
    expect(closeCalls).toHaveLength(1);
    expect(commentCalls).toHaveLength(1);
    expect(result.outputs.closed_scope_gone).toBe(1);
    expect(result.outputs.comment_failed).toBe(1);
    expect(result.outputs.comment_failed_item_ids).toContain('ai-1');
  });

  it('closeable set exceeding the 200-row safety cap truncates the dispatched closes but reports the full count', async () => {
    const rows = Array.from({ length: 210 }, (_, i) =>
      closerLakeRow(`ai-${i}`, { verdict: 'close_scope_gone' }),
    );
    const { result, closeCalls } = await runCloser({ rows });
    expect(closeCalls).toHaveLength(200);
    expect(result.outputs.truncated).toBe(true);
    expect(result.outputs.closeable).toBe(210);
  });
});
