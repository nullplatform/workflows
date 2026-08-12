/**
 * @file Unit tests for the deterministic JavaScript of `audit-entity-check`.
 *
 * The E2E suite stubs `code-exec` by step id, so the bodies of `enhancer_config`,
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
 *  - the per-entity mode classification (STANDARD / SELF_CONTAINED / NRN /
 *    IGNORED), which is what tells the agent whether a write has to echo the
 *    entity back,
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
  steps: Array<{ id: string; config?: { code?: string; systemPrompt?: string } }>;
}

function workflow(): WorkflowDoc {
  return parse(readFileSync(WF_PATH, 'utf8')) as WorkflowDoc;
}

function stepCode(stepId: string): string {
  const code = workflow().steps.find((s) => s.id === stepId)?.config?.code;
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
// enhancer_config
// --------------------------------------------------------------------------

const CONFIG_CODE = stepCode('enhancer_config');

type EntityMode = 'standard' | 'self_contained' | 'nrn' | 'ignored';

interface ConfigOutput {
  unverified: string[];
  entity_config_keys: string[];
  entity_config_trusted: boolean;
  entity_modes: Record<string, EntityMode>;
  self_contained_entities: string[];
  clients_keys: string[] | null;
  has_default_config: boolean;
  config_fingerprint: string;
  config_view: string;
}

interface ConfigFetchOptions {
  /** Served for `audit-ennhancer/app.js`; defaults to the real file. */
  appJs?: string;
  /** Served for `audit-ennhancer/audit_enhancer.js`; null answers 404. */
  enhancerJs?: string | null;
  urls?: string[];
}

function configFetch(opts: ConfigFetchOptions): FakeFetch {
  return async (url) => {
    opts.urls?.push(url);
    if (url.endsWith('/audit_enhancer.js')) {
      const body = opts.enhancerJs === undefined ? REAL_ENHANCER_JS : opts.enhancerJs;
      return body === null ? res(404, 'Not Found') : res(200, body);
    }
    return res(200, opts.appJs ?? REAL_APP_JS);
  };
}

const runConfig = (
  item: Record<string, unknown> = {},
  opts: ConfigFetchOptions = {},
): Promise<ConfigOutput> =>
  runStepCode<ConfigOutput>(
    CONFIG_CODE,
    {
      github_token: 'gh_token',
      enhancer_repo: 'nullplatform/data-audit-stream-enhancer',
      ...item,
    },
    configFetch(opts),
  );

/** Declaration form, section comments between entries. */
const APP_JS_SECTION_COMMENTS = `
const clients = {
  default: apiClient,
  user: usersClient,
  parameter: paramsClient,
};

const entityConfig = {
  // STANDARD: enriched via GET
  user: { entityType: ENTITY_TYPE.STANDARD },
  parameter: { entityType: ENTITY_TYPE.STANDARD },
  // SELF_CONTAINED: enriched from the body
  service: { entityClient: selfContainedEnhancer },
  nrn: { entityType: ENTITY_TYPE.NRN },
  default: { entityType: ENTITY_TYPE.STANDARD },
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
  "user": { entityType: ENTITY_TYPE.STANDARD },
  'parameter': { entityType: ENTITY_TYPE.STANDARD },
  /* } */
  service: { entityClient: selfContainedEnhancer, path: "/service/{id}" },
  "notification/channel": { entityClient: selfContainedEnhancer },
  default: { entityType: ENTITY_TYPE.STANDARD },
};
`;

/** A spread of an unknown object: the key list cannot be complete. */
const APP_JS_BARE_SPREAD = `
const entityConfig = {
  user: { entityType: ENTITY_TYPE.STANDARD },
  parameter: { entityType: ENTITY_TYPE.STANDARD },
  ...legacyEntityConfig,
  default: { entityType: ENTITY_TYPE.STANDARD },
};
`;

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

/** Entries of the real map that state STANDARD (the enhancer fetches them). */
const REAL_STANDARD = [
  'user',
  'parameter',
  'runtime_configuration',
  'action_item_category',
  'default',
];

