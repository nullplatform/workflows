/**
 * @file Unit tests for the deterministic JavaScript of `audit-entity-check`.
 *
 * The E2E suite stubs `code-exec` by step id, so the bodies of `signals`,
 * `gather`, `resolve` and `resolve_carryover` never run there. They are pure
 * functions of their `$item` plus HTTP, so here the `config.code` block is read
 * straight out of the YAML and executed with a fake `fetch` — no network, and
 * the assertions are on the real source that ships, not on a copy.
 *
 * `fixtures/enhancer/` holds verbatim copies of `audit-ennhancer/app.js` and
 * `audit-ennhancer/audit_enhancer.js` from `nullplatform/data-audit-stream-enhancer`.
 * They are the shapes the extractor has to survive in production: `entityConfig`
 * and `clients` are properties of a constructor call, ~20 keys are computed
 * (`[ENTITIES.USER]:`), 16 more arrive through `...selfContained(…)`, and the
 * entity names those constants stand for live in the other file. Synthetic
 * fixtures cover the variants the real files do not have.
 *
 * Covered:
 *  - the `entityConfig` / `clients` / `ENTITIES` extraction, the sanity gates
 *    that refuse to conclude anything from an incomplete key set, and the
 *    comment/string decoys an anchor must not fall for,
 *  - the probe verdicts, including the `clients` lookup, the two-segment entity
 *    names the enhancer configures, traversal attempts and unreachable hosts,
 *  - data flags vs degraded sources (missing config entries, lake errors),
 *  - the carry-over decision matrix of `gather`,
 *  - what both resolves PATCH back to the approval API.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parse } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const WF_PATH = resolve(HERE, '..', 'audit-entity-check.yaml');

const REAL_APP_JS = readFileSync(resolve(HERE, 'fixtures', 'enhancer', 'app.js'), 'utf8');
const REAL_ENHANCER_JS = readFileSync(
  resolve(HERE, 'fixtures', 'enhancer', 'audit_enhancer.js'),
  'utf8',
);

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
  /** Served for `audit-ennhancer/app.js`; defaults to the real file. */
  appJs?: string;
  /** Served for `audit-ennhancer/audit_enhancer.js`; null answers 404. */
  enhancerJs?: string | null;
  /** Status per probe URL; 'throw' simulates no HTTP response at all. */
  probe?: (url: string) => number | 'throw';
  urls?: string[];
}

function signalsFetch(opts: SignalsFetchOptions): FakeFetch {
  return async (url) => {
    opts.urls?.push(url);
    if (url.endsWith('/audit_enhancer.js')) {
      const body = opts.enhancerJs === undefined ? REAL_ENHANCER_JS : opts.enhancerJs;
      return body === null ? res(404, 'Not Found') : res(200, body);
    }
    if (url.startsWith('https://api.github.com/')) {
      return res(200, opts.appJs ?? REAL_APP_JS);
    }
    if (url === 'https://authz.nullplatform.io/token') {
      return res(200, { access_token: 'probe_tok' });
    }
    const code = opts.probe ? opts.probe(url) : 200;
    if (code === 'throw') throw new Error('connect ECONNREFUSED');
    return res(code, {});
  };
}

const runSignals = (
  item: Record<string, unknown> = {},
  opts: SignalsFetchOptions = {},
): Promise<SignalsOutput> =>
  runStepCode<SignalsOutput>(SIGNALS_CODE, { ...DEFAULT_ITEM, ...item }, signalsFetch(opts));

/** Declaration form, section comments between entries. */
const APP_JS_SECTION_COMMENTS = `
const clients = {
  user: usersClient,
};

const entityConfig = {
  // STANDARD: enriched via GET
  user: { type: STANDARD },
  parameter: { type: STANDARD },
  // SELF_CONTAINED: enriched from the body
  service: { type: SELF_CONTAINED },
  nrn: { type: NRN },
  default: { type: STANDARD },
};
`;

