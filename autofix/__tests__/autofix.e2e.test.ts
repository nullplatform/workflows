/**
 * @file E2E tests for the autofix suite (runWorkflowE2E, plugin-level stubs).
 *
 * Everything that reasons — guard, diff, zip, plan, record — is `code-exec`
 * and runs FOR REAL here; only the I/O edge is stubbed:
 *   - `webhook` trigger → the NP audit poke (a build id, nothing else)
 *   - `np-api-call` switched on path/method: build, metadata, application,
 *     item lookup, and every write pass (create / patch / close / comment)
 *   - `sub-workflow` → captures each dispatched fix group
 *   - `signal-wait` → the metadata grace timer fires immediately
 *   - `claude-code-agent` → canned outcome (or a step failure)
 *
 * wf-a1 (on build):
 *   - one item per raw finding, keyed `<repo>@<branch>|<finding.id>`, manual
 *     vs auto-fixable, priority from severity, labels/metadata shape
 *   - fix groups: same package + same fixed version → ONE group; a
 *     code_change finding is its own group; manual findings never dispatch
 *   - known finding → PATCH with merged metadata (seen_builds, last_build_id,
 *     fix_* preserved), no duplicate create
 *   - vanished finding → close + comment; blocked by truncation / gate error
 *   - re-dispatch policy: pr_opened never, in_progress (fresh) never,
 *     failed below the attempt cap yes, at the cap no
 *   - skips: not successful, branch not watched, metadata never lands
 *   - metadata-ordering: no findings on the first read → park → re-read → proceed
 *   - poke without a numeric id fails loudly
 *
 * wf-a2 (fix):
 *   - in_progress stamped from FETCHED metadata (attempts +1), then outcome:
 *     pr_opened → pr_url on every fixed item + comment; unfixed → failed
 *   - already_fixed and failed outcomes
 *   - pr_opened without a URL is downgraded to failed (no invented PRs)
 *   - agent step failure → fallback chain stamps failed + comments
 *   - deterministic branch name (same group → same branch)
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IStepResult } from '@nullplatform/workflow-kit/test';
import { runWorkflowE2E } from '@nullplatform/workflow-kit/test';
import { describe, expect, it } from 'vitest';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ON_BUILD = resolve(DIR, 'wf-a1-on-build.yaml');
const FIX = resolve(DIR, 'wf-a2-fix.yaml');

const ok = (outputs: Record<string, unknown>): IStepResult => ({
  status: 'success',
  outputs,
  activePorts: ['default'],
});
const stepFailurePermanent = (message: string): IStepResult => ({
  status: 'failure',
  error: { message, code: 'AGENT_FAILED', retryable: false },
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const BUILD_ID = '33626714087';
const APP_ID = '924036609';
const REPO = 'ey-org/autest1-mwr1';
const BRANCH = 'master';
const SCOPE = `${REPO}@${BRANCH}`;

// The normalized findings contract CI writes to `quality_metrics`.
const FINDINGS = [
  {
    id: 'aqua:GHSA-xxxx-yyyy-zzzz:axios@1.7.4',
    tool: 'aqua',
    category: 'vulnerability',
    severity: 'high',
    status: 'open',
    title: 'GHSA-xxxx-yyyy-zzzz: SSRF via absolute URL in axios request path',
    rule: { id: 'GHSA-xxxx-yyyy-zzzz', url: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz' },
    package: { name: 'axios', ecosystem: 'npm', version: '1.7.4', fixed_version: '1.8.2', direct: true },
    location: { type: 'manifest', path: 'package.json', line: 23, snippet: '"axios": "^1.7.4"' },
    fix: { available: true, auto_fixable: true, type: 'upgrade_package', recommendation: 'Upgrade axios to 1.8.2 or later', command: 'npm install axios@^1.8.2' },
    risk: { cvss_score: 7.1, epss_score: 0.07, exploit_available: false },
    url: 'https://ey.cloud.aquasec.com/#/images/.../vulns/GHSA-xxxx-yyyy-zzzz',
  },
  // Second advisory on the SAME package + SAME fixed version → same fix group.
  {
    id: 'aqua:CVE-2026-0001:axios@1.7.4',
    tool: 'aqua',
    category: 'vulnerability',
    severity: 'medium',
    status: 'open',
    title: 'CVE-2026-0001: prototype pollution in axios merge helper',
    rule: { id: 'CVE-2026-0001', url: 'https://nvd.nist.gov/vuln/detail/CVE-2026-0001' },
    package: { name: 'axios', ecosystem: 'npm', version: '1.7.4', fixed_version: '1.8.2', direct: true },
    location: { type: 'manifest', path: 'package.json', line: 23 },
    fix: { available: true, auto_fixable: true, type: 'upgrade_package', recommendation: 'Upgrade axios to 1.8.2 or later' },
    url: 'https://ey.cloud.aquasec.com/#/images/.../vulns/CVE-2026-0001',
  },
  {
    id: 'checkmarx:sast:Reflected_XSS_All_Clients:8a71c2d4e5',
    tool: 'checkmarx',
    category: 'sast',
    severity: 'high',
    status: 'open',
    confidence: 'high',
    title: 'Reflected XSS: request query parameter written to response without encoding',
    rule: { id: 'Reflected_XSS_All_Clients', cwe: 'CWE-79', url: 'https://ey.checkmarx.net/results/scan-8f2e1c/sast/8a71c2d4e5' },
    location: {
      type: 'code_flow',
      path: 'src/handlers/search.ts',
      line: 27,
      column: 14,
      snippet: 'res.send(`<h1>Results for ${q}</h1>`);',
      source: { path: 'src/handlers/search.ts', line: 19, column: 21, snippet: 'const q = req.query.q;' },
      sink: { path: 'src/handlers/search.ts', line: 27, column: 14, snippet: 'res.send(`<h1>Results for ${q}</h1>`);' },
      node_count: 4,
    },
    fix: { available: true, auto_fixable: true, type: 'code_change', recommendation: 'HTML-encode q before interpolating into the response (e.g., escape-html) or return JSON instead of HTML' },
    url: 'https://ey.checkmarx.net/results/scan-8f2e1c/sast/8a71c2d4e5',
  },
  {
    id: 'checkmarx:sca:license:some-gpl-lib@2.3.0',
    tool: 'checkmarx',
    category: 'license',
    severity: 'high',
    status: 'open',
    title: 'GPL-3.0 licensed dependency violates the EY license policy',
    rule: { id: 'license-policy/gpl-copyleft' },
    package: { name: 'some-gpl-lib', ecosystem: 'npm', version: '2.3.0', direct: true, license: 'GPL-3.0' },
    location: { type: 'manifest', path: 'package.json', line: 31 },
    fix: { available: false, auto_fixable: false, type: 'manual', recommendation: 'Replace with an MIT/Apache-2.0 alternative or request legal approval' },
    url: 'https://ey.checkmarx.net/results/scan-8f2e1c/sca/some-gpl-lib',
  },
  {
    id: 'jest:src/services/order.spec.ts:applies discount on renewal',
    tool: 'jest',
    category: 'test_failure',
    severity: 'high',
    status: 'open',
    title: 'OrderService > applies discount on renewal',
    location: { type: 'file', path: 'src/services/order.spec.ts', line: 88 },
    message: 'expected 90 to equal 81',
    fix: { available: false, auto_fixable: false, type: 'manual', recommendation: 'Renewal discount is not applied in OrderService.applyDiscount; check the isRenewal branch' },
    url: 'https://github.com/ey-org/autest1-mwr1/actions/runs/33626714087',
  },
];

function qualityMetrics(findings: Record<string, unknown>[], opts: { truncated?: boolean; gateResult?: string } = {}) {
  return {
    overall_result: 'failed',
    source: {
      repository: REPO,
      repository_url: `https://github.com/${REPO}`,
      branch: BRANCH,
      commit_sha: '3f9a2c1e7b4d5f6e8c9a0b1d2e3f4a5b6c7d8e9f',
      dockerfile: 'Dockerfile',
      manifests: ['package-lock.json'],
    },
    gates: [
      { name: 'sast', tool: 'checkmarx', result: opts.gateResult ?? 'failed' },
      { name: 'container_scan', tool: 'aqua', result: 'failed' },
    ],
    findings_summary: {
      total: opts.truncated ? findings.length + 5 : findings.length,
      returned: findings.length,
      truncated: opts.truncated === true,
    },
    findings,
  };
}

function build(overrides: Record<string, unknown> = {}) {
  return {
    id: Number(BUILD_ID),
    application_id: Number(APP_ID),
    status: 'successful',
    branch: BRANCH,
    commit: { id: '3f9a2c1e7b4d5f6e8c9a0b1d2e3f4a5b6c7d8e9f' },
    metadata: { quality_metrics: qualityMetrics(FINDINGS) },
    ...overrides,
  };
}

const APPLICATION = {
  id: Number(APP_ID),
  name: 'autest1-mwr1',
  nrn: `organization=1:account=2:namespace=3:application=${APP_ID}`,
  repository_url: `https://github.com/${REPO}.git`,
};

const POKE = { source: 'audit', notification: { entity: 'build', entity_id: BUILD_ID, method: 'PATCH' } };

/** A live item as the governance list endpoint returns it. */
function liveItem(findingId: string, metadata: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    id: `ai_${findingId.replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}`,
    status: 'open',
    priority: 'medium',
    metadata: {
      finding_key: `${SCOPE}|${findingId}`,
      finding_scope: SCOPE,
      finding_id: findingId,
      seen_builds: 3,
      seen_build_ids: ['1', '2', '3'],
      first_build_id: '1',
      fix_status: 'pending',
      fix_attempts: 0,
      ...metadata,
    },
    ...extra,
  };
}