/** Entries that delegate to a variable, so their mode is not readable here. */
const REAL_UNKNOWN = ['runtime_configuration/dimension', 'dimension'];

describe('audit-entity-check enhancer_config — extraction (real enhancer)', () => {
  it('reads both maps out of the real app.js, resolving computed keys and spreads', async () => {
    const urls: string[] = [];
    const out = await runConfig({}, { urls });
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
    expect(out.unverified).toEqual([]);
  });

  it('reads the clients map and publishes it for the cross-check', async () => {
    const out = await runConfig();
    expect(out.clients_keys).toContain('default');
    expect(out.clients_keys).toContain('entity_hook');
    expect(out.clients_keys).toHaveLength(13);
    expect(out.config_view).toContain('--- clients ---');
    expect(out.config_view).toContain('entity_hook');
  });

  it('reports that an unlisted entity falls back to the default STANDARD path', async () => {
    const out = await runConfig();
    expect(out.has_default_config).toBe(true);
    expect(out.config_view).toContain('The map has a `default` entry');
  });

  it('distrusts the key set when the ENTITIES map cannot be read', async () => {
    const out = await runConfig({}, { enhancerJs: null });
    expect(out.entity_config_trusted).toBe(false);
    expect(out.unverified.join(' ')).toContain('key position(s) unresolved');
    // An incomplete key set is not classified at all, and the view says so.
    expect(out.entity_modes).toEqual({});
    expect(out.config_view).toContain('not classified');
  });
});

describe('audit-entity-check enhancer_config — extraction (other shapes)', () => {
  it('keeps the real keys when section comments sit between entries', async () => {
    const out = await runConfig({}, { appJs: APP_JS_SECTION_COMMENTS });
    expect(out.entity_config_keys).toEqual(['user', 'parameter', 'service', 'nrn', 'default']);
    expect(out.entity_config_trusted).toBe(true);
  });

  it('anchors on the declaration, not on an earlier read of the name', async () => {
    const out = await runConfig({}, { appJs: APP_JS_READ_BEFORE_DECL });
    expect(out.entity_config_keys).toEqual(['user', 'parameter', 'service', 'nrn', 'default']);
    expect(out.entity_config_trusted).toBe(true);
  });

  it('reads quoted keys and ignores braces inside comments and strings', async () => {
    const out = await runConfig({}, { appJs: APP_JS_QUOTED_KEYS });
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
    const out = await runConfig({}, { appJs: APP_JS_BARE_SPREAD });
    expect(out.entity_config_trusted).toBe(false);
    expect(out.unverified.join(' ')).toContain('1 key position(s) unresolved');
    expect(out.entity_modes).toEqual({});
  });

  it('distrusts a key set that lacks the entities the enhancer always configures', async () => {
    const out = await runConfig(
      {},
      { appJs: 'const entityConfig = { widget: { entityType: ENTITY_TYPE.STANDARD } };' },
    );
    expect(out.entity_config_trusted).toBe(false);
    expect(out.unverified.join(' ')).toContain('no "user" key');
    expect(out.unverified.join(' ')).toContain('no "parameter" key');
  });

  it('degrades when app.js has no entityConfig at all', async () => {
    const out = await runConfig({}, { appJs: 'module.exports = {};' });
    expect(out.entity_config_trusted).toBe(false);
    expect(out.unverified.join(' ')).toContain('entityConfig unavailable');
  });

  it('says so in the view when there is no clients map', async () => {
    const out = await runConfig({}, { appJs: APP_JS_QUOTED_KEYS });
    expect(out.clients_keys).toBeNull();
    expect(out.unverified.join(' ')).toContain('no clients object literal found');
    expect(out.config_view).toContain('no clients object literal found');
  });
});