/** Reads entityConfig above its own declaration, everything on one line. */
const APP_JS_READ_BEFORE_DECL = `
function pick(entity) {
  const cfg = entityConfig[entity] || { type: STANDARD, fallback: true };
  return cfg;
}
const entityConfig = { user: { t: 1 }, parameter: { t: 2 }, service: {}, nrn: {}, default: {} };
`;

/** Quoted keys, a brace inside a block comment and one inside a string. */
const APP_JS_QUOTED_KEYS = `
const entityConfig = {
  "user": { type: STANDARD },
  'parameter': { type: STANDARD },
  /* } */
  service: { type: SELF_CONTAINED, path: "/service/{id}" },
  "notification/channel": { type: SELF_CONTAINED },
  default: { type: STANDARD },
};
`;

/** A spread of an unknown object: the key list cannot be complete. */
const APP_JS_BARE_SPREAD = `
const entityConfig = {
  user: { type: STANDARD },
  parameter: { type: STANDARD },
  ...legacyEntityConfig,
  default: { type: STANDARD },
};
`;

const NEW_ENTITY = {
  entity: 'runbook',
  first_seen: '2026-08-01',
  writes: 12,
  methods: ['POST'],
  sample_entity_id: 'rb_1',
};

/** The keys of the real entityConfig, in source order. */
const REAL_KEYS = [
  'user',
  'parameter',
  'runtime_configuration',
  'runtime_configuration/dimension',
  'dimension',
  'action_item',
  'action_item_category',
  'authz_action',
  'service',
  'service_specification',
  'link',
  'link_specification',
  'action',
  'action_specification',
  'packages',
  'package',
  'artifacts',
  'agent',
  'login_success',
  'notification',
  'notification/channel',
  'nrn',
  'workflow',
  'workflow_alias',
  'workflow_config_entry',
  'workflow_secret',
  'workflow_execution',
  'workflow_signal',
  'workflow_webhook',
  'default',
];

describe('audit-entity-check signals — entityConfig extraction (real enhancer)', () => {
  it('reads both maps out of the real app.js, resolving computed keys and spreads', async () => {
    const urls: string[] = [];
    const out = await runSignals({}, { urls });
    // The sources live under audit-ennhancer/ (double n in the repo).
    expect(urls).toContain(
      'https://api.github.com/repos/nullplatform/data-audit-stream-enhancer/contents/audit-ennhancer/app.js',
    );
    expect(urls).toContain(
      'https://api.github.com/repos/nullplatform/data-audit-stream-enhancer/contents/audit-ennhancer/audit_enhancer.js',
    );
    expect(out.entity_config_keys).toEqual(REAL_KEYS);
    expect(out.entity_config_trusted).toBe(true);
    // Computed key resolved through ENTITIES, and one of the 16 spread ones.
    expect(out.entity_config_keys).toContain('notification/channel');
    expect(out.entity_config_keys).toContain('workflow_webhook');
    expect(out.signals_view).toContain('--- clients ---');
    expect(out.signals_view).toContain('entity_hook');
  });

  it('distrusts the key set when the ENTITIES map cannot be read', async () => {
    const out = await runSignals({ new_entity_rows: [NEW_ENTITY] }, { enhancerJs: null });
    expect(out.entity_config_trusted).toBe(false);
    expect(out.degraded_sources.join(' ')).toContain('key position(s) unresolved');
    // An incomplete key set must not produce "not configured" flags.
    expect(out.data_flags.filter((f) => f.text.includes('entityConfig'))).toEqual([]);
  });

  it('does not flag an entity the real map configures', async () => {
    const out = await runSignals({
      new_entity_rows: [{ ...NEW_ENTITY, entity: 'workflow_secret' }],
    });
    expect(out.data_flags.filter((f) => f.text.includes('entityConfig'))).toEqual([]);
  });

  it('reports an unlisted entity as falling back to the default entry', async () => {
    const out = await runSignals({ new_entity_rows: [NEW_ENTITY] });
    const flag = out.data_flags.find((f) => f.entity === 'runbook');
    expect(flag?.text).toContain('no dedicated enhancer entityConfig entry');
    expect(flag?.text).toContain('falls back to "default"');
  });
});