// ── wf-a1 harness ───────────────────────────────────────────────────────────

interface ApiCall {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
}

interface OnBuildOpts {
  /** Sequence of build responses (one per fetch; the last one repeats). */
  builds?: Record<string, unknown>[];
  /** Body of GET /metadata/build/{id}; omitted → 404. */
  metadataInstances?: Record<string, unknown>;
  application?: Record<string, unknown>;
  existing?: Record<string, unknown>[];
  poke?: Record<string, unknown>;
  /** Item ids (by finding id) whose create must fail. */
  failCreateFor?: string[];
}

async function runOnBuild(opts: OnBuildOpts = {}) {
  const calls: ApiCall[] = [];
  const dispatched: Record<string, unknown>[] = [];
  let buildFetches = 0;
  let waited = 0;
  const builds = opts.builds ?? [build()];
  let createSeq = 0;

  const result = await runWorkflowE2E({
    yamlPath: ON_BUILD,
    // The runner short-circuits trigger steps: trigger outputs = workflow inputs,
    // so the audit poke travels as `inputs.body` (the stub below never runs).
    inputs: { body: opts.poke ?? POKE },
    pluginStubs: {
      webhook: {
        handler: () => ok({ body: opts.poke ?? POKE }),
        registryType: 'trigger',
      },
      'signal-wait': {
        handler: () => {
          waited++;
          return ok({ timedOut: true, payload: null });
        },
        executeMode: 'all' as const,
      },
      'sub-workflow': {
        handler: (ctx: { inputs: Record<string, unknown> }) => {
          dispatched.push(ctx.inputs.fix_group as Record<string, unknown>);
          return ok({ executionId: `ex_${dispatched.length}` });
        },
        executeMode: 'all' as const,
      },
      'np-api-call': {
        handler: (ctx: { inputs: Record<string, unknown> }): IStepResult => {
          const method = String(ctx.inputs.method ?? 'GET');
          const path = String(ctx.inputs.path ?? '');
          const call: ApiCall = { method, path };
          if (ctx.inputs.query) call.query = ctx.inputs.query as Record<string, unknown>;
          if (ctx.inputs.body) call.body = ctx.inputs.body as Record<string, unknown>;
          calls.push(call);

          if (method === 'GET' && path === `/build/${BUILD_ID}`) {
            const b = builds[Math.min(buildFetches, builds.length - 1)]!;
            buildFetches++;
            return ok({ status: 200, body: b });
          }
          if (method === 'GET' && path === `/metadata/build/${BUILD_ID}`) {
            return opts.metadataInstances
              ? ok({ status: 200, body: opts.metadataInstances })
              : ok({ status: 404, body: { message: 'not found' } });
          }
          if (method === 'GET' && path === `/application/${APP_ID}`) {
            return ok({ status: 200, body: opts.application ?? APPLICATION });
          }
          if (method === 'GET' && path === '/governance/action_item') {
            return ok({ status: 200, body: { results: opts.existing ?? [] } });
          }
          if (method === 'POST' && path === '/governance/action_item') {
            const fid = String((call.body?.metadata as Record<string, unknown> | undefined)?.finding_id ?? '');
            if ((opts.failCreateFor ?? []).includes(fid)) return stepFailurePermanent(`create failed for ${fid}`);
            createSeq++;
            return ok({ status: 201, body: { id: `ai_new_${createSeq}`, status: 'open' } });
          }
          if (method === 'PATCH' && path.startsWith('/governance/action_item/')) {
            return ok({ status: 200, body: { id: path.split('/')[3] } });
          }
          if (method === 'POST' && path.endsWith('/close')) return ok({ status: 200, body: {} });
          if (method === 'POST' && path.endsWith('/comments')) return ok({ status: 201, body: { id: 'c1' } });
          throw new Error(`unexpected np-api-call: ${method} ${path}`);
        },
        executeMode: 'all' as const,
      },
    },
  });

  const creates = calls.filter((c) => c.method === 'POST' && c.path === '/governance/action_item');
  const patches = calls.filter((c) => c.method === 'PATCH');
  const closes = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/close'));
  const comments = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/comments'));
  const lookups = calls.filter((c) => c.method === 'GET' && c.path === '/governance/action_item');
  return { result, calls, creates, patches, closes, comments, lookups, dispatched, buildFetches, waited };
}

