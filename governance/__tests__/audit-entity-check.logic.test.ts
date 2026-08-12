/**
 * @file Unit tests for the deterministic JavaScript of `audit-entity-check`.
 *
 * The E2E suite stubs `code-exec` by step id, so the bodies of `signals` and
 * `gather` never run there. They are pure functions of their `$item` plus HTTP,
 * so here the `config.code` block is read straight out of the YAML and executed
 * with a fake `fetch` — no network, and the assertions are on the real source
 * that ships, not on a copy.
 *
 * Covered:
 *  - the enhancer `entityConfig` key extractor (the shapes a real app.js takes:
 *    section comments, read-before-declaration, quoted keys, spread),
 *  - the probe verdicts that depend on the `clients` map and on unreachable
 *    hosts,
 *  - data flags vs degraded sources (missing config entries, lake errors),
 *  - the carry-over decision matrix of `gather`.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parse } from 'yaml';

const WF_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'audit-entity-check.yaml');

interface WorkflowDoc {
  steps: Array<{ id: string; config?: { code?: string } }>;
}

function stepCode(stepId: string): string {
  const doc = parse(readFileSync(WF_PATH, 'utf8')) as WorkflowDoc;
  const code = doc.steps.find((s) => s.id === stepId)?.config?.code;
  if (typeof code !== 'string') throw new Error(`step "${stepId}" has no config.code`);
  return code;
}

type FakeFetch = (url: string, init?: Record<string, unknown>) => Promise<FakeResponse>;

interface FakeResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}

function res(status: number, body: unknown): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
  };
}

/** Runs a `code-exec` body as an async function of ($item, fetch). */
async function runStepCode<T>(
  code: string,
  item: Record<string, unknown>,
  fetchImpl: FakeFetch,
): Promise<T> {
  const body = new Function('$item', 'fetch', `return (async () => {\n${code}\n})();`) as (
    item: Record<string, unknown>,
    fetchImpl: FakeFetch,
  ) => Promise<T>;
  return body(item, fetchImpl);
}

// --------------------------------------------------------------------------
// signals
// --------------------------------------------------------------------------

const SIGNALS_CODE = stepCode('signals');

interface DataFlag {
  entity: string | null;
  text: string;
}

interface Probe {
  entity: string;
  entity_id?: string;
  status?: number;
  alt_host?: string | null;
  verdict: string;
}

interface SignalsOutput {
  data_flags: DataFlag[];
  degraded_sources: string[];
  entity_config_keys: string[];
  entity_config_trusted: boolean;
  probes: Probe[];
  signals_view: string;
}

const DEFAULT_ITEM = {
  github_token: 'gh_token',
  enhancer_api_key: 'enh_key',
  enhancer_repo: 'nullplatform/data-audit-stream-enhancer',
  new_entity_rows: [],
  empty_row_rows: [],
};

interface SignalsFetchOptions {
  appJs?: string;
  /** Status per probe URL; 'throw' simulates no HTTP response at all. */
  probe?: (url: string) => number | 'throw';
  urls?: string[];
}

function signalsFetch(opts: SignalsFetchOptions): FakeFetch {
  return async (url) => {
    opts.urls?.push(url);
    if (url.startsWith('https://api.github.com/')) return res(200, opts.appJs ?? '');
    if (url === 'https://authz.nullplatform.io/token') return res(200, { access_token: 'probe_tok' });
    const code = opts.probe ? opts.probe(url) : 200;
    if (code === 'throw') throw new Error('connect ECONNREFUSED');
    return res(code, {});
  };
}

const runSignals = (
  item: Record<string, unknown>,
  opts: SignalsFetchOptions = {},
): Promise<SignalsOutput> =>
  runStepCode<SignalsOutput>(SIGNALS_CODE, { ...DEFAULT_ITEM, ...item }, signalsFetch(opts));