describe('audit-entity-check signals — entityConfig extraction (other shapes)', () => {
  it('keeps the real keys when section comments sit between entries', async () => {
    const out = await runSignals({}, { appJs: APP_JS_SECTION_COMMENTS });
    expect(out.entity_config_keys).toEqual(['user', 'parameter', 'service', 'nrn', 'default']);
    expect(out.entity_config_trusted).toBe(true);
  });

  it('anchors on the declaration, not on an earlier read of the name', async () => {
    const out = await runSignals({}, { appJs: APP_JS_READ_BEFORE_DECL });
    expect(out.entity_config_keys).toEqual(['user', 'parameter', 'service', 'nrn', 'default']);
    expect(out.entity_config_trusted).toBe(true);
  });

  it('reads quoted keys and ignores braces inside comments and strings', async () => {
    const out = await runSignals({}, { appJs: APP_JS_QUOTED_KEYS });
    expect(out.entity_config_keys).toEqual([
      'user',
      'parameter',
      'service',
      'notification/channel',
      'default',
    ]);
    expect(out.entity_config_trusted).toBe(true);
  });

  it('distrusts a literal that spreads an unknown object', async () => {
    const out = await runSignals({ new_entity_rows: [NEW_ENTITY] }, { appJs: APP_JS_BARE_SPREAD });
    expect(out.entity_config_trusted).toBe(false);
    expect(out.degraded_sources.join(' ')).toContain('1 key position(s) unresolved');
    expect(out.data_flags.filter((f) => f.text.includes('entityConfig'))).toEqual([]);
  });

  it('distrusts a key set that lacks the entities the enhancer always configures', async () => {
    const out = await runSignals(
      { new_entity_rows: [NEW_ENTITY] },
      { appJs: 'const entityConfig = { widget: { type: STANDARD } };' },
    );
    expect(out.entity_config_trusted).toBe(false);
    expect(out.degraded_sources.join(' ')).toContain('no "user" key');
    expect(out.degraded_sources.join(' ')).toContain('no "parameter" key');
    expect(out.data_flags.filter((f) => f.text.includes('entityConfig'))).toEqual([]);
  });

  it('degrades when app.js has no entityConfig at all', async () => {
    const out = await runSignals({}, { appJs: 'module.exports = {};' });
    expect(out.entity_config_trusted).toBe(false);
    expect(out.degraded_sources.join(' ')).toContain('entityConfig unavailable');
  });

  it('says so in the excerpt when there is no clients map', async () => {
    const out = await runSignals({}, { appJs: APP_JS_QUOTED_KEYS });
    expect(out.signals_view).toContain('no clients object literal found');
  });
});