const meta = (c: ApiCall) => (c.body?.metadata ?? {}) as Record<string, unknown>;

describe('wf-a1 autofix-on-build (E2E)', () => {
  it('creates one item per raw finding with cross-build keys, and dispatches one fix group per change', async () => {
    const { result, creates, patches, closes, lookups, dispatched } = await runOnBuild();
    expect(result.outputs.status).toBe('processed');

    // One lookup for the whole repo@branch, scoped by finding_scope + label.
    expect(lookups).toHaveLength(1);
    expect(lookups[0]!.query).toMatchObject({
      'metadata.finding_scope': SCOPE,
      'labels.workflow_type': 'autofix',
    });

    // One item per finding; nothing patched or closed on a first sighting.
    expect(creates).toHaveLength(FINDINGS.length);
    expect(patches).toHaveLength(0);
    expect(closes).toHaveLength(0);

    const axios = creates.find((c) => meta(c).finding_id === FINDINGS[0]!.id)!;
    expect(axios.body).toMatchObject({
      nrn: APPLICATION.nrn,
      category_slug: expect.any(String),
      priority: 'high',
      created_by: 'agent:autofix',
      labels: { workflow_type: 'autofix', finding_category: 'vulnerability', tool: 'aqua', severity: 'high', auto_fixable: 'true' },
    });
    expect(String(axios.body!.title)).toMatch(/^\[HIGH\] GHSA-xxxx-yyyy-zzzz/);
    expect(meta(axios)).toMatchObject({
      finding_key: `${SCOPE}|${FINDINGS[0]!.id}`,
      finding_scope: SCOPE,
      repository: REPO,
      branch: BRANCH,
      package_name: 'axios',
      fixed_version: '1.8.2',
      fix_type: 'upgrade_package',
      fix_group: 'upgrade:npm:axios:1.8.2',
      fix_status: 'pending',
      fix_attempts: 0,
      first_build_id: BUILD_ID,
      last_build_id: BUILD_ID,
      seen_builds: 1,
      seen_build_ids: [BUILD_ID],
      auto_fixable: true,
    });
    expect(String(axios.body!.description)).toContain('Upgrade axios to 1.8.2');
    expect(String(axios.body!.description)).toContain('auto-fixable');

    // Manual findings still become items, marked manual, never dispatched.
    const license = creates.find((c) => meta(c).finding_id === FINDINGS[3]!.id)!;
    expect(meta(license)).toMatchObject({ fix_status: 'manual', auto_fixable: false, fix_group: '' });
    expect((license.body!.labels as Record<string, string>).auto_fixable).toBe('false');
    expect(String(license.body!.description)).toContain('manual');

    // Fix groups: two axios advisories → ONE upgrade group; the XSS → its own.
    expect(dispatched).toHaveLength(2);
    const byKey = Object.fromEntries(dispatched.map((g) => [g.group_key as string, g]));
    const upgrade = byKey['upgrade:npm:axios:1.8.2']!;
    expect(upgrade).toMatchObject({
      fix_type: 'upgrade_package',
      repository: REPO,
      repository_url: `https://github.com/${REPO}`,
      branch: BRANCH,
      build_id: BUILD_ID,
      application_nrn: APPLICATION.nrn,
    });
    const upgradeFindings = upgrade.findings as { finding_key: string; action_item_id: string }[];
    expect(upgradeFindings.map((f) => f.finding_key).sort()).toEqual(
      [`${SCOPE}|${FINDINGS[0]!.id}`, `${SCOPE}|${FINDINGS[1]!.id}`].sort(),
    );
    // Every dispatched finding carries the id of the item just created.
    for (const f of upgradeFindings) expect(f.action_item_id).toMatch(/^ai_new_\d+$/);
    const xss = byKey[`code_change:${FINDINGS[2]!.id}`]!;
    expect((xss.findings as unknown[]).length).toBe(1);

    expect(result.outputs).toMatchObject({
      created: 5,
      updated: 0,
      closed: 0,
      fix_groups_dispatched: 2,
      fix_findings_dispatched: 3,
    });
  });

  it('refreshes a known finding in place (merged metadata, fix_* preserved) instead of creating a duplicate', async () => {
    const existing = liveItem(FINDINGS[0]!.id, { fix_status: 'pr_opened', pr_url: 'https://github.com/x/y/pull/7', fix_attempts: 1 });
    const { result, creates, patches, dispatched } = await runOnBuild({ existing: [existing] });

    expect(creates).toHaveLength(FINDINGS.length - 1);
    expect(creates.some((c) => meta(c).finding_id === FINDINGS[0]!.id)).toBe(false);

    expect(patches).toHaveLength(1);
    expect(patches[0]!.path).toBe(`/governance/action_item/${existing.id}`);
    const m = meta(patches[0]!);
    expect(m).toMatchObject({
      finding_key: `${SCOPE}|${FINDINGS[0]!.id}`,
      first_build_id: '1', // preserved
      last_build_id: BUILD_ID, // moved
      seen_builds: 4, // 3 + this build
      seen_build_ids: ['1', '2', '3', BUILD_ID],
      fix_status: 'pr_opened', // untouched by the refresh
      pr_url: 'https://github.com/x/y/pull/7',
      fix_attempts: 1,
    });
    // Severity rose from the item's medium priority → priority bumped.
    expect(patches[0]!.body!.priority).toBe('high');

    // pr_opened → not re-dispatched; the other axios advisory is new, so the
    // upgrade group still goes out with ONE finding, plus the XSS group.
    expect(dispatched).toHaveLength(2);
    const upgrade = dispatched.find((g) => g.group_key === 'upgrade:npm:axios:1.8.2')!;
    expect((upgrade.findings as { finding_key: string }[]).map((f) => f.finding_key)).toEqual([`${SCOPE}|${FINDINGS[1]!.id}`]);
    expect(result.outputs).toMatchObject({ created: 4, updated: 1 });
  });

  it('closes (then comments on) items whose finding vanished from the build', async () => {
    const gone = liveItem('aqua:CVE-2020-0000:openssl@1.0', { pr_url: 'https://github.com/x/y/pull/3' });
    const { result, closes, comments, patches } = await runOnBuild({ existing: [gone] });
    expect(closes).toHaveLength(1);
    expect(closes[0]!.path).toBe(`/governance/action_item/${gone.id}/close`);
    expect(closes[0]!.body).toEqual({ actor: 'agent:autofix' });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.path).toBe(`/governance/action_item/${gone.id}/comments`);
    expect(String(comments[0]!.body!.content)).toContain('no longer reported by build ' + BUILD_ID);
    expect(String(comments[0]!.body!.content)).toContain('https://github.com/x/y/pull/3');
    expect(patches).toHaveLength(0);
    expect(result.outputs).toMatchObject({ closed: 1, closing_blocked_reason: null });
  });

  it('never closes on a truncated report or when a gate did not run', async () => {
    const gone = liveItem('aqua:CVE-2020-0000:openssl@1.0');
    const truncated = build({ metadata: { quality_metrics: qualityMetrics(FINDINGS, { truncated: true }) } });
    const r1 = await runOnBuild({ existing: [gone], builds: [truncated] });
    expect(r1.closes).toHaveLength(0);
    expect(r1.result.outputs.closing_blocked_reason).toBe('findings_truncated');
    expect(r1.creates).toHaveLength(FINDINGS.length); // creating is still fine

    const gateError = build({ metadata: { quality_metrics: qualityMetrics(FINDINGS, { gateResult: 'error' }) } });
    const r2 = await runOnBuild({ existing: [gone], builds: [gateError] });
    expect(r2.closes).toHaveLength(0);
    expect(String(r2.result.outputs.closing_blocked_reason)).toBe('gate_not_run:sast');
  });

  it('applies the re-dispatch policy: fresh in_progress and exhausted never, failed below the cap yes', async () => {
    const xssId = FINDINGS[2]!.id;
    const recentStart = new Date(Date.now() - 10 * 60000).toISOString();
    const staleStart = new Date(Date.now() - 5 * 3600000).toISOString();

    // fresh in_progress → skip
    const fresh = await runOnBuild({ existing: [liveItem(xssId, { fix_status: 'in_progress', fix_started_at: recentStart, fix_attempts: 1 })] });
    expect(fresh.dispatched.map((g) => g.group_key)).toEqual(['upgrade:npm:axios:1.8.2']);

    // stale in_progress (a dead fixer) → retried
    const stale = await runOnBuild({ existing: [liveItem(xssId, { fix_status: 'in_progress', fix_started_at: staleStart, fix_attempts: 1 })] });
    expect(stale.dispatched.map((g) => g.group_key).sort()).toEqual([`code_change:${xssId}`, 'upgrade:npm:axios:1.8.2']);

    // failed, attempts below the cap → retried
    const failedOnce = await runOnBuild({ existing: [liveItem(xssId, { fix_status: 'failed', fix_attempts: 1 })] });
    expect(failedOnce.dispatched.map((g) => g.group_key)).toContain(`code_change:${xssId}`);

    // failed, at the cap → never again
    const exhausted = await runOnBuild({ existing: [liveItem(xssId, { fix_status: 'failed', fix_attempts: 3 })] });
    expect(exhausted.dispatched.map((g) => g.group_key)).toEqual(['upgrade:npm:axios:1.8.2']);
    // The existing item is still refreshed, and its fix_status is preserved.
    expect(meta(exhausted.patches[0]!)).toMatchObject({ fix_status: 'failed', fix_attempts: 3 });
  });

  it('skips builds that are not successful, and branches that are not watched', async () => {
    const notDone = await runOnBuild({ builds: [build({ status: 'pending' })] });
    expect(notDone.result.outputs).toMatchObject({ status: 'skipped', reason: 'build_not_successful' });
    expect(notDone.lookups).toHaveLength(0);
    expect(notDone.creates).toHaveLength(0);

    const feature = await runOnBuild({ builds: [build({ branch: 'feature/xyz' })] });
    expect(feature.result.outputs).toMatchObject({ status: 'skipped', reason: 'branch_not_watched', branch: 'feature/xyz' });
    expect(feature.lookups).toHaveLength(0);
  });

  it('parks once when a successful build has no findings yet, then proceeds on the re-read', async () => {
    const bare = build({ metadata: {} });
    const { result, buildFetches, waited, creates } = await runOnBuild({ builds: [bare, build()] });
    expect(waited).toBe(1);
    expect(buildFetches).toBe(2);
    expect(creates).toHaveLength(FINDINGS.length);
    expect(result.outputs.status).toBe('processed');
  });

  it('gives up after one wait when the findings never land', async () => {
    const bare = build({ metadata: {} });
    const { result, waited, creates, lookups } = await runOnBuild({ builds: [bare] });
    expect(waited).toBe(1);
    expect(result.outputs).toMatchObject({ status: 'skipped', reason: 'metadata_not_ready' });
    expect(lookups).toHaveLength(0);
    expect(creates).toHaveLength(0);
  });

  it('reads the findings from the metadata instances when the build entity does not embed them', async () => {
    const bare = build({ metadata: {} });
    const { result, creates, waited } = await runOnBuild({
      builds: [bare],
      metadataInstances: { quality_metrics: qualityMetrics(FINDINGS) },
    });
    expect(waited).toBe(0);
    expect(creates).toHaveLength(FINDINGS.length);
  });

  it('a failed create drops that finding from the dispatch but keeps the rest', async () => {
    const { result, dispatched } = await runOnBuild({ failCreateFor: [FINDINGS[0]!.id] });
    expect(result.outputs).toMatchObject({ created: 4 });
    const upgrade = dispatched.find((g) => g.group_key === 'upgrade:npm:axios:1.8.2')!;
    expect((upgrade.findings as { finding_key: string }[]).map((f) => f.finding_key)).toEqual([`${SCOPE}|${FINDINGS[1]!.id}`]);
  });

  it('fails loudly on a poke without a numeric build id (channel wired to the wrong entity)', async () => {
    await expect(
      runOnBuild({ poke: { source: 'audit', notification: { entity: 'release', method: 'POST' } } }),
    ).rejects.toThrow(/no numeric build id in the notification \(entity=release\)/);
  });

  it('YAML shape: webhook trigger, loop target joins with any, no module port routed', async () => {
    const raw = await readFile(ON_BUILD, 'utf8');
    expect(raw).toMatch(/plugin_type: webhook/);
    expect(raw).toMatch(/onTimeout: continue/);
    expect(raw).not.toMatch(/source_port:\s*"?timeout"?/);
    // The wait loop re-enters fetch_build, which must join with `any`.
    expect(raw).toMatch(/id: fetch_build[\s\S]*?join_strategy: any/);
    expect(raw).toMatch(/from: wait_for_metadata,\s*to: fetch_build/);
  });
});

