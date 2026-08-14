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

  it('rules on a partial snapshot instead of leaving it to the agent to notice', () => {
    const prompt = systemPrompt();
    expect(prompt).toContain('The snapshot header states its SNAPSHOT COVERAGE');
    expect(prompt).toContain('those files are unread');
    expect(prompt).toContain('gets verdict `unverified` with the coverage gap named in its `reason`');
    expect(prompt).toContain('Absence of an audit event is not evidence in a file you were not shown');
  });

  it('gives an unverified entity somewhere to say why', () => {
    const entity = (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      workflow().steps.find((s) => s.id === 'audit_agent') as any
    ).config.outputSchema.properties.entities.items.properties;
    expect(entity.reason?.type).toBe('string');
    expect(String(entity.reason?.description)).toContain('coverage gap');
  });

  it('does not ask the agent for the coverage figures themselves', () => {
    // Coverage is measured by `gather` while it packs the snapshot. Asking the
    // agent to restate it would make a deterministic fact a matter of opinion.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schema = (workflow().steps.find((s) => s.id === 'audit_agent') as any).config
      .outputSchema;
    expect(Object.keys(schema.properties)).not.toContain('coverage');
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

/** How much of the audit-relevant code the snapshot actually carries. */
interface Coverage {
  complete: boolean;
  hot_total: number;
  included: number;
  omitted_count: number;
  omitted: string[];
  truncated_count: number;
  truncated: string[];
}

interface GatherOutput {
  mode: string;
  scope?: string;
  repo: string;
  analyzed_sha: string;
  changed_count: number | null;
  /** Absent on the carry-over path, which never builds a snapshot. */
  llm_view: string;
  coverage?: Coverage;
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

/** One `type: blob` entry of `GET /git/trees/<branch>?recursive=1`. */
interface TreeBlob {
  path: string;
  size: number;
}

interface GatherFetchOptions {
  itemId?: string;
  prevStatus?: string;
  prevSha?: string;
  prevFingerprint?: string;
  /** Several prior approvals, in the order the API returns them. */
  priorApprovals?: PriorApproval[];
  prevEntities?: Array<{ entity: string }>;
  /** Findings stamped on the checkpoint, whose files re-enter the snapshot. */
  prevFindings?: Array<{ file?: string; entity?: string; issue?: string }>;
  changedFiles?: string[];
  /** Omit to have the prior approval list come back empty (no checkpoint). */
  withCheckpoint?: boolean;
  /** Repository tree the snapshot is packed from. */
  tree?: TreeBlob[];
  /** Body served per path by the raw contents endpoint. */
  contents?: (path: string) => string | null;
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
              findings: opts.prevFindings ?? [],
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
      const tree = opts.tree ?? [{ path: 'src/index.js', size: 500 }];
      return res(200, { tree: tree.map((b) => ({ ...b, type: 'blob' })) });
    }
    const contents = /\/contents\/(.+)\?ref=/.exec(url);
    if (contents) {
      const path = decodeURIComponent(contents[1]);
      const body = opts.contents ? opts.contents(path) : 'export const app = 1;';
      return body === null ? res(404, 'Not Found') : res(200, body);
    }
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

/**
 * The files the snapshot actually carries, in the order it lists them — read
 * back from the `--- path (truncated) ---` headers of its contents section.
 */
function snapshotFiles(llmView: string): Array<{ path: string; truncated: boolean }> {
  return [...llmView.matchAll(/^--- (.+?)( \(truncated\))? ---$/gm)].map((m) => ({
    path: m[1],
    truncated: m[2] !== undefined,
  }));
}

const snapshotPaths = (llmView: string): string[] => snapshotFiles(llmView).map((f) => f.path);

/** `n` files matching AUDIT_HOT and nothing stronger, all small. */
const hotTree = (n: number, size = 400): TreeBlob[] =>
  Array.from({ length: n }, (_, i) => ({
    path: `src/services/api-service-${String(i).padStart(3, '0')}.js`,
    size,
  }));

/** `n` files under a routes directory, which outrank the generic hot set. */
const routeTree = (n: number, size = 400): TreeBlob[] =>
  Array.from({ length: n }, (_, i) => ({
    path: `src/routes/entity-${String(i).padStart(3, '0')}.js`,
    size,
  }));

/** No checkpoint at all, so the run takes the full-analysis path. */
const FULL_SCOPE: GatherFetchOptions = { withCheckpoint: false };

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

describe('audit-entity-check gather — snapshot ranking', () => {
  it('gives route directories a slot before the rest of the hot set', async () => {
    // The check reasons about write routes, and on a repository with more
    // audit-relevant files than the budget holds, those are the files that must
    // survive the cut — not everything that happens to have "api" in its name.
    const out = await runGather(
      {},
      {
        ...FULL_SCOPE,
        tree: [
          ...hotTree(70),
          { path: 'src/routes/application.js', size: 40000 },
          { path: 'src/routes/deployment.js', size: 30000 },
        ],
      },
    );
    const paths = snapshotPaths(out.llm_view);
    expect(paths).toContain('src/routes/application.js');
    expect(paths).toContain('src/routes/deployment.js');
    // Ranked above the hot set, so they lead the snapshot.
    expect(paths.slice(0, 2)).toEqual(['src/routes/application.js', 'src/routes/deployment.js']);
  });

  it('keeps the big route modules that the ascending-size tie-break used to drop', async () => {
    // Ranking hot files by ascending size filled the snapshot with the smallest
    // of them, so the largest route file of a big repository — the CRUD module
    // this check exists to read — was the first thing cut, silently.
    const out = await runGather(
      {},
      {
        ...FULL_SCOPE,
        tree: [...hotTree(70, 300), { path: 'src/controllers/scope.js', size: 90000 }],
      },
    );
    expect(snapshotPaths(out.llm_view)).toContain('src/controllers/scope.js');
  });

  it('ranks handler and endpoint directories with the routes', async () => {
    const out = await runGather(
      {},
      {
        ...FULL_SCOPE,
        tree: [
          ...hotTree(70),
          { path: 'internal/handlers/user.go', size: 8000 },
          { path: 'app/endpoints/notification.py', size: 8000 },
        ],
      },
    );
    const paths = snapshotPaths(out.llm_view);
    expect(paths.slice(0, 2)).toEqual([
      'app/endpoints/notification.py',
      'internal/handlers/user.go',
    ]);
  });

  it('breaks a tie by path, not by size', async () => {
    const out = await runGather(
      {},
      {
        ...FULL_SCOPE,
        tree: [
          { path: 'src/routes/aaa.js', size: 9000 },
          { path: 'src/routes/bbb.js', size: 100 },
          { path: 'src/routes/ccc.js', size: 5000 },
        ],
      },
    );
    expect(snapshotPaths(out.llm_view)).toEqual([
      'src/routes/aaa.js',
      'src/routes/bbb.js',
      'src/routes/ccc.js',
    ]);
  });

  it('does not let a mirrored test suite crowd the production code out', async () => {
    // A Node repository whose suite mirrors its routes — `test/routes/*.spec.js`
    // next to `routes/*.js` — used to hand every one of those fixtures the
    // route-dir rank, so the fixtures took the budget and real code that only
    // matched AUDIT_HOT was pushed out. That is this change's own bug, inverted.
    const out = await runGather(
      {},
      {
        ...FULL_SCOPE,
        tree: [
          ...Array.from({ length: 60 }, (_, i) => ({
            path: `test/routes/fixture-${String(i).padStart(2, '0')}.spec.js`,
            size: 400,
          })),
          { path: 'src/lib/audit-publisher.js', size: 900 },
          { path: 'src/routes/application.js', size: 40000 },
        ],
      },
    );
    expect(snapshotPaths(out.llm_view)).toEqual([
      'src/routes/application.js',
      'src/lib/audit-publisher.js',
    ]);
    // And the fixtures are not audit-relevant, so they are not a coverage gap.
    expect(out.coverage).toMatchObject({ complete: true, hot_total: 2, included: 2 });
  });

  it('gives no rank at all to tests, mocks, specs or documentation', async () => {
    const out = await runGather(
      {},
      {
        ...FULL_SCOPE,
        tree: [
          { path: 'test/routes/user.spec.js', size: 400 },
          { path: 'tests/controllers/scope.js', size: 400 },
          { path: '__tests__/handlers/audit.js', size: 400 },
          { path: '__mocks__/routes/api.js', size: 400 },
          { path: 'spec/endpoints/notification.js', size: 400 },
          { path: 'docs/routes/application.md', size: 400 },
          { path: 'doc/controllers/api.md', size: 400 },
          { path: 'src/api/legacy/tests/helper.js', size: 400 },
          { path: 'src/routes/real.js', size: 400 },
        ],
      },
    );
    expect(snapshotPaths(out.llm_view)).toEqual(['src/routes/real.js']);
    expect(out.coverage).toMatchObject({ complete: true, hot_total: 1 });
  });

  it('keeps a route file whose name merely begins with "test"', async () => {
    // The exclusion matches whole path segments, so a legitimately named module
    // inside a routes directory is not caught by it.
    const out = await runGather(
      {},
      { ...FULL_SCOPE, tree: [{ path: 'src/routes/test_utils.js', size: 400 }, ...hotTree(70)] },
    );
    expect(snapshotPaths(out.llm_view)[0]).toBe('src/routes/test_utils.js');
  });

  it('still puts the changed files of an incremental run first of all', async () => {
    const out = await runGather(
      {},
      {
        changedFiles: ['src/services/api-service-042.js'],
        tree: [...hotTree(70), { path: 'src/routes/application.js', size: 40000 }],
      },
    );
    expect(out.scope).toBe('diff');
    expect(snapshotPaths(out.llm_view)[0]).toBe('src/services/api-service-042.js');
  });
});

describe('audit-entity-check gather — snapshot budget', () => {
  it('takes at most sixty files', async () => {
    const out = await runGather({}, { ...FULL_SCOPE, tree: hotTree(200) });
    expect(snapshotFiles(out.llm_view)).toHaveLength(60);
  });

  it('clips a file at the per-file budget and marks it truncated', async () => {
    const out = await runGather(
      {},
      {
        ...FULL_SCOPE,
        tree: [
          { path: 'src/routes/huge.js', size: 60000 },
          { path: 'src/routes/small.js', size: 100 },
        ],
        contents: (p) => (p.endsWith('huge.js') ? 'x'.repeat(60000) : 'ok'),
      },
    );
    expect(snapshotFiles(out.llm_view)).toEqual([
      { path: 'src/routes/huge.js', truncated: true },
      { path: 'src/routes/small.js', truncated: false },
    ]);
    expect(out.llm_view).toContain('x'.repeat(24000));
    expect(out.llm_view).not.toContain('x'.repeat(24001));
  });

  it('stops at the total character budget', async () => {
    // 24000 chars per file against a 240000 total: ten files fill it, and the
    // rest of the ranking never gets fetched.
    const out = await runGather(
      {},
      { ...FULL_SCOPE, tree: hotTree(60, 30000), contents: () => 'x'.repeat(30000) },
    );
    const files = snapshotFiles(out.llm_view);
    expect(files).toHaveLength(10);
    expect(files.every((f) => f.truncated)).toBe(true);
  });

  it('gives no slot to a blob too big to be worth one', async () => {
    const out = await runGather(
      {},
      {
        ...FULL_SCOPE,
        tree: [
          { path: 'src/routes/generated.js', size: 400000 },
          { path: 'src/routes/real.js', size: 900 },
        ],
      },
    );
    expect(snapshotPaths(out.llm_view)).toEqual(['src/routes/real.js']);
  });

  it('skips a file whose contents could not be fetched', async () => {
    const out = await runGather(
      {},
      {
        ...FULL_SCOPE,
        tree: [
          { path: 'src/routes/gone.js', size: 900 },
          { path: 'src/routes/here.js', size: 900 },
        ],
        contents: (p) => (p.endsWith('gone.js') ? null : 'ok'),
      },
    );
    expect(snapshotPaths(out.llm_view)).toEqual(['src/routes/here.js']);
  });
});

/**
 * Paths the workflow treats as tests or documentation, one per shape of the
 * vocabulary. Every one carries an extension RELEVANT accepts, so a change
 * confined to it would re-open the analysis were it not excluded.
 */
const TEST_OR_DOCS_SAMPLES = [
  'test/routes/user.js',
  'tests/controllers/scope.rb',
  '__tests__/handlers/audit.ts',
  '__mocks__/routes/api.js',
  'spec/webhook-handler_spec.rb',
  'specs/endpoints/notification.py',
  'docs/routes/application.js',
  'doc/controllers/api.js',
];

describe('audit-entity-check gather — tests and docs, one vocabulary', () => {
  it('is defined once and used by both rules', () => {
    // Two lists drift. The scope decision and the snapshot have to exclude
    // exactly the same files, or one of them can admit what the other hides.
    expect(GATHER_CODE).toContain('const TEST_OR_DOCS =');
    expect(GATHER_CODE).toContain('TEST_OR_DOCS.source');
    expect(GATHER_CODE).not.toMatch(/const IRRELEVANT = \/.*__tests__/);
  });

  it.each(TEST_OR_DOCS_SAMPLES)('does not re-open the analysis for %s alone', async (path) => {
    const out = await runGather({}, { changedFiles: [path] });
    expect(out.mode).toBe('carry_over');
  });

  it.each(TEST_OR_DOCS_SAMPLES)('gives %s no slot in the snapshot', async (path) => {
    const out = await runGather(
      {},
      {
        ...FULL_SCOPE,
        tree: [
          { path, size: 400 },
          { path: 'src/routes/real.js', size: 400 },
        ],
      },
    );
    expect(snapshotPaths(out.llm_view)).toEqual(['src/routes/real.js']);
    expect(out.coverage).toMatchObject({ complete: true, hot_total: 1 });
  });
});

describe('audit-entity-check gather — a file that caused the run is never hidden', () => {
  it('carries over a spec-only change instead of analysing without it', async () => {
    // A Ruby suite lives in `spec/`, and `.rb` is a source extension the diff
    // rule accepts. While the snapshot excluded `spec/` and the diff rule did
    // not, this change opened a diff-scoped run whose snapshot then dropped the
    // one file the run was about — and coverage reported itself complete.
    const out = await runGather({}, { changedFiles: ['spec/webhook-handler_spec.rb'] });
    expect(out.mode).toBe('carry_over');
  });

  it('puts a changed file in the snapshot even when its path reads as a test', async () => {
    // Defence in depth for the next time the two lists drift: whatever opened
    // this run is ranked before the test/docs exclusion is consulted.
    const out = await runGather(
      { config_fingerprint: 'ffffffff' },
      {
        changedFiles: ['spec/webhook-handler_spec.rb'],
        prevFingerprint: 'aaaaaaaa',
        tree: [
          { path: 'spec/webhook-handler_spec.rb', size: 900 },
          { path: 'src/routes/real.js', size: 900 },
        ],
      },
    );
    // The enhancer configuration moved, so the run happens regardless of the diff.
    expect(out.scope).toBe('diff');
    expect(snapshotPaths(out.llm_view)).toContain('spec/webhook-handler_spec.rb');
    expect(out.coverage).toMatchObject({ complete: true, hot_total: 2, included: 2 });
  });

  it('re-reads a previously flagged file in verify_fix, wherever it lives', async () => {
    const out = await runGather(
      {},
      {
        prevSha: SHA_CURRENT,
        prevStatus: 'failed',
        prevFindings: [{ file: 'spec/webhook-handler_spec.rb', issue: 'no audit event' }],
        tree: [
          { path: 'spec/webhook-handler_spec.rb', size: 900 },
          { path: 'src/routes/real.js', size: 900 },
        ],
      },
    );
    expect(out.scope).toBe('verify_fix');
    expect(snapshotPaths(out.llm_view)).toContain('spec/webhook-handler_spec.rb');
    expect(out.coverage?.complete).toBe(true);
  });
});

describe('audit-entity-check gather — snapshot coverage', () => {
  it('reports a complete snapshot when every audit-relevant file fits', async () => {
    const out = await runGather({}, { ...FULL_SCOPE, tree: routeTree(3) });
    expect(out.coverage).toEqual({
      complete: true,
      hot_total: 3,
      included: 3,
      omitted_count: 0,
      omitted: [],
      truncated_count: 0,
      truncated: [],
    });
    expect(out.llm_view).toContain('### Snapshot coverage');
    expect(out.llm_view).toContain('COMPLETE: every audit-relevant file');
  });

  it('names the audit-relevant files the budget did not reach', async () => {
    const out = await runGather({}, { ...FULL_SCOPE, tree: hotTree(70) });
    expect(out.coverage?.complete).toBe(false);
    expect(out.coverage?.hot_total).toBe(70);
    expect(out.coverage?.included).toBe(60);
    expect(out.coverage?.omitted_count).toBe(10);
    expect(out.coverage?.omitted).toEqual(
      hotTree(70)
        .slice(60)
        .map((b) => b.path),
    );
  });

  it('lists the omitted files in ranking order, so the cap keeps the worst misses', async () => {
    // 140 files miss the snapshot; only 50 paths travel, and they have to be the
    // ones that mattered most — routes before the rest of the hot set.
    const out = await runGather(
      {},
      { ...FULL_SCOPE, tree: [...hotTree(100), ...routeTree(70)] },
    );
    expect(out.coverage?.omitted_count).toBe(110);
    expect(out.coverage?.omitted).toHaveLength(50);
    expect(out.coverage?.omitted?.[0]).toBe('src/routes/entity-060.js');
    // The routes that missed come before any generic hot file.
    expect(out.coverage?.omitted?.slice(0, 10).every((p) => p.startsWith('src/routes/'))).toBe(true);
  });

  it('counts a file it had to clip as incomplete coverage, not as read', async () => {
    const out = await runGather(
      {},
      {
        ...FULL_SCOPE,
        tree: [
          { path: 'src/routes/huge.js', size: 60000 },
          { path: 'src/routes/small.js', size: 100 },
        ],
        contents: (p) => (p.endsWith('huge.js') ? 'x'.repeat(60000) : 'ok'),
      },
    );
    expect(out.coverage?.complete).toBe(false);
    expect(out.coverage?.included).toBe(2);
    expect(out.coverage?.omitted).toEqual([]);
    expect(out.coverage?.truncated).toEqual(['src/routes/huge.js']);
    expect(out.coverage?.truncated_count).toBe(1);
  });

  it('counts a blob rejected for its size, and one that could not be fetched', async () => {
    // Both are audit-relevant files the agent will not see, whatever the reason.
    const out = await runGather(
      {},
      {
        ...FULL_SCOPE,
        tree: [
          { path: 'src/routes/generated.js', size: 400000 },
          { path: 'src/routes/gone.js', size: 900 },
          { path: 'src/routes/here.js', size: 900 },
        ],
        contents: (p) => (p.endsWith('gone.js') ? null : 'ok'),
      },
    );
    expect(out.coverage?.complete).toBe(false);
    expect(out.coverage?.omitted).toEqual(['src/routes/generated.js', 'src/routes/gone.js']);
  });

  it('tells the agent to mark the affected entities unverified', async () => {
    const out = await runGather({}, { ...FULL_SCOPE, tree: hotTree(70) });
    const view = out.llm_view.replace(/\s+/g, ' ');
    expect(view).toContain('INCOMPLETE: 60 of 70 audit-relevant file(s)');
    expect(view).toContain('NOT shown to you at all (10)');
    expect(view).toContain('Treat every file listed above as unread');
    expect(view).toContain('must be reported with verdict `unverified`');
    expect(view).toContain('may claim the review covered the whole repository');
  });

  it('caps the list it shows the agent as well', async () => {
    const out = await runGather({}, { ...FULL_SCOPE, tree: hotTree(200) });
    expect(out.llm_view).toContain('NOT shown to you at all (140)');
    expect(out.llm_view).toContain('…and 90 more');
  });

  it('reports no coverage on the carry-over path, which builds no snapshot', async () => {
    const out = await runGather({}, { prevSha: SHA_CURRENT });
    expect(out.mode).toBe('carry_over');
    expect(out.coverage).toBeUndefined();
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
    coverage?: Coverage | null;
    analyzed_sha: string;
    scope: string;
    carried_from?: string;
  };
}

/** A snapshot that missed 12 files and clipped one more. */
const PARTIAL_COVERAGE: Coverage = {
  complete: false,
  hot_total: 73,
  included: 60,
  omitted_count: 12,
  omitted: Array.from({ length: 12 }, (_, i) => `src/routes/entity-${String(i).padStart(2, '0')}.js`),
  truncated_count: 1,
  truncated: ['src/routes/application.js'],
};

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

describe('audit-entity-check resolve — snapshot coverage', () => {
  const withCoverage = (coverage: Coverage | undefined) => ({ ...RESOLVE_ITEM, coverage });

  it('publishes the coverage block next to the verdict it qualifies', async () => {
    const capture: ResolveCapture = { logs: [] };
    await runStepCode(RESOLVE_CODE, withCoverage(PARTIAL_COVERAGE), resolveFetch(capture));
    expect(capture.patched?.details.coverage).toEqual(PARTIAL_COVERAGE);
  });

  it('names the omitted files in the markdown, capped at ten plus a count', async () => {
    const capture: ResolveCapture = { logs: [] };
    await runStepCode(RESOLVE_CODE, withCoverage(PARTIAL_COVERAGE), resolveFetch(capture));
    const markdown = capture.patched?.details.markdown ?? '';
    expect(markdown).toContain('**Cobertura del snapshot: INCOMPLETA**');
    expect(markdown).toContain('leyó 60 de 73 archivo(s)');
    expect(markdown).toContain('12 archivo(s) que no entraron');
    expect(markdown).toContain('`src/routes/entity-00.js`');
    expect(markdown).toContain('`src/routes/entity-09.js`');
    expect(markdown).not.toContain('`src/routes/entity-10.js`');
    expect(markdown).toContain('…y 2 más');
    expect(markdown).toContain('1 archivo(s) truncado(s)');
    expect(markdown).toContain('`src/routes/application.js`');
  });

  it('logs the shortfall as a warning without changing the verdict', async () => {
    const capture: ResolveCapture = { logs: [] };
    await runStepCode(
      RESOLVE_CODE,
      { ...withCoverage(PARTIAL_COVERAGE), verdict: { status: 'passed', summary: 'All good.' } },
      resolveFetch(capture),
    );
    // Best-effort by design: a partial reading is declared, never escalated.
    expect(capture.patched?.status).toBe('passed');
    expect(
      capture.logs.some((l) => l.includes('Snapshot coverage incomplete: 12 audit-relevant file(s)')),
    ).toBe(true);
  });

  it('says nothing when the snapshot was complete', async () => {
    const capture: ResolveCapture = { logs: [] };
    const complete: Coverage = {
      complete: true,
      hot_total: 8,
      included: 8,
      omitted_count: 0,
      omitted: [],
      truncated_count: 0,
      truncated: [],
    };
    await runStepCode(RESOLVE_CODE, withCoverage(complete), resolveFetch(capture));
    expect(capture.patched?.details.markdown).not.toContain('Cobertura del snapshot');
    expect(capture.patched?.details.coverage).toEqual(complete);
    expect(capture.logs.some((l) => l.includes('coverage incomplete'))).toBe(false);
  });

  it('resolves the item when no coverage reached it at all', async () => {
    const capture: ResolveCapture = { logs: [] };
    await runStepCode(RESOLVE_CODE, withCoverage(undefined), resolveFetch(capture));
    expect(capture.patched?.status).toBe('failed');
    expect(capture.patched?.details.coverage).toBeNull();
    expect(capture.patched?.details.markdown).not.toContain('Cobertura del snapshot');
  });

  it('renders the reason the agent gives for an unverified entity', async () => {
    const capture: ResolveCapture = { logs: [] };
    await runStepCode(
      RESOLVE_CODE,
      {
        ...withCoverage(PARTIAL_COVERAGE),
        verdict: {
          ...RESOLVE_ITEM.verdict,
          entities: [
            {
              entity: 'scope',
              source: 'POST /scope',
              verdict: 'unverified',
              reason: 'its routes are in src/routes/entity-00.js, omitted from the snapshot',
            },
          ],
        },
      },
      resolveFetch(capture),
    );
    const markdown = capture.patched?.details.markdown ?? '';
    expect(markdown).toContain('❔ `scope` (unverified) — POST /scope');
    expect(markdown).toContain('omitted from the snapshot');
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
