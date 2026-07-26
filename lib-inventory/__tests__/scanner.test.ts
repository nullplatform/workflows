/**
 * Unit tests for the library-inventory scanner.
 *
 * These cover the rungs of the resolution ladder and the parsing rules that
 * were derived from real repositories in production — each `it` name points at the
 * repository shape that motivated it, so a future change that "simplifies" one
 * of them fails with the reason attached.
 */
import { describe, expect, it } from 'vitest';

import {
  compileInternalPatterns,
  indexTree,
  manifestsUnder,
  normalizeName,
  parseGoMod,
  parseRepoUrl,
  resolveAsset,
  scanBuild,
} from '../scanner/scanner.mjs';

const NOW = '2026-07-26T00:00:00.000Z';
const INTERNAL = compileInternalPatterns(['^github\\.com/acme/']);

/** Minimal fake transport: a flat map of path -> file contents. */
function fakeGh(files: Record<string, string>) {
  return {
    tree: async () => Object.keys(files),
    blobs: async (_o: string, _r: string, _ref: string, paths: string[]) =>
      Object.fromEntries(paths.filter((p) => p in files).map((p) => [p, files[p]!])),
  };
}

function build(over: Record<string, unknown> = {}) {
  return {
    app_id: 1,
    app_name: 'app',
    repository_url: 'https://github.com/acme/repo',
    build_id: 10,
    commit: 'abc123',
    assets: [{ id: 100, name: 'get-toggles-aws-lambda', type: 'lambda' }],
    ...over,
  };
}

describe('parseGoMod', () => {
  it('reads the // indirect marker rather than inferring transitivity', () => {
    const deps = parseGoMod(`module x
require (
\tgithub.com/acme/logging v1.1.3
\tgithub.com/acme/env v1.1.0 // indirect
)`);
    expect(deps).toEqual([
      { name: 'github.com/acme/logging', version: 'v1.1.3', direct: true, ecosystem: 'go', local: false },
      { name: 'github.com/acme/env', version: 'v1.1.0', direct: false, ecosystem: 'go', local: false },
    ]);
  });

  it('flags a module replaced by a filesystem path as local, not a library', () => {
    // `pkg` is in-repo shared code; it carries a placeholder version and would
    // otherwise show up as a dependency nobody can bump.
    const deps = parseGoMod(`module x
require (
\tpkg v0.0.0-00010101000000-000000000000
)
replace pkg => ../../../pkg`);
    expect(deps[0]).toMatchObject({ name: 'pkg', local: true });
  });

  it('handles a single-line require outside a block', () => {
    expect(parseGoMod('module x\nrequire github.com/a/b v1.0.0')).toEqual([
      { name: 'github.com/a/b', version: 'v1.0.0', direct: true, ecosystem: 'go', local: false },
    ]);
  });
});

describe('parseRepoUrl', () => {
  it.each([
    ['https://github.com/acme/repo', { owner: 'acme', repo: 'repo' }],
    ['https://github.com/acme/repo.git', { owner: 'acme', repo: 'repo' }],
    ['https://github.com/acme/repo/', { owner: 'acme', repo: 'repo' }],
    ['git@github.com:acme/repo.git', { owner: 'acme', repo: 'repo' }],
  ])('parses %s', (url, expected) => {
    expect(parseRepoUrl(url)).toEqual(expected);
  });

  it('returns null for a non-GitHub or empty url', () => {
    expect(parseRepoUrl('')).toBeNull();
    expect(parseRepoUrl('https://gitlab.com/x/y')).toBeNull();
  });
});

describe('normalizeName', () => {
  it('strips deployment-shape suffixes so L3 can compare code names', () => {
    expect(normalizeName('get-toggles-aws-lambda')).toBe('gettoggles');
    expect(normalizeName('security-scoreboard-aws-uks')).toBe('securityscoreboard');
  });
});

describe('resolution ladder', () => {
  it('L1: matches an asset to a directory of the same name', () => {
    const idx = indexTree(['lambdas/go/get-toggles-aws-lambda/go.mod']);
    expect(resolveAsset('get-toggles-aws-lambda', idx, null)).toEqual({
      level: 'L1',
      dir: 'lambdas/go/get-toggles-aws-lambda',
    });
  });

  it('L1 tie-break: prefers the candidate that holds a manifest, then the shallowest', () => {
    // Real shape seen in production: the asset `migrations` matches both
    // `migrations/` and `migrations/src/main/resources/db/migrations`, and only
    // the former has a pom.
    const idx = indexTree([
      'migrations/pom.xml',
      'migrations/src/main/resources/db/migrations/V1__init.sql',
    ]);
    expect(resolveAsset('migrations', idx, null)).toEqual({ level: 'L1', dir: 'migrations' });
  });

  it('L2: falls back to the name declared inside the manifest', () => {
    // A Maven monorepo ships `acme-model` out of `modules/model`.
    // Several manifest dirs, as in the real repo — with only one, L4 would
    // claim the asset before L2 ever got a chance.
    const idx = indexTree([
      'modules/model/pom.xml',
      'modules/migrations/pom.xml',
      'modules/investments/proxy-lambda/pom.xml',
    ]);
    expect(resolveAsset('acme-model', idx, null)).toBeNull();
    const declared = new Map([['acme-model', 'modules/model']]);
    expect(resolveAsset('acme-model', idx, declared)).toEqual({
      level: 'L2',
      dir: 'modules/model',
    });
  });

  it('L4: a repo with a single manifest root serves any asset name', () => {
    const idx = indexTree(['go.mod', 'main.go']);
    expect(resolveAsset('anything-at-all', idx, null)).toEqual({ level: 'L4', dir: '' });
  });

  it('L5: leaves an asset unresolved rather than guessing', () => {
    const idx = indexTree(['a/go.mod', 'b/go.mod']);
    expect(resolveAsset('totally-unrelated', idx, null)).toBeNull();
  });
});