// ── wf-a2 harness ───────────────────────────────────────────────────────────

const GROUP = {
  group_key: 'upgrade:npm:axios:1.8.2',
  fix_type: 'upgrade_package',
  repository: REPO,
  repository_url: `https://github.com/${REPO}`,
  branch: BRANCH,
  commit_sha: '3f9a2c1e7b4d5f6e8c9a0b1d2e3f4a5b6c7d8e9f',
  build_id: BUILD_ID,
  application_id: APP_ID,
  application_nrn: APPLICATION.nrn,
  finding_scope: SCOPE,
  dockerfile: 'Dockerfile',
  manifests: ['package-lock.json'],
  findings: [
    { finding_key: `${SCOPE}|${FINDINGS[0]!.id}`, action_item_id: 'ai_1', finding: FINDINGS[0] },
    { finding_key: `${SCOPE}|${FINDINGS[1]!.id}`, action_item_id: 'ai_2', finding: FINDINGS[1] },
  ],
};

interface FixOpts {
  group?: Record<string, unknown>;
  agent?: Record<string, unknown> | 'throw';
  /** Existing metadata per item id (what GET returns). */
  itemMetadata?: Record<string, Record<string, unknown>>;
  /** Item ids whose GET fails. */
  failFetchFor?: string[];
}