describe('audit-entity-check signals — probe verdicts', () => {
  const ALT = 'https://users.nullplatform.io';
  const rowsFor = (entity: string) => [{ ...NEW_ENTITY, entity, sample_entity_id: 'id_1' }];
  /** 404 on the default host, 200 on users.nullplatform.io. */
  const altHostProbe = (url: string) => (url.startsWith(ALT) ? 200 : 404);

  it('accepts an alternate host for an entity the real clients map declares', async () => {
    const out = await runSignals({ new_entity_rows: rowsFor('user') }, { probe: altHostProbe });
    const probe = out.probes.find((p) => p.entity === 'user');
    expect(probe?.verdict).toBe('answers_on_alt_host');
    expect(probe?.alt_host).toBe(ALT);
  });

  it('escalates to wrong_host for an entity absent from the clients map', async () => {
    // The real clients map mentions users.nullplatform.io for ANOTHER entity;
    // that must not excuse this one, which has no entry of its own.
    expect(REAL_APP_JS).toContain('https://users.nullplatform.io');
    const out = await runSignals({ new_entity_rows: rowsFor('widget') }, { probe: altHostProbe });
    expect(out.probes.find((p) => p.entity === 'widget')?.verdict).toBe('wrong_host');
  });

  it('stays on answers_on_alt_host when there is no clients map to check', async () => {
    const out = await runSignals(
      { new_entity_rows: rowsFor('widget') },
      { appJs: APP_JS_QUOTED_KEYS, probe: altHostProbe },
    );
    expect(out.probes.find((p) => p.entity === 'widget')?.verdict).toBe('answers_on_alt_host');
  });

  it('reports a failed request as an unreachable probe, not as a DLQ risk', async () => {
    const out = await runSignals({ new_entity_rows: rowsFor('user') }, { probe: () => 'throw' });
    expect(out.probes.find((p) => p.entity === 'user')?.verdict).toBe('probe_unreachable');
    expect(out.degraded_sources.join(' ')).toContain('no HTTP response');
    expect(out.data_flags).toEqual([]);
  });

  it('still calls a 5xx a DLQ risk', async () => {
    const out = await runSignals({ new_entity_rows: rowsFor('user') }, { probe: () => 503 });
    expect(out.probes.find((p) => p.entity === 'user')?.verdict).toBe('upstream_error_dlq_risk');
    expect(out.data_flags.map((f) => f.entity)).toContain('user');
  });

  it('probes the two-segment entity names the enhancer really configures', async () => {
    const withSlash = ['runtime_configuration/dimension', 'notification/channel'];
    // Both are keys of the real map, so neither may be treated as a bad name.
    expect(REAL_KEYS).toEqual(expect.arrayContaining(withSlash));
    const urls: string[] = [];
    const out = await runSignals(
      {
        new_entity_rows: withSlash.map((entity) => ({
          ...NEW_ENTITY,
          entity,
          sample_entity_id: 'id_1',
        })),
      },
      { urls },
    );
    // The STANDARD one is fetched as GET /runtime_configuration/dimension/<id>,
    // so the slash has to survive the escaping; the SELF_CONTAINED one is not
    // fetched at all. Neither is a bad name.
    const verdictOf = (entity: string) => out.probes.find((p) => p.entity === entity)?.verdict;
    expect(verdictOf('runtime_configuration/dimension')).toBe('ok');
    expect(verdictOf('notification/channel')).toBe('not_fetched_by_design');
    expect(urls).toContain('https://api.nullplatform.io/runtime_configuration/dimension/id_1');
    expect(out.data_flags).toEqual([]);
    expect(out.degraded_sources).toEqual([]);
  });

  it('rejects traversal and malformed names, and escapes what it does probe', async () => {
    const bad = ['user/../admin', 'a/b/c', 'user/', '/user', 'us..er', 'a//b', '-foo', 'a/-b'];
    const urls: string[] = [];
    const out = await runSignals(
      {
        new_entity_rows: [
          ...bad.map((entity) => ({ ...NEW_ENTITY, entity, sample_entity_id: 'x' })),
          { ...NEW_ENTITY, entity: 'parameter', sample_entity_id: 'a:b' },
        ],
      },
      { urls },
    );
    for (const entity of bad) {
      expect(out.probes.find((p) => p.entity === entity)?.verdict).toBe('skipped_unsafe_name');
    }
    expect(urls.some((u) => u.includes('..'))).toBe(false);
    expect(urls.some((u) => u.replace('https://', '').includes('//'))).toBe(false);
    expect(urls.some((u) => u.endsWith('/parameter/a%3Ab'))).toBe(true);
  });

  it('degrades instead of flagging a name the enhancer configures but cannot probe', async () => {
    // Hypothetical three-segment key: legitimate by virtue of being configured,
    // yet outside what the probe can build a URL for.
    const appJs = REAL_APP_JS.replace('"nrn": {', '"a/b/c": {} ,\n        "nrn": {');
    const row = [{ ...NEW_ENTITY, entity: 'a/b/c', sample_entity_id: 'x' }];
    const out = await runSignals({ new_entity_rows: row }, { appJs });
    expect(out.entity_config_trusted).toBe(true);
    expect(out.probes.find((p) => p.entity === 'a/b/c')?.verdict).toBe('skipped_not_probeable');
    expect(out.data_flags).toEqual([]);
    expect(out.degraded_sources.join(' ')).toContain('configured in the enhancer');

    // With the map untrusted the same name is a finding again: the carve-out
    // only applies to names a map we believe actually configures.
    const untrusted = await runSignals({ new_entity_rows: row }, { enhancerJs: null, appJs });
    expect(untrusted.entity_config_trusted).toBe(false);
    expect(untrusted.probes.find((p) => p.entity === 'a/b/c')?.verdict).toBe('skipped_unsafe_name');
    expect(untrusted.data_flags.map((f) => f.entity)).toContain('a/b/c');
  });

  it('probes at most four entities and says how many it left out', async () => {
    const rows = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((entity) => ({
      ...NEW_ENTITY,
      entity,
      sample_entity_id: 'id',
    }));
    const out = await runSignals({ new_entity_rows: rows });
    expect(out.probes).toHaveLength(4);
    expect(out.degraded_sources.join(' ')).toContain('6 suspect entities but only 4 were probed');
    expect(out.signals_view).toContain('probed 4 of 6 suspect entities');
  });
});