/** app.js with section comments between entries — the enhancer's real layout. */
const APP_JS_SECTION_COMMENTS = `
const clients = {
  user: usersClient,
};

const entityConfig = {
  // STANDARD: enriched via GET
  application: { type: STANDARD },
  scope: { type: STANDARD },
  // SELF_CONTAINED: enriched from the body
  service: { type: SELF_CONTAINED },
};
`;

/** app.js that reads entityConfig above its declaration. */
const APP_JS_READ_BEFORE_DECL = `
function pick(entity) {
  const cfg = entityConfig[entity] || { type: STANDARD, fallback: true };
  return cfg;
}
const entityConfig = { application: { type: 1 }, scope: { type: 2 } };
`;

/** Quoted keys, a brace inside a block comment and one inside a string. */
const APP_JS_QUOTED_KEYS = `
const entityConfig = {
  "application": { type: STANDARD },
  'scope': { type: STANDARD },
  /* } */
  service: { type: SELF_CONTAINED, path: "/service/{id}" },
};
`;

const APP_JS_SPREAD = `
const entityConfig = {
  application: { type: STANDARD },
  ...legacyEntityConfig,
};
`;

const NEW_ENTITY = {
  entity: 'runbook',
  first_seen: '2026-08-01',
  writes: 12,
  methods: ['POST'],
  sample_entity_id: 'rb_1',
};

describe('audit-entity-check signals — entityConfig extraction', () => {
  it('keeps the real keys when section comments sit between entries', async () => {
    const out = await runSignals({ new_entity_rows: [] }, { appJs: APP_JS_SECTION_COMMENTS });
    expect(out.entity_config_keys).toEqual(['application', 'scope', 'service']);
    expect(out.entity_config_trusted).toBe(true);
  });

  it('anchors on the declaration, not on an earlier read of the name', async () => {
    const out = await runSignals({}, { appJs: APP_JS_READ_BEFORE_DECL });
    expect(out.entity_config_keys).toEqual(['application', 'scope']);
    expect(out.entity_config_trusted).toBe(true);
  });

  it('reads quoted keys and ignores braces inside comments and strings', async () => {
    const out = await runSignals({}, { appJs: APP_JS_QUOTED_KEYS });
    expect(out.entity_config_keys).toEqual(['application', 'scope', 'service']);
    expect(out.entity_config_trusted).toBe(true);
  });

  it('does not report an entity as unconfigured when it IS configured', async () => {
    const out = await runSignals(
      { new_entity_rows: [{ ...NEW_ENTITY, entity: 'service' }] },
      { appJs: APP_JS_SECTION_COMMENTS },
    );
    expect(out.data_flags.filter((f) => f.text.includes('entityConfig'))).toEqual([]);
  });

  it('flags a genuinely new entity as missing from the entityConfig', async () => {
    const out = await runSignals(
      { new_entity_rows: [NEW_ENTITY] },
      { appJs: APP_JS_SECTION_COMMENTS },
    );
    const missing = out.data_flags.find((f) => f.text.includes('missing from the enhancer entityConfig'));
    expect(missing?.entity).toBe('runbook');
  });

  it('distrusts a spread literal and skips the per-entity comparison', async () => {
    const out = await runSignals({ new_entity_rows: [NEW_ENTITY] }, { appJs: APP_JS_SPREAD });
    expect(out.entity_config_trusted).toBe(false);
    expect(out.degraded_sources.join(' ')).toContain('not parsed with confidence');
    expect(out.degraded_sources.join(' ')).toContain('spreads another object');
    expect(out.data_flags.filter((f) => f.text.includes('entityConfig'))).toEqual([]);
  });

  it('distrusts a key list without the known `application` entry', async () => {
    const out = await runSignals(
      { new_entity_rows: [NEW_ENTITY] },
      { appJs: 'const entityConfig = { widget: { type: STANDARD } };' },
    );
    expect(out.entity_config_trusted).toBe(false);
    expect(out.degraded_sources.join(' ')).toContain('no "application" key');
    expect(out.data_flags.filter((f) => f.text.includes('entityConfig'))).toEqual([]);
  });

  it('degrades when app.js has no entityConfig declaration', async () => {
    const out = await runSignals({}, { appJs: 'module.exports = {};' });
    expect(out.entity_config_trusted).toBe(false);
    expect(out.degraded_sources.join(' ')).toContain('entityConfig unavailable');
  });

  it('puts the clients block in the excerpt, or says it was not found', async () => {
    const withClients = await runSignals({}, { appJs: APP_JS_SECTION_COMMENTS });
    expect(withClients.signals_view).toContain('--- clients ---');
    expect(withClients.signals_view).toContain('usersClient');
    const withoutClients = await runSignals({}, { appJs: APP_JS_QUOTED_KEYS });
    expect(withoutClients.signals_view).toContain('no `const clients = {…}` declaration found');
  });
});