async function runFix(opts: FixOpts = {}) {
  const calls: ApiCall[] = [];
  let agentInputs: Record<string, unknown> | null = null;
  const result = await runWorkflowE2E({
    yamlPath: FIX,
    inputs: { fix_group: opts.group ?? GROUP },
    pluginStubs: {
      manual: { handler: () => ok({}), registryType: 'trigger' },
      'claude-code-agent': {
        handler: (ctx: { inputs: Record<string, unknown> }): IStepResult => {
          agentInputs = ctx.inputs;
          if (opts.agent === 'throw') return stepFailurePermanent('sandbox provisioning failed');
          return ok(
            opts.agent ?? {
              status: 'pr_opened',
              pr_url: `https://github.com/${REPO}/pull/42`,
              pr_number: 42,
              branch: 'autofix/whatever',
              summary: 'Bumped axios to 1.8.2 in package.json and package-lock.json; `npm test` green.',
              verification: 'npm ci && npm test → 214 passed',
              fixed_finding_keys: GROUP.findings.map((f) => f.finding_key),
              unfixed: [],
            },
          );
        },
        executeMode: 'all' as const,
      },
      'np-api-call': {
        handler: (ctx: { inputs: Record<string, unknown> }): IStepResult => {
          const method = String(ctx.inputs.method ?? 'GET');
          const path = String(ctx.inputs.path ?? '');
          const call: ApiCall = { method, path };
          if (ctx.inputs.body) call.body = ctx.inputs.body as Record<string, unknown>;
          calls.push(call);
          const id = path.split('/')[3] ?? '';
          if (method === 'GET' && /^\/governance\/action_item\/[^/]+$/.test(path)) {
            if ((opts.failFetchFor ?? []).includes(id)) return stepFailurePermanent(`404 ${id}`);
            const m = opts.itemMetadata?.[id] ?? { finding_key: `k:${id}`, fix_status: 'pending', fix_attempts: 0, seen_builds: 2 };
            return ok({ status: 200, body: { id, status: 'open', metadata: m } });
          }
          if (method === 'PATCH') return ok({ status: 200, body: { id } });
          if (method === 'POST' && path.endsWith('/comments')) return ok({ status: 201, body: { id: 'c' } });
          throw new Error(`unexpected np-api-call: ${method} ${path}`);
        },
        executeMode: 'all' as const,
      },
    },
  });
  const patches = calls.filter((c) => c.method === 'PATCH');
  const comments = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/comments'));
  const fetches = calls.filter((c) => c.method === 'GET');
  return { result, calls, patches, comments, fetches, agentInputs: agentInputs as Record<string, unknown> | null };
}

