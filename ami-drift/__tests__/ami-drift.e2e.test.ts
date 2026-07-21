/**
 * @file E2E + shape tests for the AMI drift workflow suite.
 *
 * E2E (runWorkflowE2E, plugin-level stubs):
 *   - scanner: drifted rows → one ensure sub-execution per finding, correct
 *     drift_key/scope_nrn/due_date, rows without AMI metadata skipped,
 *     empty configured-AMI baseline fails the run, due_days override honored.
 *   - ensure sub-workflow: create / updated / unchanged branches.
 *   - closer: closes exactly the open items whose drift_key is gone,
 *     comments before closing.
 *
 * Plugin stubs cannot see step config (stubs ignore `configure()`), so
 * payload constants (priority, value 200, close action) are asserted by
 * parsing the YAML directly.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
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
const SCANNER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'wf1-ami-drift-scanner.yaml');
const ENSURE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'ensure-drift-action-item.yaml');
const CLOSER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'wf2-ami-drift-closer.yaml');

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

// ── Shared fixtures ─────────────────────────────────────────────────────

// EC2 providers (v1.5 baseline): the scanner lists `/provider?...` and then
// fetches each provider BY ID — the detail endpoint returns the RESOLVED
// `attributes.ami.id`. Matching: provider applies to a scope when its nrn is
// the scope's nrn or an ancestor AND every provider dimension matches;
// most-specific wins (deeper nrn, then more dimensions).
interface ProviderFixture {
  id: string;
  nrn: string;
  dimensions: Record<string, string>;
  /** Resolved attributes.ami.id; null → detail resolves without an AMI. */
  ami: string | null;
  /** When set, the detail fetch answers this HTTP status with no body (orphan pointer). */
  detailStatus?: number;
}

const PROVIDERS: ProviderFixture[] = [
  // Account-level base AMI for every app under account=2.
  { id: 'prov-base', nrn: 'organization=1:account=2', dimensions: {}, ami: 'ami-good-1' },
  // App 4's uruguay dimension overrides the base (more specific: deeper nrn + dimension).
  {
    id: 'prov-uy',
    nrn: 'organization=1:account=2:namespace=3:application=4',
    dimensions: { country: 'uruguay' },
    ami: 'ami-good-2',
  },
];

const LAKE_ROWS = [
  // drifted: running an AMI that is not its expected one
  {
    deployment_id: 901,
    scope_id: 111,
    scope_name: 'Scope Drifted A',
    scope_nrn: 'organization=1:account=2:namespace=3:application=4',
    scope_dimensions: {},
    application: 'app-a',
    deployed_ami: 'ami-stale-1',
    deployed_at: '2026-07-10 10:00:00',
  },
  // drifted too
  {
    deployment_id: 902,
    scope_id: 222,
    scope_name: 'Scope Drifted B',
    scope_nrn: 'organization=1:account=2:namespace=3:application=5',
    scope_dimensions: {},
    application: 'app-b',
    deployed_ami: 'ami-stale-2',
    deployed_at: '2026-07-11 10:00:00',
  },
  // healthy: runs a configured AMI
  {
    deployment_id: 903,
    scope_id: 333,
    scope_name: 'Scope Healthy',
    scope_nrn: 'organization=1:account=2:namespace=3:application=6',
    scope_dimensions: {},
    application: 'app-c',
    deployed_ami: 'ami-good-1',
    deployed_at: '2026-07-12 10:00:00',
  },
  // no infrastructure_configuration metadata (old deployment)
  {
    deployment_id: 904,
    scope_id: 444,
    scope_name: 'Scope Old',
    scope_nrn: 'organization=1:account=2:namespace=3:application=7',
    scope_dimensions: {},
    application: 'app-d',
    deployed_ami: '',
    deployed_at: '2024-01-01 10:00:00',
  },
  // profile scope running the BASE ami of its app — its profile override
  // says ami-good-2, so this is drift (a false negative under the old
  // global-set rule: ami-good-1 was "configured somewhere").
  {
    deployment_id: 905,
    scope_id: 555,
    scope_name: 'Scope Uruguay Wrong Base',
    scope_nrn: 'organization=1:account=2:namespace=3:application=4',
    scope_dimensions: { country: 'uruguay' },
    application: 'app-a',
    deployed_ami: 'ami-good-1',
    deployed_at: '2026-07-13 10:00:00',
  },
  // profile scope running its override — valid.
  {
    deployment_id: 906,
    scope_id: 666,
    scope_name: 'Scope Uruguay OK',
    scope_nrn: 'organization=1:account=2:namespace=3:application=4',
    scope_dimensions: { country: 'uruguay' },
    application: 'app-a',
    deployed_ami: 'ami-good-2',
    deployed_at: '2026-07-13 11:00:00',
  },
];