describe('manifestsUnder', () => {
  it('collects every manifest in the subtree, not just the top one', () => {
    // Real shape seen in production: one container asset, three manifests.
    const idx = indexTree([
      'containers/scoreboard-aws-uks/frontend/package.json',
      'containers/scoreboard-aws-uks/scanner/requirements.txt',
      'containers/scoreboard-aws-uks/social_scrapers/requirements.txt',
    ]);
    expect(manifestsUnder(idx, 'containers/scoreboard-aws-uks')).toHaveLength(3);
  });
});

describe('scanBuild', () => {
  const GO_MOD = `module x
require (
\tgithub.com/acme/logging v1.1.3
)
require (
\tgithub.com/acme/env v1.1.0 // indirect
\tgithub.com/aws/aws-sdk-go-v2 v1.41.5 // indirect
)`;

  it('keeps direct deps and transitive INTERNAL ones, drops transitive external', async () => {
    const gh = fakeGh({ 'lambdas/go/get-toggles-aws-lambda/go.mod': GO_MOD });
    const [row] = await scanBuild(build(), gh, { internalPatterns: INTERNAL, now: NOW });

    expect(row.data.status).toBe('ok');
    expect(row.data.dependencies.map((d: { name: string }) => d.name)).toEqual([
      'github.com/acme/logging',
      'github.com/acme/env',
    ]);
    // The AWS SDK is transitive and external: counted, deliberately not stored.
    expect(row.data.transitive_external_dropped).toBe(1);
    expect(row.data.total_count).toBe(2);
    expect(row.data.direct_count).toBe(1);
    expect(row.data.internal_count).toBe(2);
  });

  it('stores the whole SBOM when keepTransitiveExternal is set', async () => {
    const gh = fakeGh({ 'lambdas/go/get-toggles-aws-lambda/go.mod': GO_MOD });
    const [row] = await scanBuild(build(), gh, {
      internalPatterns: INTERNAL,
      now: NOW,
      keepTransitiveExternal: true,
    });
    expect(row.data.dependencies).toHaveLength(3);
    expect(row.data.transitive_external_dropped).toBe(0);
  });

  it('records no_manifest instead of silently skipping an asset', async () => {
    // A plain postgres image: the directory exists, there is nothing to parse.
    const gh = fakeGh({ 'lambdas/go/get-toggles-aws-lambda/Dockerfile': 'FROM postgres' });
    const [row] = await scanBuild(build(), gh, { internalPatterns: INTERNAL, now: NOW });
    expect(row.data.status).toBe('no_manifest');
    expect(row.data.repository_path).toBe('lambdas/go/get-toggles-aws-lambda');
    expect(row.data.status_detail).toContain('no dependency manifest');
  });

  it('records lang_unsupported when a manifest exists but has no parser yet', async () => {
    const gh = fakeGh({ 'lambdas/go/get-toggles-aws-lambda/pom.xml': '<project/>' });
    const [row] = await scanBuild(build(), gh, { internalPatterns: INTERNAL, now: NOW });
    expect(row.data.status).toBe('lang_unsupported');
    expect(row.data.languages).toEqual(['java-maven']);
  });

  it('records unresolved rather than attaching the asset to an arbitrary directory', async () => {
    const gh = fakeGh({ 'a/go.mod': GO_MOD, 'b/go.mod': GO_MOD });
    const [row] = await scanBuild(build(), gh, { internalPatterns: INTERNAL, now: NOW });
    expect(row.data.status).toBe('unresolved');
  });

  it('emits a row per asset when the repository is unreachable', async () => {
    const gh = {
      tree: async () => {
        throw new Error('HTTP 404');
      },
      blobs: async () => ({}),
    };
    const rows = await scanBuild(
      build({ assets: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] }),
      gh,
      { internalPatterns: INTERNAL, now: NOW },
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.data.status === 'repo_unreachable')).toBe(true);
    expect(rows[0]!.data.status_detail).toContain('404');
  });

  it('reports repo_missing when the application has no repository configured', async () => {
    const rows = await scanBuild(build({ repository_url: '' }), fakeGh({}), {
      internalPatterns: INTERNAL,
      now: NOW,
    });
    expect(rows[0]!.data.status).toBe('repo_missing');
  });

  it('says which languages went unparsed when coverage is partial', async () => {
    const gh = fakeGh({
      'lambdas/go/get-toggles-aws-lambda/go.mod': GO_MOD,
      'lambdas/go/get-toggles-aws-lambda/ui/package.json': '{"dependencies":{}}',
    });
    const [row] = await scanBuild(build(), gh, { internalPatterns: INTERNAL, now: NOW });
    expect(row.data.status).toBe('ok');
    expect(row.data.status_detail).toContain('node');
  });
});

describe('compileInternalPatterns', () => {
  it('accepts the JSON string a config entry delivers', () => {
    const [re] = compileInternalPatterns('["^github\\\\.com/acme/"]');
    expect(re.test('github.com/acme/logging')).toBe(true);
    expect(re.test('github.com/aws/aws-sdk-go-v2')).toBe(false);
  });

  it('returns no patterns for an empty entry instead of throwing', () => {
    expect(compileInternalPatterns('')).toEqual([]);
    expect(compileInternalPatterns(undefined)).toEqual([]);
  });
});