describe('wf-a2 autofix-fix (E2E)', () => {
  it('stamps in_progress from fetched metadata, then records the PR on every fixed item', async () => {
    const { result, patches, comments, fetches, agentInputs } = await runFix({
      itemMetadata: { ai_1: { finding_key: 'k1', fix_status: 'failed', fix_attempts: 1, seen_builds: 4, custom: 'kept' } },
    });
    expect(fetches.map((c) => c.path).sort()).toEqual(['/governance/action_item/ai_1', '/governance/action_item/ai_2']);

    // Pass 1: in_progress, attempts +1, other metadata preserved.
    const inProgress = patches.filter((p) => meta(p).fix_status === 'in_progress');
    expect(inProgress).toHaveLength(2);
    const ip1 = inProgress.find((p) => p.path.endsWith('/ai_1'))!;
    expect(meta(ip1)).toMatchObject({ fix_attempts: 2, seen_builds: 4, custom: 'kept', fix_group: GROUP.group_key });
    expect(String(meta(ip1).fix_branch)).toMatch(/^autofix\/upgrade-npm-axios-1\.8\.2-[0-9a-f]{8}$/);
    expect(meta(ip1).fix_execution_id).toBeTruthy();

    // The agent got the brief through declared inputs (never steps.* in config).
    expect(agentInputs).not.toBeNull();
    expect(String(agentInputs!.brief)).toContain('Work branch (use EXACTLY this name)');
    expect(String(agentInputs!.brief)).toContain(FINDINGS[0]!.id);
    expect(String(agentInputs!.brief)).toContain('npm install axios@^1.8.2');
    expect(agentInputs!.base_branch).toBe(BRANCH);
    expect(String(agentInputs!.pr_title)).toMatch(/^fix\(security\): upgrade axios to 1\.8\.2/);

    // Pass 2: pr_opened with the URL on both items, and a comment each.
    const opened = patches.filter((p) => meta(p).fix_status === 'pr_opened');
    expect(opened).toHaveLength(2);
    for (const p of opened) {
      expect(meta(p)).toMatchObject({ pr_url: `https://github.com/${REPO}/pull/42`, pr_number: 42, fix_attempts: expect.any(Number) });
      expect(String(meta(p).fix_summary)).toContain('Bumped axios');
    }
    expect(comments).toHaveLength(2);
    for (const c of comments) expect(String(c.body!.content)).toContain(`https://github.com/${REPO}/pull/42`);

    expect(result.outputs).toMatchObject({
      status: 'pr_opened',
      pr_url: `https://github.com/${REPO}/pull/42`,
      pr_number: 42,
      items: 2,
      items_pr_opened: 2,
      items_failed: 0,
    });
  });

  it('marks unfixed findings failed with their reason while the rest get the PR', async () => {
    const { result, patches, comments } = await runFix({
      agent: {
        status: 'pr_opened',
        pr_url: `https://github.com/${REPO}/pull/43`,
        pr_number: 43,
        summary: 'Bumped axios.',
        fixed_finding_keys: [GROUP.findings[0]!.finding_key],
        unfixed: [{ finding_key: GROUP.findings[1]!.finding_key, reason: 'lockfile conflict in a vendored copy' }],
      },
    });
    const final = patches.filter((p) => meta(p).fix_status !== 'in_progress');
    const a1 = final.find((p) => p.path.endsWith('/ai_1'))!;
    const a2 = final.find((p) => p.path.endsWith('/ai_2'))!;
    expect(meta(a1)).toMatchObject({ fix_status: 'pr_opened', pr_url: `https://github.com/${REPO}/pull/43` });
    expect(meta(a2)).toMatchObject({ fix_status: 'failed', fix_error: 'lockfile conflict in a vendored copy' });
    expect(meta(a2).pr_url).toBe('');
    const c2 = comments.find((c) => c.path.includes('/ai_2/'))!;
    expect(String(c2.body!.content)).toContain('could not fix this one: lockfile conflict');
    expect(result.outputs).toMatchObject({ items_pr_opened: 1, items_failed: 1 });
  });

  it('records already_fixed and failed outcomes', async () => {
    const fixed = await runFix({ agent: { status: 'already_fixed', summary: 'package.json already pins axios 1.8.2', fixed_finding_keys: [], unfixed: [] } });
    for (const p of fixed.patches.filter((p) => meta(p).fix_status !== 'in_progress')) {
      expect(meta(p).fix_status).toBe('already_fixed');
    }
    expect(fixed.result.outputs.status).toBe('already_fixed');

    const failed = await runFix({ agent: { status: 'failed', summary: 'npm install failed: ERESOLVE', fixed_finding_keys: [], unfixed: [] } });
    for (const p of failed.patches.filter((p) => meta(p).fix_status !== 'in_progress')) {
      expect(meta(p)).toMatchObject({ fix_status: 'failed', fix_error: 'npm install failed: ERESOLVE' });
    }
    expect(failed.comments.every((c) => String(c.body!.content).includes('could not fix'))).toBe(true);
    expect(failed.result.outputs).toMatchObject({ status: 'failed', items_failed: 2 });
  });

  it('downgrades a pr_opened claim without a URL to failed (no invented PRs)', async () => {
    const { result, patches } = await runFix({ agent: { status: 'pr_opened', summary: 'done', fixed_finding_keys: [], unfixed: [] } });
    expect(result.outputs.status).toBe('failed');
    for (const p of patches.filter((p) => meta(p).fix_status !== 'in_progress')) expect(meta(p).fix_status).toBe('failed');
  });

  it('an agent step failure takes the fallback chain: items stamped failed and commented', async () => {
    const { result, patches, comments } = await runFix({ agent: 'throw' });
    const final = patches.filter((p) => meta(p).fix_status !== 'in_progress');
    expect(final).toHaveLength(2);
    for (const p of final) {
      expect(meta(p)).toMatchObject({ fix_status: 'failed' });
      expect(String(meta(p).fix_error)).toContain('sandbox provisioning failed');
    }
    expect(comments).toHaveLength(2);
    expect(String(comments[0]!.body!.content)).toContain('run failed');
    expect(result.outputs).toMatchObject({ status: 'failed', items: 2 });
  });

  it('never patches an item whose metadata could not be fetched (no blind writes), but still comments', async () => {
    const { result, patches, comments } = await runFix({ failFetchFor: ['ai_2'] });
    expect(patches.some((p) => p.path.endsWith('/ai_2'))).toBe(false);
    expect(patches.filter((p) => p.path.endsWith('/ai_1'))).toHaveLength(2); // in_progress + outcome
    expect(comments.map((c) => c.path).sort()).toEqual(['/governance/action_item/ai_1/comments', '/governance/action_item/ai_2/comments']);
  });

  it('derives the same work branch for the same group (idempotent dispatch)', async () => {
    const a = await runFix();
    const b = await runFix();
    const branchOf = (r: Awaited<ReturnType<typeof runFix>>) => String(r.agentInputs!.branch_name);
    expect(branchOf(a)).toBe(branchOf(b));
    expect(branchOf(a)).toMatch(/^autofix\/upgrade-npm-axios-1\.8\.2-[0-9a-f]{8}$/);
    const other = await runFix({ group: { ...GROUP, group_key: `code_change:${FINDINGS[2]!.id}`, fix_type: 'code_change', findings: [{ finding_key: 'k', action_item_id: 'ai_9', finding: FINDINGS[2] }] } });
    expect(branchOf(other)).not.toBe(branchOf(a));
    expect(String(other.agentInputs!.pr_title)).toBe('fix(security): Reflected XSS: request query parameter written to response without encoding');
  });

  it('fails loudly on a malformed fix group', async () => {
    await expect(runFix({ group: { group_key: 'x', repository: REPO, branch: BRANCH, findings: [] } })).rejects.toThrow(
      /invalid fix_group: group_key=x .* findings=0/,
    );
  });

  it('YAML shape: agent prompts use declared inputs, token only via env, fallback edge declared false', async () => {
    const raw = await readFile(FIX, 'utf8');
    const agentStep = raw.slice(raw.indexOf('- id: agent\n'), raw.indexOf('- id: record\n'));
    // Only the plugin CONFIG is forbidden from touching steps.*; the declared
    // inputs map is exactly where those references belong.
    const agentBlock = agentStep.slice(agentStep.indexOf('    config:'));
    expect(agentBlock).not.toMatch(/\$\{\{\s*steps\./);
    expect(agentBlock).toMatch(/GITHUB_TOKEN: "\$\{\{ secrets\.GITHUB_TOKEN \}\}"/);
    expect(agentBlock).toMatch(/fallback_step: agent_failed/);
    expect(raw).toMatch(/from: agent,\s*to: agent_failed,\s*condition: "false"/);
  });
});