describe('audit-entity-check signals — entities the enhancer never fetches', () => {
  /** Entries the real map resolves with selfContainedEnhancer or `ignore: true`. */
  const SELF_CONTAINED = [
    'service',
    'workflow',
    'notification/channel',
    'action_item',
    'login_success',
    'agent',
  ];

  it('does not probe them and does not call their 404 a finding', async () => {
    expect(REAL_KEYS).toEqual(expect.arrayContaining(SELF_CONTAINED));
    const urls: string[] = [];
    const out = await runSignals(
      {
        new_entity_rows: SELF_CONTAINED.map((entity) => ({
          ...NEW_ENTITY,
          entity,
          sample_entity_id: 'id_1',
        })),
      },
      // Every host 404s, which is exactly what a SELF_CONTAINED entity does.
      { probe: () => 404, urls },
    );
    expect(out.probes).toHaveLength(SELF_CONTAINED.length);
    expect(new Set(out.probes.map((p) => p.verdict))).toEqual(new Set(['not_fetched_by_design']));
    expect(out.data_flags).toEqual([]);
    expect(out.degraded_sources).toEqual([]);
    // Not probing them also gives the 30s budget back.
    expect(urls.filter((u) => u.includes('nullplatform.io/') && !u.includes('token'))).toEqual([]);
  });

  it('still probes a STANDARD entity, and its 404 everywhere is a finding', async () => {
    const out = await runSignals(
      { new_entity_rows: [{ ...NEW_ENTITY, entity: 'user', sample_entity_id: 'id_1' }] },
      { probe: () => 404 },
    );
    expect(out.probes.find((p) => p.entity === 'user')?.verdict).toBe('id_or_endpoint_missing');
    expect(out.data_flags.map((f) => f.entity)).toContain('user');
  });

  it('probes everything when the config could not be trusted', async () => {
    // No classification without a trusted map: err towards looking.
    const out = await runSignals(
      { new_entity_rows: [{ ...NEW_ENTITY, entity: 'service', sample_entity_id: 'id_1' }] },
      { enhancerJs: null, probe: () => 404 },
    );
    expect(out.entity_config_trusted).toBe(false);
    expect(out.probes.find((p) => p.entity === 'service')?.verdict).toBe('id_or_endpoint_missing');
  });
});