describe('audit-entity-check enhancer_config — per-entity mode', () => {
  it('classifies the whole real map the way the enhancer dispatches it', async () => {
    const out = await runConfig();
    const byMode = (mode: EntityMode) =>
      Object.keys(out.entity_modes).filter((k) => out.entity_modes[k] === mode);
    // Only STANDARD makes the enhancer fetch the entity; getEntityData in its
    // entity_enhancer.js dispatches on ENTITY_TYPE.
    expect(byMode('standard')).toEqual(REAL_STANDARD);
    expect(byMode('nrn')).toEqual(['nrn']);
    expect(byMode('ignored')).toEqual(['agent']);
    // `dimension` and its twin point at a `dimensionConfig` variable, so the
    // entry itself says nothing: unknown, never assumed.
    expect(byMode('unknown')).toEqual(REAL_UNKNOWN);
    const named = [...REAL_STANDARD, ...REAL_UNKNOWN, 'nrn', 'agent'];
    expect(new Set(byMode('self_contained'))).toEqual(
      new Set(REAL_KEYS.filter((k) => !named.includes(k))),
    );
    // The list the agent needs for the echo check.
    expect(out.self_contained_entities).toEqual(byMode('self_contained'));
    expect(out.self_contained_entities).toContain('service');
    expect(out.self_contained_entities).toContain('notification/channel');
  });

  it('spells the modes out for the agent, naming what each one demands', async () => {
    const out = await runConfig();
    expect(out.config_view).toContain('STANDARD (the enhancer fetches the entity)');
    expect(out.config_view).toContain('SELF_CONTAINED (no fetch — the WRITE must carry the entity)');
    expect(out.config_view).toContain('NRN (only the nrn is resolved)');
    expect(out.config_view).toContain('IGNORED (opted out of enrichment)');
    expect(out.config_view).toContain('UNKNOWN (the entry delegates elsewhere — judge both sides)');
  });

  it('classifies the synthetic shapes too', async () => {
    const out = await runConfig({}, { appJs: APP_JS_SECTION_COMMENTS });
    expect(out.entity_modes).toEqual({
      user: 'standard',
      parameter: 'standard',
      service: 'self_contained',
      nrn: 'nrn',
      default: 'standard',
    });
  });

  it('does not read an `ignore: true` nested inside the entry as opting out', async () => {
    // The real map only ever opts out with a whole `{ ignore: true }` entry; the
    // same words inside a `fields[]` element mean something else.
    const appJs = REAL_APP_JS.replace(
      '                fields:[',
      '                fields:[\n                    {name:"x", ignore: true},',
    );
    const out = await runConfig({}, { appJs });
    expect(out.entity_modes['user']).toBe('standard');
    expect(out.entity_modes['agent']).toBe('ignored');
  });

  it('keeps a STANDARD entity standard when its entry merely talks about the others', async () => {
    // Classification reads the entry's code, not its prose: a comment that
    // mentions the mechanism must not mislabel a fetched entity, because that
    // hides real misconfiguration instead of inventing one.
    const trolls = [
      '// not self-contained: this one IS fetched',
      '// unlike the self_contained ones above',
      '// see selfContainedEnhancer for the other case',
      '// entityType: ENTITY_TYPE.NRN is handled elsewhere',
    ];
    for (const troll of trolls) {
      const appJs = REAL_APP_JS.replace(
        '        [ENTITIES.USER] : {\n',
        `        [ENTITIES.USER] : {\n            ${troll}\n`,
      );
      const out = await runConfig({}, { appJs });
      expect(out.entity_modes['user'], troll).toBe('standard');
    }
  });
});