/**
 * np-api-call stub serving the provider LIST (`/provider?...` — data_source
 * pointers, NO attributes, like the live API) and the per-provider DETAIL
 * (`/provider/{id}` — resolved `attributes.ami.id`). A fixture with
 * `detailStatus` answers that HTTP status with no usable body, emulating the
 * orphan runtime-config pointers that 401 in live orgs (`failOnHttpError:
 * false` must tolerate them).
 */
function npApiCallStub(providers: ProviderFixture[] = PROVIDERS) {
  return {
    handler: (ctx: { stepId: string; inputs: Record<string, unknown> }) => {
      if (ctx.stepId === 'fetch_providers') {
        const results = providers.map((p) => ({
          id: p.id,
          nrn: p.nrn,
          dimensions: p.dimensions,
          data_source: { key: `rc-${p.id}`, specification_slug: 'ec2-configuration' },
        }));
        return ok({ status: 200, body: { results } });
      }
      if (ctx.stepId === 'fetch_runtime_configs') {
        // forEach injects the per-iteration path as inputs.path: /provider/{id}
        const raw = String(ctx.inputs.path ?? '');
        const id = decodeURIComponent(raw.replace(/^\/provider\//, ''));
        const p = providers.find((x) => x.id === id);
        if (p === undefined || p.detailStatus !== undefined) {
          // Orphan pointer: live API answers 401/404; with failOnHttpError
          // off the step succeeds with the status and no resolvable body.
          return ok({ status: p?.detailStatus ?? 404, body: {} });
        }
        return ok({
          status: 200,
          body: {
            id: p.id,
            nrn: p.nrn,
            dimensions: p.dimensions,
            ...(p.ami !== null ? { attributes: { ami: { id: p.ami } } } : { attributes: {} }),
          },
        });
      }
      throw new Error(`unexpected np-api-call step: ${ctx.stepId}`);
    },
    executeMode: 'all' as const,
  };
}

const lakeStub = (rows: Record<string, unknown>[]) => ({
  handler: () => ok({ rows, rowCount: rows.length }),
  executeMode: 'all' as const,
});

// ── Scanner E2E ─────────────────────────────────────────────────────────

interface EnsureCall {
  finding: Record<string, unknown>;
  category_slug: unknown;
  organization_id: unknown;
}

async function runScanner(opts: {
  inputs?: Record<string, unknown>;
  providers?: ProviderFixture[];
  lakeRows?: Record<string, unknown>[];
}) {
  const ensureCalls: EnsureCall[] = [];
  const result = await runWorkflowE2E({
    yamlPath: SCANNER,
    inputs: opts.inputs ?? {},
    pluginStubs: {
      manual: passthroughTrigger,
      cron: passthroughTrigger,
      'np-api-call': npApiCallStub(opts.providers),
      'np-lake-query': lakeStub(opts.lakeRows ?? LAKE_ROWS),
      'sub-workflow': {
        handler: (ctx) => {
          const i = ctx.inputs as Record<string, unknown>;
          const finding = i.finding as Record<string, unknown>;
          ensureCalls.push({
            finding,
            category_slug: i.category_slug,
            organization_id: i.organization_id,
          });
          return ok({ action: 'created', action_item_id: `ai_${finding.scope_id}` });
        },
        executeMode: 'all' as const,
      },
    },
  });
  return { result, ensureCalls };
}

describe('wf1-ami-drift-scanner (E2E)', () => {
  it('creates one action item per drifted deployment, skips healthy and metadata-less rows', async () => {
    const { result, ensureCalls } = await runScanner({});
    expect(result.outputs.total_deployments).toBe(6);
    expect(result.outputs.skipped_no_metadata).toBe(1);
    expect(result.outputs.drifted).toBe(3);
    expect(result.outputs.created).toBe(3);
    expect(result.outputs.action_item_ids).toEqual(['ai_111', 'ai_222', 'ai_555']);

    expect(ensureCalls).toHaveLength(3);
    const first = ensureCalls[0]!;
    expect(first.finding.drift_key).toBe('ami-drift:111');
    expect(first.finding.scope_nrn).toBe(
      'organization=1:account=2:namespace=3:application=4:scope=111',
    );
    expect(first.finding.deployed_ami).toBe('ami-stale-1');
    expect(first.finding.expected_ami).toBe('ami-good-1');
    expect((first.finding.metadata as Record<string, unknown>).expected_ami).toBe('ami-good-1');
    // The profile scope's expected AMI is its override, not the base.
    const uruguay = ensureCalls[2]!;
    expect(uruguay.finding.scope_id).toBe('555');
    expect(uruguay.finding.deployed_ami).toBe('ami-good-1');
    expect(uruguay.finding.expected_ami).toBe('ami-good-2');
    // vars.AMI_DRIFT_CATEGORY_SLUG is unset in the harness → falls back to 'engineering'
    expect(first.category_slug).toBe('engineering');

    const meta = first.finding.metadata as Record<string, unknown>;
    expect(meta.drift_key).toBe('ami-drift:111');
    expect(meta.scope_id).toBe('111');
    expect(meta.deployed_ami).toBe('ami-stale-1');
    expect(typeof meta.detected_at).toBe('string');
  });

  it('due_date defaults to now + 14 days', async () => {
    const { ensureCalls } = await runScanner({});
    const due = String(ensureCalls[0]!.finding.due_date);
    expect(due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const deltaDays = (Date.parse(due) - Date.now()) / 86400000;
    expect(deltaDays).toBeGreaterThan(12.9);
    expect(deltaDays).toBeLessThan(14.1);
  });

  it('honors the due_days manual input override', async () => {
    const { ensureCalls } = await runScanner({ inputs: { due_days: 30 } });
    const due = String(ensureCalls[0]!.finding.due_date);
    const deltaDays = (Date.parse(due) - Date.now()) / 86400000;
    expect(deltaDays).toBeGreaterThan(28.9);
    expect(deltaDays).toBeLessThan(30.1);
  });

  it('fails the run when no configured AMIs are found (empty baseline guard)', async () => {
    await expect(
      runScanner({
        // Providers exist but none resolves an AMI → empty baseline.
        providers: [
          { id: 'prov-empty', nrn: 'organization=1:account=2', dimensions: {}, ami: null },
        ],
      }),
    ).rejects.toThrow(/build_provider_index|No active EC2 provider AMIs/i);
  });

  it('emits ONE finding per scope even with several drifted deployments (drift_key dedup)', async () => {
    // A scope with two active drifted deployments used to emit two findings
    // with the SAME drift_key — in the parallel ensure fan-out both children
    // found nothing and both created → duplicate action items (58 dups in
    // the ueno scale run). The newest deployment is the representative.
    const secondDeployment = {
      ...LAKE_ROWS[0]!,
      deployment_id: 999,
      deployed_ami: 'ami-stale-NEWER',
      deployed_at: '2026-07-15 10:00:00', // newer than 901's 2026-07-10
    };
    const { result, ensureCalls } = await runScanner({
      lakeRows: [LAKE_ROWS[0]!, secondDeployment],
    });
    expect(result.outputs.drifted).toBe(1);
    expect(ensureCalls).toHaveLength(1);
    const finding = ensureCalls[0]!.finding;
    expect(finding.drift_key).toBe('ami-drift:111');
    expect(finding.deployment_id).toBe('999');
    expect(finding.deployed_ami).toBe('ami-stale-NEWER');
  });

  it('tolerates orphan provider details (4xx) and builds the baseline from the rest', async () => {
    // The v1.5 regression: one provider's detail fetch 401s (its data_source
    // points at a runtime config of a DELETED application). failOnHttpError:
    // false must let the scan proceed with the remaining providers.
    const { result, ensureCalls } = await runScanner({
      providers: [
        ...PROVIDERS,
        {
          id: 'prov-orphan',
          nrn: 'organization=1:account=2:namespace=9',
          dimensions: {},
          ami: null,
          detailStatus: 401,
        },
      ],
    });
    expect(result.outputs.drifted).toBe(3);
    expect(ensureCalls).toHaveLength(3);
  });

  it('handles a fully healthy fleet without ensure calls', async () => {
    const { result, ensureCalls } = await runScanner({
      lakeRows: [LAKE_ROWS[2]!, LAKE_ROWS[5]!],
    });
    expect(result.outputs.drifted).toBe(0);
    expect(result.outputs.created).toBe(0);
    expect(ensureCalls).toHaveLength(0);
  });

  it('nrn input filters the scan to scopes under that NRN (prefix match)', async () => {
    // application=5 hosts exactly one scope (222); the other drifted scopes
    // (111, 555 under application=4) are outside the filter and untouched.
    const single = await runScanner({
      inputs: { nrn: 'organization=1:account=2:namespace=3:application=5' },
    });
    expect(single.result.outputs.nrn_filter).toBe(
      'organization=1:account=2:namespace=3:application=5',
    );
    expect(single.result.outputs.total_deployments).toBe(1);
    expect(single.result.outputs.drifted).toBe(1);
    expect(single.result.outputs.action_item_ids).toEqual(['ai_222']);
    expect(single.ensureCalls).toHaveLength(1);
    expect(single.ensureCalls[0]!.finding.scope_id).toBe('222');

    // application=4 hosts three scopes (111 drifted, 555 drifted, 666 ok).
    const multi = await runScanner({
      inputs: { nrn: 'organization=1:account=2:namespace=3:application=4' },
    });
    expect(multi.result.outputs.total_deployments).toBe(3);
    expect(multi.result.outputs.drifted).toBe(2);
    expect(multi.result.outputs.action_item_ids).toEqual(['ai_111', 'ai_555']);
  });

  it('an nrn filter matching nothing completes with drifted 0 (no empty-baseline throw)', async () => {
    const { result, ensureCalls } = await runScanner({
      inputs: { nrn: 'organization=1:account=2:namespace=999' },
    });
    expect(result.outputs.total_deployments).toBe(0);
    expect(result.outputs.drifted).toBe(0);
    expect(ensureCalls).toHaveLength(0);
  });

  it('the nrn filter must not prefix-match a LONGER application id (4 vs 40)', async () => {
    const { result } = await runScanner({
      inputs: { nrn: 'organization=1:account=2:namespace=3:application=40' },
    });
    // application=4 starts with the same characters but is a DIFFERENT node;
    // the match is segment-wise (equal or `nrn + ':'` prefix), so nothing matches.
    expect(result.outputs.total_deployments).toBe(0);
  });
});

// ── Ensure sub-workflow E2E ─────────────────────────────────────────────

const FINDING = {
  drift_key: 'ami-drift:111',
  scope_id: '111',
  scope_name: 'Scope Drifted A',
  scope_nrn: 'organization=1:account=2:namespace=3:application=4:scope=111',
  application: 'app-a',
  deployment_id: '901',
  deployed_ami: 'ami-stale-1',
  expected_ami: 'ami-good-1',
  deployed_at: '2026-07-10 10:00:00',
  due_date: '2026-07-29',
  metadata: {
    drift_key: 'ami-drift:111',
    scope_id: '111',
    scope_name: 'Scope Drifted A',
    deployment_id: '901',
    deployed_ami: 'ami-stale-1',
    expected_ami: 'ami-good-1',
    application: 'app-a',
    detected_at: '2026-07-15T12:00:00.000Z',
  },
};

async function runEnsure(findResult: Record<string, unknown>) {
  let createCalls = 0;
  let updateCalls = 0;
  const result = await runWorkflowE2E({
    yamlPath: ENSURE,
    inputs: { finding: FINDING, category_slug: 'engineering', organization_id: '100000001' },
    pluginStubs: {
      manual: passthroughTrigger,
      'np-action-item-find': { handler: () => ok(findResult), executeMode: 'all' as const },
      'np-action-item-create': {
        handler: () => {
          createCalls++;
          return ok({ actionItemId: 'ai_new', slug: 'x', status: 'open', actionItem: {} });
        },
        executeMode: 'all' as const,
      },
      'np-action-item-update': {
        handler: () => {
          updateCalls++;
          return ok({ actionItem: {}, status: 'open' });
        },
        executeMode: 'all' as const,
      },
    },
  });
  return { result, createCalls: () => createCalls, updateCalls: () => updateCalls };
}

describe('ensure-drift-action-item (E2E)', () => {
  it('creates when no live item exists', async () => {
    const { result, createCalls, updateCalls } = await runEnsure({
      items: [],
      count: 0,
      firstMatch: null,
    });
    expect(result.outputs.action).toBe('created');
    expect(result.outputs.action_item_id).toBe('ai_new');
    expect(createCalls()).toBe(1);
    expect(updateCalls()).toBe(0);
    const desc = (
      result.finalSnapshot.steps['build_description']?.outputs as { description?: string }
    )?.description;
    expect(desc).toContain('ami-stale-1');
    expect(desc).toContain('Scope Drifted A');
  });

  it('no-ops when the live item already tracks the same deployed AMI', async () => {
    const { result, createCalls, updateCalls } = await runEnsure({
      items: [{ id: 'ai_1', metadata: { deployed_ami: 'ami-stale-1' } }],
      count: 1,
      firstMatch: { id: 'ai_1', metadata: { deployed_ami: 'ami-stale-1' } },
    });
    expect(result.outputs.action).toBe('unchanged');
    expect(result.outputs.action_item_id).toBe('ai_1');
    expect(createCalls()).toBe(0);
    expect(updateCalls()).toBe(0);
  });

  it('patches metadata when the scope redeployed onto a different stale AMI', async () => {
    const { result, createCalls, updateCalls } = await runEnsure({
      items: [{ id: 'ai_1', metadata: { deployed_ami: 'ami-stale-OLD' } }],
      count: 1,
      firstMatch: { id: 'ai_1', metadata: { deployed_ami: 'ami-stale-OLD' } },
    });
    expect(result.outputs.action).toBe('updated');
    expect(result.outputs.action_item_id).toBe('ai_1');
    expect(createCalls()).toBe(0);
    expect(updateCalls()).toBe(1);
  });
});

// ── Closer E2E ──────────────────────────────────────────────────────────
//
// v2.1: `find_open_items` (np-action-item-find, limit 200, no cursor) was
// replaced by a streaming `np-entity-paginated-fetch` (mode: stream, `loop`
// → `decide` per page). The stub below mirrors
// workflows/runtime-lifecycle/__tests__/runtime-lifecycle.e2e.test.ts's own
// `runCloser` paginated-fetch stub exactly: pages flow on `loop` (INCLUDING
// the last non-empty page — `done` only fires on a SUBSEQUENT, empty
// invocation), matching the real plugin's documented streaming contract
// (CLAUDE.md § Streaming Pagination Pattern).

interface CloserRunOpts {
  /** Pages the stub streams, in order. An org with N pages of open items
   *  (not just the first 200) is exactly what v2.0's bug dropped. */
  pages: Record<string, unknown>[][];
  providers?: ProviderFixture[];
  lakeRows?: Record<string, unknown>[];
  /** actionItemId values for which the close call throws (simulates a
   *  persistent 5xx from the NP API on that page). */
  failCloseIds?: string[];
}

async function runCloser(opts: CloserRunOpts) {
  const commented: unknown[] = [];
  const closed: unknown[] = [];
  const itemFetchCalls: unknown[] = [];
  // Records 'comment:<id>' / 'close:<id>' in call order, so the E2E test
  // can verify comment-before-close ordering. Plugin stubs ignore
  // `configure()` (see the file header note) so `content`/`author` — the
  // comment's static config fields — are NOT observable here; the exact
  // wording is asserted separately by parsing the YAML (see "YAML shape"
  // below, "closer close-comment content matches the original wording").
  const callOrder: string[] = [];
  const pages = opts.pages;
  let pageIdx = 0;
  const result = await runWorkflowE2E({
    yamlPath: CLOSER,
    inputs: {},
    pluginStubs: {
      manual: passthroughTrigger,
      cron: passthroughTrigger,
      'np-api-call': npApiCallStub(opts.providers),
      'np-lake-query': lakeStub(opts.lakeRows ?? [LAKE_ROWS[0]!]),
      'np-entity-paginated-fetch': {
        handler: (ctx: unknown) => {
          itemFetchCalls.push(ctx);
          if (pageIdx >= pages.length) {
            // All real pages already streamed — this is the terminal,
            // empty invocation that activates `done` (real pages, even
            // the last non-empty one, always exit via `loop` — see the
            // header note above).
            return {
              status: 'success',
              outputs: { items: [], page: pageIdx, done: true },
              items: [],
              activePorts: ['done'],
            };
          }
          const items = pages[pageIdx] ?? [];
          const isLast = pageIdx === pages.length - 1;
          const page = pageIdx;
          pageIdx += 1;
          const isEmptyTerminal = isLast && items.length === 0;
          return {
            status: 'success',
            outputs: { items, page, lastPage: isLast, ...(isEmptyTerminal ? { done: true } : {}) },
            items: items as Record<string, unknown>[],
            activePorts: isEmptyTerminal ? ['done'] : ['loop'],
          };
        },
        inputPorts: [{ name: 'default' }, { name: 'callback', reentry: true }],
        outputPorts: [{ name: 'default' }, { name: 'done' }, { name: 'loop' }],
      },
      'np-action-item-add-comment': {
        handler: (ctx: { inputs: Record<string, unknown> }) => {
          const id = ctx.inputs.actionItemId;
          commented.push(id);
          callOrder.push(`comment:${String(id)}`);
          return ok({ ok: true });
        },
        executeMode: 'all' as const,
      },
      'np-action-item-update': {
        handler: (ctx: { inputs: Record<string, unknown> }) => {
          const id = String(ctx.inputs.actionItemId);
          if (opts.failCloseIds?.includes(id)) {
            // Real plugins report HTTP/API failures by RETURNING a failure
            // IStepResult, never by throwing (packages/core/src/plugins/
            // built-in/np-action-item-update/plugin.ts catches internally) —
            // `LocalStepExecutor.executeModuleInner` does not wrap
            // `instance.execute()` in a try/catch, and `ForEachCoordinator`'s
            // sequential loop doesn't either, so a THROWN stub error would
            // propagate uncaught past `continueOnError` entirely (a real
            // engine gap, not exercised by this test).
            return {
              status: 'failure',
              error: {
                message: `persistent 5xx closing ${id}`,
                code: 'HTTP_5XX',
                retryable: false,
              },
              activePorts: ['default'],
            };
          }
          closed.push(id);
          callOrder.push(`close:${id}`);
          return ok({ actionItem: {}, status: 'closed' });
        },
        executeMode: 'all' as const,
      },
    },
  });
  return { result, commented, closed, itemFetchCalls, callOrder };
}

describe('wf2-ami-drift-closer (E2E)', () => {
  it('closes exactly the items whose drift is gone, commenting first', async () => {
    const OPEN_ITEMS = [
      { id: 'ai_still', status: 'open', metadata: { drift_key: 'ami-drift:111' } }, // still drifted
      { id: 'ai_gone', status: 'open', metadata: { drift_key: 'ami-drift:999' } }, // no longer drifted
      { id: 'ai_alien', status: 'open', metadata: {} }, // no drift_key → left alone
    ];
    // Only scope 111 still drifts (matches lakeStub([LAKE_ROWS[0]]) below).
    const { result, commented, closed } = await runCloser({ pages: [OPEN_ITEMS] });

    expect(result.outputs.checked).toBe(3);
    expect(result.outputs.still_valid).toBe(2);
    expect(result.outputs.closed).toBe(1);
    expect(result.outputs.close_failed).toBe(0);
    expect(commented).toEqual(['ai_gone']);
    expect(closed).toEqual(['ai_gone']);
  });

  // Exact comment wording is asserted separately by parsing the YAML
  // ("YAML shape" § "closer close-comment content matches the original
  // wording exactly" below) — plugin stubs ignore `configure()` (see the
  // `runCloser` note above), so `content` isn't observable here. This test
  // covers what E2E CAN observe: the comment is posted before the close
  // call, for the right item, every time.
  it('comment_closing runs before close_items, for the right item', async () => {
    const OPEN_ITEMS = [
      { id: 'ai_gone', status: 'open', metadata: { drift_key: 'ami-drift:999' } },
    ];
    const { commented, closed, callOrder } = await runCloser({ pages: [OPEN_ITEMS] });
    expect(commented).toEqual(['ai_gone']);
    expect(closed).toEqual(['ai_gone']);
    expect(callOrder).toEqual(['comment:ai_gone', 'close:ai_gone']);
  });

  it('closes nothing when every open item still drifts', async () => {
    const { result, closed } = await runCloser({
      pages: [[{ id: 'ai_still', status: 'open', metadata: { drift_key: 'ami-drift:111' } }]],
    });
    expect(result.outputs.closed).toBe(0);
    expect(result.outputs.still_valid).toBe(1);
    expect(closed).toEqual([]);
  });

  // ── Pagination fix (v2.1) ────────────────────────────────────────────
  it('streams every page of open items — pins the v2.0 single-page (limit 200, no cursor) bug as fixed', async () => {
    // Three small pages stand in for ">200 open items, 3+ pages" — the
    // exact shape the old np-action-item-find(limit:200)-with-no-cursor
    // bug silently dropped past the first page. Item on page 2 is the one
    // the task calls out explicitly.
    const pages = [
      [{ id: 'ai_p1', status: 'open', metadata: { drift_key: 'ami-drift:111' } }], // still drifted → keep
      [{ id: 'ai_p2', status: 'open', metadata: { drift_key: 'ami-drift:999' } }], // gone → close
      [{ id: 'ai_p3', status: 'open', metadata: { drift_key: 'ami-drift:888' } }], // gone → close
    ];
    const { result, commented, closed, itemFetchCalls } = await runCloser({ pages });

    // Every page was fetched (2 real pages of streaming beyond the first
    // would have been silently dropped by v2.0's single find(limit:200)).
    expect(itemFetchCalls.length).toBeGreaterThanOrEqual(pages.length);
    expect(result.outputs.checked).toBe(3);
    expect(result.outputs.still_valid).toBe(1);
    expect(result.outputs.closed).toBe(2);
    expect(result.outputs.close_failed).toBe(0);
    expect(closed.sort()).toEqual(['ai_p2', 'ai_p3']);
    expect((commented as string[]).sort()).toEqual(['ai_p2', 'ai_p3']);
  });

  // ── Failure isolation (the fix's other half) ────────────────────────
  it('a persistent close failure on one page does not kill the sweep: earlier and later pages still get evaluated', async () => {
    const pages = [
      [{ id: 'ai_p1', status: 'open', metadata: { drift_key: 'ami-drift:111' } }], // keep
      [{ id: 'ai_p2', status: 'open', metadata: { drift_key: 'ami-drift:999' } }], // close → FAILS
      [{ id: 'ai_p3', status: 'open', metadata: { drift_key: 'ami-drift:888' } }], // close → succeeds
    ];
    const { result, commented, closed, itemFetchCalls } = await runCloser({
      pages,
      failCloseIds: ['ai_p2'],
    });

    // All 3 pages were fetched — the failure on page 2 didn't stop page 3
    // from being fetched and processed.
    expect(itemFetchCalls.length).toBeGreaterThanOrEqual(pages.length);
    // ai_p3 (page 3) still got closed despite page 2's failure.
    expect(closed).toEqual(['ai_p3']);
    // comment_closing runs BEFORE close_items — ai_p2 was commented even
    // though its close call failed (documented ordering risk, unchanged
    // from v2.0; see the YAML header note).
    expect(commented).toEqual(['ai_p2', 'ai_p3']);
    expect(result.outputs.still_valid).toBe(1); // ai_p1
    expect(result.outputs.closed).toBe(1); // ai_p3
    expect(result.outputs.close_failed).toBe(1); // ai_p2's page
    expect(result.outputs.checked).toBe(3); // ai_p1 + ai_p2's page + ai_p3
  });
});

// ── YAML shape (payload constants the stubs cannot observe) ────────────

describe('YAML shape', () => {
  it('scanner declares manual + cron triggers (03:00 AR)', async () => {
    const def = await loadYaml('wf1-ami-drift-scanner.yaml');
    expect(def.steps['start_manual']!.pluginType).toBe('manual');
    expect(def.steps['start_cron']!.pluginType).toBe('cron');
    const cron = def.steps['start_cron']!.config as Record<string, unknown>;
    expect(cron.schedule).toBe('0 3 * * *');
    expect(cron.timezone).toBe('America/Argentina/Buenos_Aires');
  });

  it('closer declares manual + cron triggers (04:00 AR)', async () => {
    const def = await loadYaml('wf2-ami-drift-closer.yaml');
    const cron = def.steps['start_cron']!.config as Record<string, unknown>;
    expect(cron.schedule).toBe('0 4 * * *');
  });

  // v2.1: the single-page np-action-item-find(limit:200, no cursor) is
  // gone, replaced by a streaming np-entity-paginated-fetch.
  it('closer streams open ami-drift items via np-entity-paginated-fetch (limit 25, mode stream) — find_open_items is gone', async () => {
    const def = await loadYaml('wf2-ami-drift-closer.yaml');
    expect(def.steps['find_open_items']).toBeUndefined();
    const fetch = def.steps['fetch_items'];
    expect(fetch).toBeDefined();
    expect(fetch!.pluginType).toBe('np-entity-paginated-fetch');
    const cfg = fetch!.config as Record<string, unknown>;
    expect(cfg.entity).toBe('governance/action_item');
    expect(cfg.mode).toBe('stream');
    // Payload diet (Temporal 2MB activity-input finding) — must stay well
    // under the usual 100 default.
    expect(cfg.limit).toBe(25);
    const filters = cfg.filters as Record<string, unknown>;
    expect(filters.status).toBe('open');
    expect(filters['labels.workflow_type']).toBe('ami-drift');
  });

  it('closer close-comment content matches the original wording exactly', async () => {
    const def = await loadYaml('wf2-ami-drift-closer.yaml');
    const cfg = def.steps['comment_closing']!.config as Record<string, unknown>;
    expect(cfg.content).toBe(
      'Closing automatically: AMI drift no longer detected (scope redeployed with a configured AMI, scope no longer active, or the AMI is now configured).',
    );
  });

  it('create carries priority medium, value 200 and the finding due date', async () => {
    const def = await loadYaml('ensure-drift-action-item.yaml');
    const cfg = def.steps['create_item']!.config as Record<string, unknown>;
    expect(cfg.priority).toBe('medium');
    expect(cfg.value).toBe(200);
    expect(cfg.dueDate).toBe('${{ workflow.inputs.finding.due_date }}');
    expect(cfg.createdBy).toBe('agent:ami-drift-scanner');
    expect((cfg.labels as Record<string, string>).workflow_type).toBe('ami-drift');
  });

  it('closer closes via the close transition with an actor', async () => {
    const def = await loadYaml('wf2-ami-drift-closer.yaml');
    const cfg = def.steps['close_items']!.config as Record<string, unknown>;
    expect(cfg.action).toBe('close');
    expect(cfg.actor).toBe('agent:ami-drift-closer');
  });

  it('all three workflows live under /action-items/ami-drift', async () => {
    for (const f of [
      'wf1-ami-drift-scanner.yaml',
      'ensure-drift-action-item.yaml',
      'wf2-ami-drift-closer.yaml',
    ]) {
      const def = await loadYaml(f);
      expect(def.path).toBe('/action-items/ami-drift');
    }
  });
});