describe('audit-entity-check signals — anchor decoys', () => {
  const ALT = 'https://users.nullplatform.io';
  const altHostProbe = (url: string) => (url.startsWith(ALT) ? 200 : 404);
  const userRow = [{ ...NEW_ENTITY, entity: 'user', sample_entity_id: 'id_1' }];

  it('ignores a clients map mentioned in a line comment', async () => {
    // `user` HAS a real clients entry; anchoring on the comment would hide it
    // and turn the probe into a wrong_host finding, with the decoy handed to
    // the agent as the excerpt that "confirms" it.
    const appJs = REAL_APP_JS.replace(
      'const entityUtils = new EntityUtils({',
      '// clients: { entity: axiosInstance } — one entry per non-default host\n'
        + 'const entityUtils = new EntityUtils({',
    );
    const out = await runSignals({ new_entity_rows: userRow }, { appJs, probe: altHostProbe });
    expect(out.probes.find((p) => p.entity === 'user')?.verdict).toBe('answers_on_alt_host');
    expect(out.signals_view).toContain('baseURL:"https://users.nullplatform.io"');
    expect(out.signals_view).not.toContain('{ entity: axiosInstance }');
  });

  it('ignores an entityConfig mentioned in a string literal', async () => {
    const appJs = `const msg = "entityConfig: { fake: 1 }";\n${REAL_APP_JS}`;
    const out = await runSignals({}, { appJs });
    expect(out.entity_config_keys).toEqual(REAL_KEYS);
    expect(out.entity_config_trusted).toBe(true);
  });

  it('accepts a quoted property key as the anchor', async () => {
    const appJs = REAL_APP_JS.replace('    entityConfig: {', '    "entityConfig": {').replace(
      '    clients: {',
      "    'clients': {",
    );
    const out = await runSignals({ new_entity_rows: userRow }, { appJs, probe: altHostProbe });
    expect(out.entity_config_keys).toEqual(REAL_KEYS);
    expect(out.entity_config_trusted).toBe(true);
    expect(out.probes.find((p) => p.entity === 'user')?.verdict).toBe('answers_on_alt_host');
  });

  it('is not fooled by a regex literal holding a quote', async () => {
    // A lone quote inside /['"]/ used to open a "string" that ran to the next
    // quote in the file, blanking the anchor along with it.
    const appJs = REAL_APP_JS.replace(
      'const PARAMS_REGEX',
      "const QUOTE_RE = /['\"]/;\nconst PARAMS_REGEX",
    );
    const out = await runSignals({ new_entity_rows: userRow }, { appJs, probe: altHostProbe });
    expect(out.entity_config_keys).toEqual(REAL_KEYS);
    expect(out.entity_config_trusted).toBe(true);
    expect(out.degraded_sources).toEqual([]);
  });

  it('degrades visibly on source it cannot scan at all', async () => {
    // An unterminated block comment swallows the rest of the file. Nothing can
    // be concluded from that, and the item says so instead of guessing.
    const appJs = `/* oops\n${REAL_APP_JS}`;
    const out = await runSignals({ new_entity_rows: [NEW_ENTITY] }, { appJs });
    expect(out.entity_config_trusted).toBe(false);
    expect(out.degraded_sources.join(' ')).toContain('entityConfig unavailable');
    expect(out.data_flags).toEqual([]);
  });

  it('never escalates to wrong_host on a clients map it could not parse', async () => {
    const appJs = REAL_APP_JS.replace(
      /const entityUtils = new EntityUtils\(\{[\s\S]*?\n\}\);/,
      'const entityUtils = new EntityUtils({ clients: { widgets: onlyOne }, tokenGenerator });',
    );
    const out = await runSignals({ new_entity_rows: userRow }, { appJs, probe: altHostProbe });
    expect(out.probes.find((p) => p.entity === 'user')?.verdict).toBe('answers_on_alt_host');
    expect(out.degraded_sources.join(' ')).toContain('clients map not parsed with confidence');
    expect(out.degraded_sources.join(' ')).toContain('no "default" client');
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

  it('tells a failed lake query apart from one that never ran', async () => {
    const failed = await runSignals({
      new_entity_rows: undefined,
      new_entities_error: 'NP_LAKE_5XX: gateway timeout',
    });
    expect(failed.degraded_sources).toContain(
      'lake unavailable (new entities): the query failed — NP_LAKE_5XX: gateway timeout',
    );
    expect(failed.data_flags).toEqual([]);

    const neverRan = await runSignals({ empty_row_rows: undefined });
    expect(neverRan.degraded_sources).toContain(
      'lake unavailable (empty rows): the query did not run',
    );
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

// --------------------------------------------------------------------------
// resolve / resolve_carryover
// --------------------------------------------------------------------------

const RESOLVE_CODE = stepCode('resolve');
const CARRYOVER_CODE = stepCode('resolve_carryover');

const CALLBACK = 'https://approval-api.test/approval/9001/checklist/items/audit_entity_check';

interface Patched {
  status: string;
  message: string;
  details: {
    markdown: string;
    check_id: string;
    findings: unknown[];
    entities: Array<{ entity: string }>;
    analyzed_sha: string;
    scope: string;
    carried_from?: string;
  };
}

interface ResolveCapture {
  patched?: Patched;
  logs: string[];
}

/** Captures the PATCH body and every log line the step posts. */
function resolveFetch(capture: ResolveCapture, patchStatus = 200): FakeFetch {
  return async (url, init) => {
    const method = String((init ?? {}).method ?? 'GET');
    const body = JSON.parse(String((init ?? {}).body ?? '{}'));
    if (method === 'POST' && url.endsWith('/log')) {
      capture.logs.push(String(body.message));
      return res(200, {});
    }
    if (method === 'PATCH') {
      capture.patched = body as Patched;
      return res(patchStatus, patchStatus === 200 ? {} : 'callback token expired');
    }
    return res(404, {});
  };
}

const RESOLVE_ITEM = {
  callbackUrl: CALLBACK,
  callbackToken: 'tok',
  check_id: 'audit_entity_check',
  item_id: 'audit_entity_check',
  verdict: {
    status: 'failed',
    summary: 'One route emits an entity the enhancer cannot fetch.',
    findings: [
      {
        area: 'missing_grant',
        entity: 'runbook',
        file: 'src/routes/runbook.ts',
        issue: 'GET /runbook/<id> answers 403 to the enhancer',
        fix: 'Grant the enhancer service account read access to runbook',
      },
    ],
    resolved_findings: [{ entity: 'widget', issue: 'was unaudited', resolution: 'audit added' }],
    entities: [{ entity: 'runbook', source: 'POST /runbook', verdict: 'misconfigured' }],
    fix_instructions_md: 'Add the grant.',
  },
  repo: 'nullplatform/some-api',
  scope: 'diff',
  analyzed_sha: SHA_CURRENT,
  changed_count: 3,
  data_flags: [{ entity: 'runbook', text: 'runbook has 40% empty rows in the lake' }],
  degraded_sources: ['lake unavailable (empty rows): the query failed — NP_LAKE_5XX'],
};

describe('audit-entity-check resolve', () => {
  it('resolves the item with the verdict, both signal channels and the checkpoint stamp', async () => {
    const capture: ResolveCapture = { logs: [] };
    await runStepCode(RESOLVE_CODE, RESOLVE_ITEM, resolveFetch(capture));

    expect(capture.patched?.status).toBe('failed');
    expect(capture.patched?.message).toContain('1 issue(s)');
    // The stamp the next run reads as its checkpoint.
    expect(capture.patched?.details.check_id).toBe('audit_entity_check');
    expect(capture.patched?.details.analyzed_sha).toBe(SHA_CURRENT);
    expect(capture.patched?.details.scope).toBe('diff');
    expect(capture.patched?.details.findings).toHaveLength(1);
    // details.entities feeds the next run's own-entity filter.
    expect(capture.patched?.details.entities).toEqual([
      { entity: 'runbook', source: 'POST /runbook', verdict: 'misconfigured' },
    ]);

    const markdown = capture.patched?.details.markdown ?? '';
    expect(markdown).toContain('runbook has 40% empty rows in the lake');
    expect(markdown).toContain('Fuentes degradadas');
    expect(markdown).toContain('NP_LAKE_5XX');
    expect(markdown).toContain('#### How to fix');
    // A degraded source is logged as a warning, never as a finding.
    expect(capture.logs.some((l) => l.startsWith('Degraded signal source:'))).toBe(true);
    expect(capture.logs.some((l) => l.includes('[missing_grant]'))).toBe(true);
    expect(capture.logs.some((l) => l.startsWith('Resolved: widget'))).toBe(true);
  });

  it('treats a not_applicable verdict as passed', async () => {
    const capture: ResolveCapture = { logs: [] };
    await runStepCode(
      RESOLVE_CODE,
      { ...RESOLVE_ITEM, verdict: { status: 'not_applicable', summary: 'no HTTP writes' } },
      resolveFetch(capture),
    );
    expect(capture.patched?.status).toBe('passed');
    expect(capture.patched?.message).toContain('N/A');
    expect(capture.patched?.details.markdown).toContain('N/A');
  });

  it('fails loudly when the callback PATCH is rejected', async () => {
    const capture: ResolveCapture = { logs: [] };
    await expect(
      runStepCode(RESOLVE_CODE, RESOLVE_ITEM, resolveFetch(capture, 401)),
    ).rejects.toThrow(/resolve audit_entity_check -> 401/);
  });
});

describe('audit-entity-check resolve_carryover', () => {
  const CARRYOVER_ITEM = {
    callbackUrl: CALLBACK,
    callbackToken: 'tok',
    check_id: 'audit_entity_check',
    item_id: 'audit_entity_check',
    repo: 'nullplatform/some-api',
    analyzed_sha: SHA_CURRENT,
    changed_count: 2,
    prev: {
      approval_id: 8000,
      sha: SHA_PREV,
      status: 'passed',
      findings: [{ entity: 'runbook', issue: 'x' }],
      entities: [{ entity: 'runbook', verdict: 'ok' }],
      markdown: '### Audit coverage — PASSED',
    },
    degraded_sources: ['probe: entity "runbook" got no HTTP response (sandbox egress or network)'],
  };

  it('re-applies the previous verdict and carries the checkpoint forward', async () => {
    const capture: ResolveCapture = { logs: [] };
    await runStepCode(CARRYOVER_CODE, CARRYOVER_ITEM, resolveFetch(capture));

    expect(capture.patched?.status).toBe('passed');
    expect(capture.patched?.details.scope).toBe('carry_over');
    expect(capture.patched?.details.carried_from).toBe(SHA_PREV);
    expect(capture.patched?.details.analyzed_sha).toBe(SHA_CURRENT);
    // Findings and entities survive a chain of carry-overs, so the own-entity
    // filter keeps working without a fresh analysis.
    expect(capture.patched?.details.findings).toHaveLength(1);
    expect(capture.patched?.details.entities).toEqual([{ entity: 'runbook', verdict: 'ok' }]);
    const markdown = capture.patched?.details.markdown ?? '';
    expect(markdown).toContain('(carry-over)');
    expect(markdown).toContain('Fuentes degradadas');
    expect(markdown).toContain('### Audit coverage — PASSED');
  });

  it('keeps a failed verdict failed', async () => {
    const capture: ResolveCapture = { logs: [] };
    await runStepCode(
      CARRYOVER_CODE,
      { ...CARRYOVER_ITEM, prev: { ...CARRYOVER_ITEM.prev, status: 'failed' } },
      resolveFetch(capture),
    );
    expect(capture.patched?.status).toBe('failed');
    expect(capture.patched?.details.markdown).toContain('FAILED (carry-over)');
  });

  it('resolves the item even if the previous stamp is incomplete', async () => {
    const capture: ResolveCapture = { logs: [] };
    await runStepCode(CARRYOVER_CODE, { ...CARRYOVER_ITEM, prev: {} }, resolveFetch(capture));
    expect(capture.patched?.status).toBe('passed');
    expect(capture.patched?.details.markdown).toContain('(sin detalle previo)');
  });

  it('fails loudly when the callback PATCH is rejected', async () => {
    const capture: ResolveCapture = { logs: [] };
    await expect(
      runStepCode(CARRYOVER_CODE, CARRYOVER_ITEM, resolveFetch(capture, 500)),
    ).rejects.toThrow(/carry-over resolve audit_entity_check -> 500/);
  });
});