describe('audit-entity-check enhancer_config — anchor decoys', () => {
  it('ignores a clients map mentioned in a line comment', async () => {
    // Anchoring on the comment would publish a bogus key list and hand the
    // decoy to the agent as the excerpt it is told to conclude from.
    const appJs = REAL_APP_JS.replace(
      'const entityUtils = new EntityUtils({',
      '// clients: { entity: axiosInstance } — one entry per non-default host\n'
        + 'const entityUtils = new EntityUtils({',
    );
    const out = await runConfig({}, { appJs });
    expect(out.clients_keys).toHaveLength(13);
    expect(out.config_view).toContain('baseURL:"https://users.nullplatform.io"');
    expect(out.config_view).not.toContain('{ entity: axiosInstance }');
  });

  it('ignores an entityConfig mentioned in a string literal', async () => {
    const appJs = `const msg = "entityConfig: { fake: 1 }";\n${REAL_APP_JS}`;
    const out = await runConfig({}, { appJs });
    expect(out.entity_config_keys).toEqual(REAL_KEYS);
    expect(out.entity_config_trusted).toBe(true);
  });

  it('accepts a quoted property key as the anchor', async () => {
    const appJs = REAL_APP_JS.replace('    entityConfig: {', '    "entityConfig": {').replace(
      '    clients: {',
      "    'clients': {",
    );
    const out = await runConfig({}, { appJs });
    expect(out.entity_config_keys).toEqual(REAL_KEYS);
    expect(out.entity_config_trusted).toBe(true);
    expect(out.clients_keys).toHaveLength(13);
  });

  it('is not fooled by a regex literal holding a quote', async () => {
    // A lone quote inside /['"]/ used to open a "string" that ran to the next
    // quote in the file, blanking the anchor along with it.
    const appJs = REAL_APP_JS.replace(
      'const PARAMS_REGEX',
      "const QUOTE_RE = /['\"]/;\nconst PARAMS_REGEX",
    );
    const out = await runConfig({}, { appJs });
    expect(out.entity_config_keys).toEqual(REAL_KEYS);
    expect(out.entity_config_trusted).toBe(true);
    expect(out.unverified).toEqual([]);
  });

  it('degrades visibly on source it cannot scan at all', async () => {
    // An unterminated block comment swallows the rest of the file. Nothing can
    // be concluded from that, and the item says so instead of guessing.
    const appJs = `/* oops\n${REAL_APP_JS}`;
    const out = await runConfig({}, { appJs });
    expect(out.entity_config_trusted).toBe(false);
    expect(out.unverified.join(' ')).toContain('entityConfig unavailable');
  });

  it('publishes no clients key list it cannot trust', async () => {
    const appJs = REAL_APP_JS.replace(
      /const entityUtils = new EntityUtils\(\{[\s\S]*?\n\}\);/,
      'const entityUtils = new EntityUtils({ clients: { widgets: onlyOne }, tokenGenerator });',
    );
    const out = await runConfig({}, { appJs });
    expect(out.clients_keys).toBeNull();
    expect(out.unverified.join(' ')).toContain('clients map not parsed with confidence');
    expect(out.unverified.join(' ')).toContain('no "default" client');
  });
});

describe('audit-entity-check enhancer_config — sources it could not read', () => {
  it('reports a missing config entry instead of calling out with "undefined"', async () => {
    const urls: string[] = [];
    const out = await runConfig({ github_token: undefined }, { urls });
    expect(out.unverified).toContain(
      'config entry GITHUB_TOKEN missing — enhancer entityConfig not read',
    );
    expect(urls).toEqual([]);
    expect(out.entity_config_trusted).toBe(false);
  });
});