describe('audit-entity-check signals — probe verdicts', () => {
  const ALT = 'https://users.nullplatform.io';
  const rowsFor = (entity: string) => [{ ...NEW_ENTITY, entity, sample_entity_id: 'id_1' }];
  /** 404 on the default host, 200 on users.nullplatform.io. */
  const altHostProbe = (url: string) => (url.startsWith(ALT) ? 200 : 404);

  it('does not call a legit non-default host a wrong_host when clients declares it', async () => {
    const out = await runSignals(
      { new_entity_rows: rowsFor('user') },
      { appJs: APP_JS_SECTION_COMMENTS, probe: altHostProbe },
    );
    const probe = out.probes.find((p) => p.entity === 'user');
    expect(probe?.verdict).toBe('answers_on_alt_host');
    expect(probe?.alt_host).toBe(ALT);
  });

  it('escalates to wrong_host when the clients map has no trace of that host', async () => {
    const out = await runSignals(
      { new_entity_rows: rowsFor('widget') },
      { appJs: APP_JS_SECTION_COMMENTS, probe: altHostProbe },
    );
    expect(out.probes.find((p) => p.entity === 'widget')?.verdict).toBe('wrong_host');
  });

  it('stays on answers_on_alt_host when the clients map could not be parsed', async () => {
    const out = await runSignals(
      { new_entity_rows: rowsFor('widget') },
      { appJs: APP_JS_QUOTED_KEYS, probe: altHostProbe },
    );
    expect(out.probes.find((p) => p.entity === 'widget')?.verdict).toBe('answers_on_alt_host');
  });

  it('reports a failed request as an unreachable probe, not as a DLQ risk', async () => {
    const out = await runSignals(
      { new_entity_rows: rowsFor('application') },
      { appJs: APP_JS_SECTION_COMMENTS, probe: () => 'throw' },
    );
    expect(out.probes.find((p) => p.entity === 'application')?.verdict).toBe('probe_unreachable');
    expect(out.degraded_sources.join(' ')).toContain('no HTTP response');
    expect(out.data_flags).toEqual([]);
  });

  it('still calls a 5xx a DLQ risk', async () => {
    const out = await runSignals(
      { new_entity_rows: rowsFor('application') },
      { appJs: APP_JS_SECTION_COMMENTS, probe: () => 503 },
    );
    expect(out.probes.find((p) => p.entity === 'application')?.verdict).toBe(
      'upstream_error_dlq_risk',
    );
    expect(out.data_flags.map((f) => f.entity)).toContain('application');
  });

  it('rejects entity names that are not a single path segment and escapes the rest', async () => {
    const urls: string[] = [];
    const out = await runSignals(
      {
        new_entity_rows: [
          { ...NEW_ENTITY, entity: 'user/../admin', sample_entity_id: 'x' },
          { ...NEW_ENTITY, entity: 'application', sample_entity_id: 'a:b' },
        ],
      },
      { appJs: APP_JS_SECTION_COMMENTS, urls },
    );
    expect(out.probes.find((p) => p.entity === 'user/../admin')?.verdict).toBe(
      'skipped_unsafe_name',
    );
    expect(urls.some((u) => u.includes('..'))).toBe(false);
    expect(urls.some((u) => u.endsWith('/application/a%3Ab'))).toBe(true);
  });

  it('probes at most four entities', async () => {
    const rows = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((entity) => ({
      ...NEW_ENTITY,
      entity,
      sample_entity_id: 'id',
    }));
    const out = await runSignals({ new_entity_rows: rows }, { appJs: APP_JS_SECTION_COMMENTS });
    expect(out.probes).toHaveLength(4);
  });
});