describe('audit-entity-check enhancer_config — configuration fingerprint', () => {
  it('is stable for the same configuration', async () => {
    const a = await runConfig();
    const b = await runConfig();
    expect(a.config_fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(b.config_fingerprint).toBe(a.config_fingerprint);
  });

  it('moves when an entity changes how it will be enriched', async () => {
    const base = await runConfig();
    // `service` leaves the selfContained(…) spread for a STANDARD entry.
    const appJs = REAL_APP_JS.replace(
      '        ...selfContained(\n            ENTITIES.SERVICE,',
      '        [ENTITIES.SERVICE]: { entityClient: new EntityEnhancer({ entityUtils,'
        + ' entityType: ENTITY_TYPE.STANDARD, cache }) },\n        ...selfContained(',
    );
    const changed = await runConfig({}, { appJs });
    expect(base.entity_modes['service']).toBe('self_contained');
    expect(changed.entity_modes['service']).toBe('standard');
    expect(changed.config_fingerprint).not.toBe(base.config_fingerprint);
  });

  it('moves when an entry or a client is added', async () => {
    const base = await runConfig();
    const withEntity = await runConfig(
      {},
      {
        appJs: REAL_APP_JS.replace(
          '        "default": {',
          '        "runbook": { entityClient: selfContainedEnhancer },\n        "default": {',
        ),
      },
    );
    expect(withEntity.config_fingerprint).not.toBe(base.config_fingerprint);

    const withClient = await runConfig(
      {},
      {
        appJs: REAL_APP_JS.replace(
          '        approval: approvalsApiClient,',
          '        approval: approvalsApiClient,\n        runbook: approvalsApiClient,',
        ),
      },
    );
    expect(withClient.config_fingerprint).not.toBe(base.config_fingerprint);
  });

  it('does not move for a comment-only edit', async () => {
    const base = await runConfig();
    const appJs = REAL_APP_JS.replace(
      'const auditEnhancer = new AuditEnhancer({',
      '// a comment nobody should have to re-analyse for\nconst auditEnhancer = new AuditEnhancer({',
    );
    const cosmetic = await runConfig({}, { appJs });
    expect(cosmetic.config_fingerprint).toBe(base.config_fingerprint);
  });

  it('emits none when the configuration could not be trusted', async () => {
    // A fingerprint of a doubtful parse would flap and force analysis forever.
    const out = await runConfig({}, { enhancerJs: null });
    expect(out.entity_config_trusted).toBe(false);
    expect(out.config_fingerprint).toBe('');
  });
});

// --------------------------------------------------------------------------
// audit_agent prompt
// --------------------------------------------------------------------------

describe('audit-entity-check audit_agent', () => {
  /** The prompt is hard-wrapped, so phrases are matched on one flat line. */
  const systemPrompt = () => {
    const prompt = workflow().steps.find((s) => s.id === 'audit_agent')?.config?.systemPrompt;
    if (typeof prompt !== 'string') throw new Error('audit_agent has no systemPrompt');
    return prompt.replace(/\s+/g, ' ');
  };

  it('asks for the self-contained echo check by name', () => {
    const prompt = systemPrompt();
    expect(prompt).toContain('the write route must echo the entity in its response body');
    expect(prompt).toContain('VERIFY THIS IN THE CODE for every SELF_CONTAINED entity');
    expect(prompt).toContain('entity_snapshot');
    expect(prompt).toContain('self_contained_no_echo');
  });

  it('tells the agent the grant side is not verifiable before the deploy', () => {
    const prompt = systemPrompt();
    expect(prompt).toContain('NOT decidable before the deploy');
    expect(prompt).toContain('are not verifiable before the deploy');
    expect(prompt).toContain('must not turn the item red');
    expect(prompt).toContain('This is a PREVENTIVE, STATIC review');
  });

  it('no longer describes a live probe or lake rows as evidence', () => {
    const prompt = systemPrompt();
    expect(prompt).not.toContain('probe table');
    expect(prompt).not.toContain('answers_on_alt_host');
    expect(prompt).not.toContain('data flags');
    // The enhancer's own tolerated-4xx config is not this application's to fix,
    // and the finding area it used to map to no longer exists.
    expect(prompt).not.toContain('ignoreStatusCodes');
    expect(prompt).toContain("Nothing about the ENHANCER's own configuration is a finding");
  });

  it('sends an unclassifiable entry to both checks instead of assuming a mode', () => {
    const prompt = systemPrompt();
    expect(prompt).toContain('UNKNOWN: the entry does not state its mode');
    expect(prompt).toContain('Do the work of both branches for these');
  });

  it('only allows finding areas a static reading can establish', () => {
    const areas = String(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (workflow().steps.find((s) => s.id === 'audit_agent') as any).config.outputSchema.properties
        .findings.items.properties.area.enum,
    );
    expect(areas).toContain('self_contained_no_echo');
    for (const gone of ['missing_grant', 'wrong_host', 'dlq_risk', 'degraded_entity']) {
      expect(areas).not.toContain(gone);
    }
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
  prev: {
    approval_id?: number;
    status: string;
    sha: string;
    config_fingerprint?: string;
    entities?: Array<{ entity: string }>;
  } | null;
}

/** One row of `GET /approval?nrn=…`, with the verdict stamped on its item. */
interface PriorApproval {
  id: number;
  created_at: string;
  sha?: string;
  /** Omit to model a verdict stamped before fingerprints existed. */
  fingerprint?: string;
  status?: string;
}

interface GatherFetchOptions {
  itemId?: string;
  prevStatus?: string;
  prevSha?: string;
  prevFingerprint?: string;
  /** Several prior approvals, in the order the API returns them. */
  priorApprovals?: PriorApproval[];
  prevEntities?: Array<{ entity: string }>;
  changedFiles?: string[];
  /** Omit to have the prior approval list come back empty (no checkpoint). */
  withCheckpoint?: boolean;
}

function gatherFetch(opts: GatherFetchOptions): FakeFetch {
  const itemId = opts.itemId ?? 'audit_entity_check';
  // Unless a case says otherwise, the checkpoint was taken against the same
  // enhancer configuration this run reads.
  if (opts.prevFingerprint === undefined && !('prevFingerprint' in opts)) {
    opts.prevFingerprint = 'aaaaaaaa';
  }
  const priors: PriorApproval[] = opts.priorApprovals ?? [
    {
      id: 8000,
      created_at: '2026-08-01T00:00:00.000Z',
      sha: opts.prevSha ?? SHA_PREV,
      fingerprint: opts.prevFingerprint,
      status: opts.prevStatus ?? 'passed',
    },
  ];
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
        results:
          opts.withCheckpoint === false
            ? []
            : priors.map((a) => ({ id: a.id, mode: 'checklist', created_at: a.created_at })),
      });
    }
    const checklist = /\/approval\/(\d+)\/checklist/.exec(url);
    if (checklist) {
      const approval = priors.find((a) => String(a.id) === checklist[1]);
      if (!approval) return res(404, {});
      return res(200, {
        items: [
          {
            id: itemId,
            status: approval.status ?? 'passed',
            details: {
              analyzed_sha: approval.sha ?? SHA_PREV,
              findings: [],
              entities: opts.prevEntities ?? [],
              ...(approval.fingerprint === undefined
                ? {}
                : { config_fingerprint: approval.fingerprint }),
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
  config_fingerprint: 'aaaaaaaa',
  np_api_key: 'np_key',
  github_token: 'gh_token',
};

const runGather = (
  item: Record<string, unknown> = {},
  opts: GatherFetchOptions = {},
): Promise<GatherOutput> =>
  runStepCode<GatherOutput>(GATHER_CODE, { ...GATHER_ITEM, ...item }, gatherFetch(opts));

describe('audit-entity-check gather — carry-over decision', () => {
  it('carries over when the sha is unchanged', async () => {
    const out = await runGather({}, { prevSha: SHA_CURRENT });
    expect(out.mode).toBe('carry_over');
    expect(out.prev?.status).toBe('passed');
  });

  it('decides on the diff alone — the check is static', async () => {
    // Nothing outside the repository can change the verdict between two deploys
    // of the same commit, so no external signal is consulted here.
    expect(GATHER_CODE).not.toContain('data_flags');
    const out = await runGather(
      { data_flags: [{ entity: 'anything', text: 'ignored input' }] },
      { prevSha: SHA_CURRENT },
    );
    expect(out.mode).toBe('carry_over');
  });

  it('takes the most recent stamped verdict, not the first row the API returns', async () => {
    // `GET /approval` answers ASCENDING by created_at, so iterating the results
    // as they arrive picked the OLDEST verdict: one stamped before fingerprints
    // existed. Its empty fingerprint then read as "the configuration changed"
    // and a run with nothing to re-analyse was analysed anyway. Ids are not
    // monotonic with time here either — the older approval has the higher id —
    // so the order has to come from created_at.
    const out = await runGather(
      { config_fingerprint: 'ed4c03e4' },
      {
        priorApprovals: [
          {
            id: 1269727654,
            created_at: '2026-08-05T12:00:00.000Z',
            sha: SHA_PREV,
            fingerprint: undefined,
            status: 'passed',
          },
          {
            id: 1044939642,
            created_at: '2026-08-12T12:00:00.000Z',
            sha: SHA_CURRENT,
            fingerprint: 'ed4c03e4',
            status: 'passed',
          },
        ],
      },
    );
    expect(out.prev?.approval_id).toBe(1044939642);
    expect(out.prev?.sha).toBe(SHA_CURRENT);
    expect(out.prev?.config_fingerprint).toBe('ed4c03e4');
    // Same commit, same configuration: there is nothing to analyse.
    expect(out.mode).toBe('carry_over');
  });

  it('re-analyses when the enhancer configuration changed, with no code change at all', async () => {
    // The verdict depends on the enhancer's map too, so a checkpoint taken
    // against a different configuration cannot be reused.
    const out = await runGather(
      { config_fingerprint: 'ffffffff' },
      { prevSha: SHA_CURRENT, prevFingerprint: 'aaaaaaaa' },
    );
    expect(out.mode).toBe('analyze');
    expect(out.scope).toBe('diff');
  });

  it('carries over when the configuration fingerprint matches', async () => {
    const out = await runGather(
      { config_fingerprint: 'aaaaaaaa' },
      { prevSha: SHA_CURRENT, prevFingerprint: 'aaaaaaaa' },
    );
    expect(out.mode).toBe('carry_over');
  });

  it('re-analyses once against a checkpoint stamped before fingerprints existed', async () => {
    const out = await runGather(
      { config_fingerprint: 'aaaaaaaa' },
      { prevSha: SHA_CURRENT, prevFingerprint: undefined },
    );
    expect(out.mode).toBe('analyze');
  });

  it('does not force analysis when this run could not fingerprint the configuration', async () => {
    // Nothing to compare against is not evidence of a change.
    const out = await runGather(
      { config_fingerprint: '' },
      { prevSha: SHA_CURRENT, prevFingerprint: 'aaaaaaaa' },
    );
    expect(out.mode).toBe('carry_over');
  });

  it('re-analyses on an irrelevant diff when the configuration also moved', async () => {
    const out = await runGather(
      { config_fingerprint: 'ffffffff' },
      { changedFiles: ['README.md'], prevFingerprint: 'aaaaaaaa' },
    );
    expect(out.mode).toBe('analyze');
    expect(out.scope).toBe('diff');
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
    config_fingerprint?: string;
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
    summary: 'A write route emits a self-contained entity without echoing it.',
    findings: [
      {
        area: 'self_contained_no_echo',
        entity: 'runbook',
        file: 'src/routes/runbook.ts',
        issue: 'POST /runbook answers 204, so the enhancer has nothing to enrich from',
        fix: 'Return the created runbook in the response body',
      },
    ],
    resolved_findings: [{ entity: 'widget', issue: 'was unaudited', resolution: 'audit added' }],
    entities: [
      { entity: 'runbook', source: 'POST /runbook', verdict: 'misconfigured' },
      { entity: 'widget', source: 'POST /widget', verdict: 'unverified' },
    ],
    fix_instructions_md: 'Return the entity.',
  },
  repo: 'nullplatform/some-api',
  scope: 'diff',
  analyzed_sha: SHA_CURRENT,
  changed_count: 3,
  unverified: ['enhancer clients map not parsed with confidence (no "default" client)'],
  config_fingerprint: 'aaaaaaaa',
};

describe('audit-entity-check resolve', () => {
  it('resolves the item with the verdict and the checkpoint stamp', async () => {
    const capture: ResolveCapture = { logs: [] };
    await runStepCode(RESOLVE_CODE, RESOLVE_ITEM, resolveFetch(capture));

    expect(capture.patched?.status).toBe('failed');
    expect(capture.patched?.message).toContain('1 issue(s)');
    // The stamp the next run reads as its checkpoint.
    expect(capture.patched?.details.check_id).toBe('audit_entity_check');
    expect(capture.patched?.details.analyzed_sha).toBe(SHA_CURRENT);
    expect(capture.patched?.details.scope).toBe('diff');
    // Stamped next to the sha: the pair of inputs the next run compares.
    expect(capture.patched?.details.config_fingerprint).toBe('aaaaaaaa');
    expect(capture.patched?.details.findings).toHaveLength(1);
    expect(capture.patched?.details.entities).toHaveLength(2);

    const markdown = capture.patched?.details.markdown ?? '';
    expect(markdown).toContain('self_contained_no_echo');
    expect(markdown).toContain('#### How to fix');
    expect(capture.logs.some((l) => l.includes('[self_contained_no_echo]'))).toBe(true);
    expect(capture.logs.some((l) => l.startsWith('Resolved: widget'))).toBe(true);
  });

  it('always says what a pre-deploy check could not settle', async () => {
    const capture: ResolveCapture = { logs: [] };
    await runStepCode(RESOLVE_CODE, RESOLVE_ITEM, resolveFetch(capture));
    const markdown = capture.patched?.details.markdown ?? '';
    expect(markdown).toContain('**Sin verificar**');
    expect(markdown).toContain('los monitores del pipeline');
    // A source that could not be read is listed there, and logged as a warning
    // rather than as a finding.
    expect(markdown).toContain('clients map not parsed with confidence');
    expect(capture.logs.some((l) => l.startsWith('Could not be read:'))).toBe(true);

    // With every source readable the caveat about the grant is still there.
    const clean: ResolveCapture = { logs: [] };
    await runStepCode(RESOLVE_CODE, { ...RESOLVE_ITEM, unverified: [] }, resolveFetch(clean));
    expect(clean.patched?.details.markdown).toContain('**Sin verificar**');
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
      config_fingerprint: 'aaaaaaaa',
      markdown: '### Audit coverage — PASSED',
    },
    unverified: ['config entry GITHUB_TOKEN missing — enhancer entityConfig not read'],
    config_fingerprint: 'bbbbbbbb',
  };

  it('re-applies the previous verdict and carries the checkpoint forward', async () => {
    const capture: ResolveCapture = { logs: [] };
    await runStepCode(CARRYOVER_CODE, CARRYOVER_ITEM, resolveFetch(capture));

    expect(capture.patched?.status).toBe('passed');
    expect(capture.patched?.details.scope).toBe('carry_over');
    expect(capture.patched?.details.carried_from).toBe(SHA_PREV);
    expect(capture.patched?.details.analyzed_sha).toBe(SHA_CURRENT);
    // Findings and entities survive a chain of carry-overs.
    expect(capture.patched?.details.findings).toHaveLength(1);
    expect(capture.patched?.details.entities).toEqual([{ entity: 'runbook', verdict: 'ok' }]);
    // The stamp is refreshed, so the next run compares against what was read now.
    expect(capture.patched?.details.config_fingerprint).toBe('bbbbbbbb');
    const markdown = capture.patched?.details.markdown ?? '';
    expect(markdown).toContain('(carry-over)');
    expect(markdown).toContain('El chequeo es estático');
    expect(markdown).toContain('GITHUB_TOKEN');
    expect(markdown).toContain('### Audit coverage — PASSED');
  });

  it('keeps the previous fingerprint when this run could not compute one', async () => {
    // An unreadable configuration must not erase a usable stamp, or the next run
    // would re-analyse for no reason.
    const capture: ResolveCapture = { logs: [] };
    await runStepCode(
      CARRYOVER_CODE,
      { ...CARRYOVER_ITEM, config_fingerprint: '' },
      resolveFetch(capture),
    );
    expect(capture.patched?.details.config_fingerprint).toBe('aaaaaaaa');
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