describe('audit-entity-check signals — degraded sources', () => {
  it('reports a missing config entry instead of calling out with "undefined"', async () => {
    const urls: string[] = [];
    const out = await runSignals(
      { github_token: undefined, enhancer_api_key: '', new_entity_rows: [NEW_ENTITY] },
      { urls },
    );
    expect(out.degraded_sources).toContain(
      'config entry GITHUB_TOKEN missing — enhancer entityConfig not read',
    );
    expect(out.degraded_sources).toContain(
      'config entry ENHANCER_API_KEY missing — fetch probe skipped',
    );
    expect(urls).toEqual([]);
    expect(out.data_flags).toEqual([]);
  });

  it('reports a lake query failure as a degraded source, never as a data flag', async () => {
    const out = await runSignals(
      {
        new_entity_rows: undefined,
        new_entities_error: 'NP_LAKE_5XX: gateway timeout',
        empty_row_rows: [],
      },
      { appJs: APP_JS_SECTION_COMMENTS },
    );
    expect(out.degraded_sources).toContain(
      'lake unavailable (new entities): NP_LAKE_5XX: gateway timeout',
    );
    expect(out.data_flags).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// gather
// --------------------------------------------------------------------------

const GATHER_CODE = stepCode('gather');

const SHA_PREV = 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222';
const SHA_CURRENT = 'cccc3333cccc3333cccc3333cccc3333cccc3333';

interface GatherOutput {
  mode: string;
  scope?: string;
  repo: string;
  analyzed_sha: string;
  changed_count: number | null;
  prev: { status: string; sha: string; entities?: Array<{ entity: string }> } | null;
}

interface GatherFetchOptions {
  itemId?: string;
  prevStatus?: string;
  prevSha?: string;
  prevEntities?: Array<{ entity: string }>;
  changedFiles?: string[];
  /** Omit to have the prior approval list come back empty (no checkpoint). */
  withCheckpoint?: boolean;
}

function gatherFetch(opts: GatherFetchOptions): FakeFetch {
  const itemId = opts.itemId ?? 'audit_entity_check';
  return async (url) => {
    if (url === 'https://api.nullplatform.com/token') return res(200, { access_token: 'np_tok' });
    if (url.includes('/application/')) {
      return res(200, {
        name: 'some-api',
        nrn: 'organization=1:application=2',
        repository_url: 'https://github.com/nullplatform/some-api',
      });
    }
    if (url.includes('/approval?nrn=')) {
      return res(200, {
        results: opts.withCheckpoint === false ? [] : [{ id: 8000, mode: 'checklist' }],
      });
    }
    if (url.includes('/approval/8000/checklist')) {
      return res(200, {
        items: [
          {
            id: itemId,
            status: opts.prevStatus ?? 'passed',
            details: {
              analyzed_sha: opts.prevSha ?? SHA_PREV,
              findings: [],
              entities: opts.prevEntities ?? [],
              markdown: '### Audit coverage — PASSED',
            },
          },
        ],
      });
    }
    if (url.includes('/compare/')) {
      return res(200, {
        files: (opts.changedFiles ?? []).map((filename) => ({ filename })),
        commits: [{ sha: SHA_CURRENT }],
      });
    }
    if (url.includes('/git/trees/')) {
      return res(200, { tree: [{ path: 'src/index.js', type: 'blob', size: 500 }] });
    }
    if (url.includes('/contents/')) return res(200, 'export const app = 1;');
    if (url.includes('api.github.com/repos/')) return res(200, { default_branch: 'main' });
    return res(404, {});
  };
}

const GATHER_ITEM = {
  application_id: 924036609,
  release_id: 734671234,
  trigger_build: { branch: 'main', commit: { id: SHA_CURRENT } },
  item_id: 'audit_entity_check',
  callbackUrl: 'https://approval-api.test/approval/9001/checklist/items/audit_entity_check',
  data_flags: [] as DataFlag[],
  np_api_key: 'np_key',
  github_token: 'gh_token',
};

const runGather = (
  item: Record<string, unknown> = {},
  opts: GatherFetchOptions = {},
): Promise<GatherOutput> =>
  runStepCode<GatherOutput>(GATHER_CODE, { ...GATHER_ITEM, ...item }, gatherFetch(opts));

describe('audit-entity-check gather — carry-over decision', () => {
  it('carries over when the sha is unchanged and there are no data flags', async () => {
    const out = await runGather({}, { prevSha: SHA_CURRENT });
    expect(out.mode).toBe('carry_over');
    expect(out.prev?.status).toBe('passed');
  });

  it('re-analyses in verify_fix mode when the previous verdict failed', async () => {
    const out = await runGather({}, { prevSha: SHA_CURRENT, prevStatus: 'failed' });
    expect(out.mode).toBe('analyze');
    expect(out.scope).toBe('verify_fix');
  });

  it('analyses a full repo when there is no checkpoint at all', async () => {
    const out = await runGather({}, { withCheckpoint: false });
    expect(out.mode).toBe('analyze');
    expect(out.scope).toBe('full');
    expect(out.prev).toBeNull();
  });

  it('carries over when only docs and tests changed', async () => {
    const out = await runGather(
      {},
      { changedFiles: ['README.md', 'docs/guide.md', '__tests__/app.test.ts'] },
    );
    expect(out.mode).toBe('carry_over');
    expect(out.changed_count).toBe(3);
  });

  it('treats a .cjs source file as audit-relevant', async () => {
    const out = await runGather({}, { changedFiles: ['src/routes/runbook.cjs'] });
    expect(out.mode).toBe('analyze');
    expect(out.scope).toBe('diff');
  });

  it('ignores a data flag about an entity this application does not write', async () => {
    const out = await runGather(
      { data_flags: [{ entity: 'someone_elses_entity', text: 'organization-wide noise' }] },
      { prevSha: SHA_CURRENT, prevEntities: [{ entity: 'runbook' }] },
    );
    expect(out.mode).toBe('carry_over');
  });

  it('re-analyses on a data flag about an entity this application writes', async () => {
    const out = await runGather(
      { data_flags: [{ entity: 'runbook', text: 'runbook has 40% empty rows' }] },
      { prevSha: SHA_CURRENT, prevEntities: [{ entity: 'runbook' }] },
    );
    expect(out.mode).toBe('analyze');
    expect(out.scope).toBe('diff');
  });

  it('re-analyses on any data flag while no entity list is known yet', async () => {
    const out = await runGather(
      { data_flags: [{ entity: 'someone_elses_entity', text: 'organization-wide noise' }] },
      { prevSha: SHA_CURRENT, prevEntities: [] },
    );
    expect(out.mode).toBe('analyze');
    expect(out.scope).toBe('diff');
  });

  it('falls back to the dispatch itemId when the item carries no check_id', async () => {
    const out = await runGather(
      { item_id: 'from_the_dispatch' },
      { itemId: 'from_the_dispatch', prevSha: SHA_CURRENT },
    );
    expect(out.mode).toBe('carry_over');
  });

  it('prefers an explicit check_id over the dispatch itemId', async () => {
    const out = await runGather(
      { check_id: 'override_id', item_id: 'from_the_dispatch' },
      { itemId: 'override_id', prevSha: SHA_CURRENT },
    );
    expect(out.mode).toBe('carry_over');
  });
});
