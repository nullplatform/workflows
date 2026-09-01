/**
 * Unit tests for the library-inventory scanner.
 *
 * These cover the rungs of the resolution ladder and the parsing rules that
 * were derived from real the reference organization repositories — each `it` name points at the
 * repository shape that motivated it, so a future change that "simplifies" one
 * of them fails with the reason attached.
 */
import { describe, expect, it } from 'vitest';

import {
  compileInternalPatterns,
  indexTree,
  manifestsUnder,
  mergeParsed,
  normalizeName,
  csprojConfig,
  parseCsproj,
  parseGoMod,
  parsePackageJson,
  parsePomXml,
  parsePython,
  parseRepoUrl,
  pomConfig,
  pythonConfig,
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
\tgithub.com/acme/goala/ulog v1.1.3
\tgithub.com/acme/goala/uenv v1.1.0 // indirect
)`);
    expect(deps).toEqual([
      {
        name: 'github.com/acme/goala/ulog',
        version: 'v1.1.3',
        direct: true,
        ecosystem: 'go',
        local: false,
      },
      {
        name: 'github.com/acme/goala/uenv',
        version: 'v1.1.0',
        direct: false,
        ecosystem: 'go',
        local: false,
      },
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

describe('parsePackageJson', () => {
  it('collects every dependency block, first scope wins on a duplicate', () => {
    const deps = parsePackageJson(
      JSON.stringify({
        dependencies: { '@nullplatform/sdk': '^1.2.3', lodash: '4.0.0' },
        devDependencies: { vitest: '^2.1.9', lodash: '9.9.9' },
        optionalDependencies: { fsevents: '*' },
      }),
    );
    expect(deps.map((d: { name: string }) => d.name)).toEqual([
      '@nullplatform/sdk',
      'lodash',
      'fsevents',
      'vitest',
    ]);
    // `lodash` appears in both blocks — it is a real dependency, not a dev one.
    expect(deps.find((d: { name: string }) => d.name === 'lodash')).toMatchObject({
      dev: false,
      version: '4.0.0',
    });
    expect(deps.find((d: { name: string }) => d.name === 'vitest')).toMatchObject({ dev: true });
    expect(deps.find((d: { name: string }) => d.name === 'fsevents')).toMatchObject({
      optional: true,
    });
  });

  it('keeps the DECLARED range, since nothing is installed or resolved', () => {
    const [dep] = parsePackageJson('{"dependencies":{"react":"^18.0.0"}}');
    expect(dep).toMatchObject({ version: '^18.0.0', direct: true, ecosystem: 'node' });
  });

  it.each(['workspace:*', 'file:../shared', 'link:../shared', 'portal:../shared'])(
    'flags %s as in-repo code rather than a consumed library',
    (spec) => {
      const [dep] = parsePackageJson(JSON.stringify({ dependencies: { shared: spec } }));
      expect(dep).toMatchObject({ name: 'shared', local: true });
    },
  );

  it('returns nothing for a package.json that does not parse, instead of throwing', () => {
    // One malformed manifest in a monorepo must not fail the whole build's scan.
    expect(parsePackageJson('{ not json')).toEqual([]);
    expect(parsePackageJson('null')).toEqual([]);
  });
});

describe('parsePomXml', () => {
  const POM = `<project>
  <groupId>com.acme</groupId><artifactId>svc</artifactId><version>2.1.0</version>
  <parent><groupId>com.acme</groupId><artifactId>platform</artifactId><version>7.0</version></parent>
  <properties><java.version>17</java.version><lib.version>3.4.5</lib.version></properties>
  <dependencyManagement><dependencies>
    <dependency><groupId>org.x</groupId><artifactId>bom-dep</artifactId><version>9.9</version></dependency>
  </dependencies></dependencyManagement>
  <dependencies>
    <dependency><groupId>com.acme</groupId><artifactId>common</artifactId><version>\${lib.version}</version></dependency>
    <dependency><groupId>org.x</groupId><artifactId>bom-dep</artifactId></dependency>
    <dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13</version><scope>test</scope></dependency>
    <dependency><groupId>un</groupId><artifactId>resolved</artifactId><version>\${from.parent}</version></dependency>
  </dependencies>
</project>`;

  it('names a dependency by its full coordinate, not the artifactId', () => {
    // `common`, `core`, `model` collide across organizations; only
    // `groupId:artifactId` makes "is this internal" answerable.
    const deps = parsePomXml(POM);
    expect(deps.map((d: { name: string }) => d.name)).toContain('com.acme:common');
  });

  it('resolves ${property} from the pom own properties', () => {
    const dep = parsePomXml(POM).find((d: { name: string }) => d.name === 'com.acme:common');
    expect(dep).toMatchObject({ version: '3.4.5' });
  });

  it('fills a missing version from dependencyManagement, which is not itself a dependency', () => {
    const deps = parsePomXml(POM);
    expect(deps.find((d: { name: string }) => d.name === 'org.x:bom-dep')).toMatchObject({
      version: '9.9',
    });
    // The management block declares nothing on its own — one entry, not two.
    expect(deps.filter((d: { name: string }) => d.name === 'org.x:bom-dep')).toHaveLength(1);
  });

  it('keeps an unresolvable version VERBATIM rather than guessing', () => {
    // It came from a parent POM, which resolving would mean running Maven.
    // `\${from.parent}` in the record reads as obviously unresolved; a
    // substituted guess would not.
    expect(parsePomXml(POM).find((d: { name: string }) => d.name === 'un:resolved')).toMatchObject({
      version: '${from.parent}',
    });
  });

  it('separates test scope from what the artifact ships', () => {
    expect(parsePomXml(POM).find((d: { name: string }) => d.name === 'junit:junit')).toMatchObject({
      dev: true,
      scope: 'test',
    });
  });

  it('does not inventory a commented-out dependency', () => {
    const deps = parsePomXml(
      '<project><dependencies><!--<dependency><groupId>g</groupId><artifactId>a</artifactId></dependency>--></dependencies></project>',
    );
    expect(deps).toEqual([]);
  });

  it('resolves ${property} from a parent POM in the SAME repository', () => {
    // Not an exception to "no reactor resolution" — the free part of it. Every
    // manifest in the repository is already fetched (rung L2 reads artifact
    // names), so a module pom whose parent sits at the root resolves with no
    // network call and no build. A real asset came back with three of six
    // versions still `${the reference organization.accounts.core.version}`, every one of them defined
    // one directory up.
    const child = `<project>
  <parent><groupId>com.acme</groupId><artifactId>platform</artifactId><version>1.0</version></parent>
  <artifactId>svc</artifactId>
  <dependencies>
    <dependency><groupId>com.acme</groupId><artifactId>core</artifactId><version>\${core.version}</version></dependency>
  </dependencies>
</project>`;
    const parent = `<project>
  <artifactId>platform</artifactId>
  <properties><core.version>4.2.0</core.version></properties>
</project>`;

    // Without the sibling it stays verbatim — the documented behaviour.
    expect(parsePomXml(child)[0]).toMatchObject({ version: '${core.version}' });
    // With it, resolved.
    expect(parsePomXml(child, 'svc/pom.xml', { 'pom.xml': parent })[0]).toMatchObject({
      version: '4.2.0',
    });
  });

  it('leaves a parent that is NOT in the repository unresolved', () => {
    const child = `<project>
  <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.2.0</version></parent>
  <dependencies>
    <dependency><groupId>g</groupId><artifactId>a</artifactId><version>\${spring.version}</version></dependency>
  </dependencies>
</project>`;
    expect(
      parsePomXml(child, 'pom.xml', {
        'other/pom.xml': '<project><artifactId>x</artifactId></project>',
      })[0],
    ).toMatchObject({
      version: '${spring.version}',
    });
  });

  it('records the Java it targets — the JVM engines.node', () => {
    expect(pomConfig(POM)).toMatchObject({
      artifactId: 'svc',
      version: '2.1.0',
      parent: 'com.acme:platform:7.0',
      'java.version': '17',
    });
  });
});

describe('parsePython', () => {
  it('reads requirements.txt, dropping markers but keeping the requirement', () => {
    const deps = parsePython(
      '# comment\nDjango==4.2.1\nboto3>=1.0 ; python_version<"3.9"\n-r other.txt\nrequests[security]==2.0',
      'a/requirements.txt',
    );
    expect(deps.map((d: { name: string }) => d.name)).toEqual(['Django', 'boto3', 'requests']);
    expect(deps[1]).toMatchObject({ version: '>=1.0' });
  });

  it('treats a path requirement as in-repo code, keeping the path as its identity', () => {
    // Running `-e ./local` through the package-name regex produced a
    // dependency literally called ".".
    const deps = parsePython('-e ./local\n../shared', 'a/requirements.txt');
    expect(deps).toEqual([
      { name: './local', version: '', direct: true, ecosystem: 'python', local: true },
      { name: '../shared', version: '', direct: true, ecosystem: 'python', local: true },
    ]);
  });

  it('reads PEP 621 pyproject.toml', () => {
    const deps = parsePython(
      '[project]\nname = "svc"\nrequires-python = ">=3.11"\ndependencies = ["fastapi>=0.100", "pydantic==2.1"]\n',
      'x/pyproject.toml',
    );
    expect(deps.map((d: { name: string }) => d.name)).toEqual(['fastapi', 'pydantic']);
  });

  it('reads Poetry, and never reports the INTERPRETER as a library', () => {
    const deps = parsePython(
      '[tool.poetry.dependencies]\npython = "^3.11"\nrequests = "^2.31"\nshared = { path = "../shared" }\n[tool.poetry.group.dev.dependencies]\npytest = "^7"\n',
      'y/pyproject.toml',
    );
    expect(deps.map((d: { name: string }) => d.name)).toEqual(['requests', 'shared', 'pytest']);
    expect(deps.find((d: { name: string }) => d.name === 'shared')).toMatchObject({ local: true });
    expect(deps.find((d: { name: string }) => d.name === 'pytest')).toMatchObject({ dev: true });
  });

  it('says when a requirements.txt is pip-compiled, since its direct flags over-report', () => {
    // A compiled file lists the whole closure. Saying so beats silently
    // mixing declarations with resolved transitives.
    expect(pythonConfig('django==4.2\n    # via -r req.in\n', 'a/requirements.txt')).toMatchObject({
      requirements_compiled: 'true',
    });
    expect(pythonConfig('django==4.2\n', 'a/requirements.txt')).toEqual({});
  });

  it('records the interpreter a pyproject targets', () => {
    expect(
      pythonConfig('[project]\nrequires-python = ">=3.11"\n', 'x/pyproject.toml'),
    ).toMatchObject({
      'requires-python': '>=3.11',
    });
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
    // Real shape from acme/acme-exchange: the asset `migrations` matches both
    // `migrations/` and `migrations/src/main/resources/db/migrations`, and only
    // the former has a pom.
    const idx = indexTree([
      'migrations/pom.xml',
      'migrations/src/main/resources/db/migrations/V1__init.sql',
    ]);
    expect(resolveAsset('migrations', idx, null)).toEqual({ level: 'L1', dir: 'migrations' });
  });

  it('L2: falls back to the name declared inside the manifest', () => {
    // acme/acme-savings ships `acme-savings-model` out of `modules/model`.
    // Several manifest dirs, as in the real repo — with only one, L4 would
    // claim the asset before L2 ever got a chance.
    const idx = indexTree([
      'modules/model/pom.xml',
      'modules/migrations/pom.xml',
      'modules/investments/proxy-lambda/pom.xml',
    ]);
    expect(resolveAsset('acme-savings-model', idx, null)).toBeNull();
    const declared = new Map([['acme-savings-model', 'modules/model']]);
    expect(resolveAsset('acme-savings-model', idx, declared)).toEqual({
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

  // Branch-named assets, a live organization’s convention: assets are called `main` or
  // `develop`, so the asset name says nothing about the code layout. Measured
  // live 2026-08-31: 30/30 assets of a maven pilot false-matched `src/main`.
  it('a name match without manifests does not beat later rungs — `main` must not land on src/main', () => {
    const idx = indexTree(['pom.xml', 'svc/pom.xml', 'svc/src/main/java/App.java']);
    // Multi-module maven: L4 (exactly one manifest) never fires, and `main`
    // L1-matches `svc/src/main`. The manifest guard drops that and the root
    // rung takes it — the root pom IS the project.
    expect(resolveAsset('main', idx, null)).toEqual({ level: 'ROOT', dir: '' });
  });

  it('A1: the APPLICATION name resolves a monorepo when the asset name is a branch', () => {
    const idx = indexTree([
      'apps/acme-api/package.json',
      'apps/acme-jobs/package.json',
      'docs/readme.md',
    ]);
    expect(resolveAsset('develop', idx, null, 'acme-api')).toEqual({
      level: 'A1',
      dir: 'apps/acme-api',
    });
    // Normalized form of the app name works too.
    expect(resolveAsset('develop', idx, null, 'acme-jobs-service')).toEqual({
      level: 'A3',
      dir: 'apps/acme-jobs',
    });
  });

  it('asset-name rungs still beat app-name rungs when both carry manifests', () => {
    const idx = indexTree(['apps/worker/package.json', 'apps/api/package.json']);
    expect(resolveAsset('worker', idx, null, 'api')).toEqual({ level: 'L1', dir: 'apps/worker' });
  });

  it('keeps the manifestless L1 hit as a LAST resort so no_manifest stays honest', () => {
    // A repo that is genuinely just a Dockerfile: the matched directory has no
    // manifest and no other rung can fire — the old hit survives so the record
    // says no_manifest AT that path instead of unresolved.
    const idx = indexTree(['lambdas/get-toggles-aws-lambda/Dockerfile']);
    expect(resolveAsset('get-toggles-aws-lambda', idx, null)).toEqual({
      level: 'L1',
      dir: 'lambdas/get-toggles-aws-lambda',
    });
  });

  it('ROOT never fires when the root holds no manifest', () => {
    const idx = indexTree(['a/go.mod', 'b/go.mod', 'README.md']);
    expect(resolveAsset('main', idx, null)).toBeNull();
  });
});

describe('scanBuild parses a .NET monorepo end to end', () => {
  it('branch-named asset + PascalCase module resolves via the app name and parses the csproj', async () => {
    const CSPROJ = `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>
      <PackageReference Include="Serilog" Version="3.1.1" />
      <ProjectReference Include="..\\Acme.Domain\\Acme.Domain.csproj" />
    </ItemGroup></Project>`;
    const gh = fakeGh({
      'Acme.Api/Acme.Api.csproj': CSPROJ,
      'Acme.Domain/Acme.Domain.csproj': '<Project></Project>',
    });
    const [row] = await scanBuild(
      {
        app_id: 1,
        app_name: 'acme-api',
        repository_url: 'https://github.com/acme/repo',
        build_id: 10,
        commit: 'abc123',
        assets: [{ id: 100, name: 'develop', type: 'docker-image' }],
      },
      gh,
      { internalPatterns: INTERNAL, now: NOW },
    );
    expect(row.data.status).toBe('ok');
    expect(row.data.match_level).toBe('A3');
    expect(row.data.primary_language).toBe('dotnet');
    expect(row.data.libraries.map((d: { name: string }) => d.name)).toContain('Serilog');
    expect(row.data.libraries.find((d: { name: string }) => d.name === 'Acme.Domain')).toMatchObject(
      { local: true },
    );
  });
});

describe('scanBuild resolves branch-named assets through the application', () => {
  const POM_ROOT = `<project><groupId>g</groupId><artifactId>root</artifactId>
<dependencies><dependency><groupId>org.x</groupId><artifactId>lib</artifactId><version>1.0</version></dependency></dependencies></project>`;
  const POM_SVC = `<project><artifactId>svc</artifactId>
<dependencies><dependency><groupId>org.y</groupId><artifactId>other</artifactId><version>2.0</version></dependency></dependencies></project>`;

  it('an asset named `main` in a multi-module maven repo scans the whole project from the root', async () => {
    const gh = {
      tree: async () => ['pom.xml', 'svc/pom.xml', 'svc/src/main/java/App.java'],
      blobs: async (_o: string, _r: string, _ref: string, paths: string[]) =>
        Object.fromEntries(
          paths.map((p) => [p, p === 'pom.xml' ? POM_ROOT : POM_SVC]).filter(([p]) => p !== 'svc/src/main/java/App.java'),
        ),
    };
    const [row] = await scanBuild(
      {
        app_id: 1,
        app_name: 'compensation-management',
        repository_url: 'https://github.com/acme/repo',
        build_id: 10,
        commit: 'abc123',
        assets: [{ id: 100, name: 'main', type: 'docker-image' }],
      },
      gh,
      { internalPatterns: INTERNAL, now: NOW },
    );
    expect(row.data.status).toBe('ok');
    expect(row.data.match_level).toBe('ROOT');
    expect(row.data.repository_path).toBe('');
    const names = row.data.libraries.map((d: { name: string }) => d.name);
    expect(names).toContain('org.x:lib');
    expect(names).toContain('org.y:other');
  });
});

describe('manifestsUnder', () => {
  it('collects every manifest in the subtree, not just the top one', () => {
    // acme/acme-scoreboard: one container asset, three manifests.
    const idx = indexTree([
      'containers/scoreboard-aws-uks/frontend/package.json',
      'containers/scoreboard-aws-uks/scanner/requirements.txt',
      'containers/scoreboard-aws-uks/social_scrapers/requirements.txt',
    ]);
    expect(manifestsUnder(idx, 'containers/scoreboard-aws-uks')).toHaveLength(3);
  });
});

describe('parseCsproj', () => {
  const CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
    <PackageReference Include="Serilog">
      <Version>3.1.1</Version>
    </PackageReference>
    <PackageReference Include="Central.Managed" />
    <!--<PackageReference Include="Commented.Out" Version="9.9" />-->
    <ProjectReference Include="..\\Acme.Domain\\Acme.Domain.csproj" />
  </ItemGroup>
</Project>`;

  it('reads PackageReference with Version as attribute or child element', () => {
    const deps = parseCsproj(CSPROJ);
    expect(deps.find((d: { name: string }) => d.name === 'Newtonsoft.Json')).toMatchObject({
      version: '13.0.3',
      direct: true,
      ecosystem: 'dotnet',
      local: false,
    });
    expect(deps.find((d: { name: string }) => d.name === 'Serilog')).toMatchObject({
      version: '3.1.1',
    });
  });

  it('keeps a version-less reference (central package management) with an empty version', () => {
    // The version lives in Directory.Packages.props, which is not a detected
    // manifest — an empty version is the honest declared state.
    expect(parseCsproj(CSPROJ).find((d: { name: string }) => d.name === 'Central.Managed')).toMatchObject(
      { version: '' },
    );
  });

  it('flags a ProjectReference as local in-repo code, named by its project file', () => {
    expect(parseCsproj(CSPROJ).find((d: { name: string }) => d.name === 'Acme.Domain')).toMatchObject(
      { local: true },
    );
  });

  it('does not inventory a commented-out reference', () => {
    expect(parseCsproj(CSPROJ).find((d: { name: string }) => d.name === 'Commented.Out')).toBeUndefined();
  });

  it('reads TargetFramework and Sdk as manifest config', () => {
    expect(csprojConfig(CSPROJ)).toMatchObject({
      target_framework: 'net8.0',
      sdk: 'Microsoft.NET.Sdk',
    });
  });
});

describe('dot-normalized resolution (.NET module naming)', () => {
  it('A3: app `acme-api` finds the `Acme.Api` directory', () => {
    // .NET monorepos name modules `Acme.Api` while the NP application is
    // `acme-api` — measured live 2026-09-01: 110 unresolved assets in one
    // repo for exactly this mismatch.
    const idx = indexTree(['Acme.Api/Acme.Api.csproj', 'Acme.Domain/Acme.Domain.csproj']);
    expect(resolveAsset('develop', idx, null, 'acme-api')).toEqual({
      level: 'A3',
      dir: 'Acme.Api',
    });
  });

  it('A3 via squash: app `acme-api` finds the `AcmeApi` directory (no separators at all)', () => {
    // The live layout that dots-into-dashes did NOT cover: PascalCase
    // CONCATENATED module dirs (AcmeApi, AcmeJobs) — 110 assets stayed
    // unresolved after the first fix (2026-09-01). Squashing every separator
    // out of both sides is what finally makes the spellings meet.
    const idx = indexTree(['AcmeApi/AcmeApi.csproj', 'AcmeJobs/AcmeJobs.csproj']);
    expect(resolveAsset('develop', idx, null, 'acme-api')).toEqual({
      level: 'A3',
      dir: 'AcmeApi',
    });
  });

  it('normalizeName folds dots into dashes so both spellings meet', () => {
    // Both land on 'acme' — the dot becomes a dash and '-api' is one of the
    // stripped suffixes. What matters is that the two spellings CONVERGE.
    expect(normalizeName('Acme.Api')).toBe(normalizeName('acme-api'));
  });
});

describe('scanBuild', () => {
  const GO_MOD = `module x
require (
\tgithub.com/acme/goala/ulog v1.1.3
)
require (
\tgithub.com/acme/goala/uenv v1.1.0 // indirect
\tgithub.com/aws/aws-sdk-go-v2 v1.41.5 // indirect
)`;

  it('keeps direct deps and transitive INTERNAL ones, drops transitive external', async () => {
    const gh = fakeGh({ 'lambdas/go/get-toggles-aws-lambda/go.mod': GO_MOD });
    const [row] = await scanBuild(build(), gh, { internalPatterns: INTERNAL, now: NOW });

    expect(row.data.status).toBe('ok');
    expect(row.data.libraries.map((d: { name: string }) => d.name)).toEqual([
      'github.com/acme/goala/ulog',
      'github.com/acme/goala/uenv',
    ]);
    // The AWS SDK is transitive and external: counted, deliberately not stored.
    expect(row.data.transitive_external_dropped).toBe(1);
    expect(row.data.total_count).toBe(2);
    expect(row.data.direct_count).toBe(1);
    expect(row.data.internal_count).toBe(2);
  });

  it('stamps the catalog-entity identity on every record: id, nrn, build_id, release_id', async () => {
    const gh = fakeGh({ 'lambdas/go/get-toggles-aws-lambda/go.mod': GO_MOD });
    const [row] = await scanBuild(
      build({
        release_id: 55,
        assets: [
          {
            id: 100,
            name: 'get-toggles-aws-lambda',
            type: 'lambda',
            nrn: 'organization=1:build=10:asset=100',
          },
        ],
      }),
      gh,
      { internalPatterns: INTERNAL, now: NOW },
    );
    // The document IS the entity: `id` is the asset id (the upsert key) and the
    // rest is provenance. All strings — the spec declares them so.
    expect(row.data.id).toBe('100');
    expect(row.data.nrn).toBe('organization=1:build=10:asset=100');
    expect(row.data.build_id).toBe('10');
    expect(row.data.release_id).toBe('55');
    // Not on the spec: the application's repository lives on the application
    // entity. An undeclared property would reject the ENTIRE document
    // (`additionalProperties: false`), so its absence here is load-bearing.
    expect('repository_url' in row.data).toBe(false);
  });

  it('omits nrn when the caller does not carry it, and nulls release_id on the backfill path', async () => {
    const gh = fakeGh({ 'lambdas/go/get-toggles-aws-lambda/go.mod': GO_MOD });
    const [row] = await scanBuild(build(), gh, { internalPatterns: INTERNAL, now: NOW });
    expect('nrn' in row.data).toBe(false);
    expect(row.data.release_id).toBeNull();
    expect(row.data.id).toBe('100');
  });

  it('stamps the identity on unscannable records too — repo_missing is still an entity', async () => {
    const [row] = await scanBuild(build({ repository_url: '' }), fakeGh({}), {
      internalPatterns: INTERNAL,
      now: NOW,
    });
    expect(row.data.status).toBe('repo_missing');
    expect(row.data.id).toBe('100');
    expect(row.data.build_id).toBe('10');
  });

  it('stores the whole SBOM when keepTransitiveExternal is set', async () => {
    const gh = fakeGh({ 'lambdas/go/get-toggles-aws-lambda/go.mod': GO_MOD });
    const [row] = await scanBuild(build(), gh, {
      internalPatterns: INTERNAL,
      now: NOW,
      keepTransitiveExternal: true,
    });
    expect(row.data.libraries).toHaveLength(3);
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
    // Gradle is DETECTED and not parsed — the record says so rather than
    // reporting an empty dependency list as if the asset had none.
    const gh = fakeGh({
      'lambdas/go/get-toggles-aws-lambda/build.gradle': 'plugins { id "java" }',
    });
    const [row] = await scanBuild(build(), gh, { internalPatterns: INTERNAL, now: NOW });
    expect(row.data.status).toBe('lang_unsupported');
    expect(row.data.languages).toEqual(['java-gradle']);
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
      build({
        assets: [
          { id: 1, name: 'a' },
          { id: 2, name: 'b' },
        ],
      }),
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
      'lambdas/go/get-toggles-aws-lambda/gradle/build.gradle': 'plugins { id "java" }',
    });
    const [row] = await scanBuild(build(), gh, { internalPatterns: INTERNAL, now: NOW });
    expect(row.data.status).toBe('ok');
    expect(row.data.status_detail).toContain('java-gradle');
  });

  it('parses every enabled ecosystem an asset carries, not just the first', async () => {
    // An asset whose subtree holds both a go.mod and a package.json is the
    // ordinary shape of a service with a bundled UI. Both are recorded, and
    // `languages` says so — nothing is silently dropped for being second.
    const gh = fakeGh({
      'lambdas/go/get-toggles-aws-lambda/go.mod': GO_MOD,
      'lambdas/go/get-toggles-aws-lambda/ui/package.json': JSON.stringify({
        dependencies: { '@acme/ui': '^2.0.0', react: '^18.0.0' },
      }),
    });
    const [row] = await scanBuild(build(), gh, {
      internalPatterns: compileInternalPatterns(['^github\\.com/acme/', '^@acme/']),
      now: NOW,
    });

    expect(row.data.status).toBe('ok');
    expect(row.data.languages.sort()).toEqual(['go', 'node']);
    const names = row.data.libraries.map((d: { name: string }) => d.name);
    expect(names).toContain('github.com/acme/goala/ulog');
    expect(names).toContain('@acme/ui');
    expect(names).toContain('react');
    // An npm scope is an internal marker the GitHub-owner pattern cannot see —
    // that is why `LIB_INTERNAL_PATTERNS` is a list, not one regex.
    expect(
      row.data.libraries.find((d: { name: string }) => d.name === '@acme/ui'),
    ).toMatchObject({ internal: true });
  });
});

describe('mergeParsed', () => {
  it('keeps BOTH ecosystems for an asset that has manifests from each', () => {
    // The pipeline runs one parse step per ecosystem and merges their outputs.
    // A shallow `Object.assign` looked right and silently kept only whichever
    // step ran last — invisible in the record, because `languages` still listed
    // both and it read as a complete scan missing half its data.
    const merged = mergeParsed([
      {
        '100': {
          dependencies: [{ name: 'github.com/acme/goala/ulog', ecosystem: 'go' }],
          transitive_external_dropped: 3,
          config: { 'go.go': '1.22' },
        },
      },
      {
        '100': {
          dependencies: [{ name: 'react', ecosystem: 'node' }],
          transitive_external_dropped: 1,
          config: { 'node.engines.node': '>=20' },
        },
      },
    ]);

    expect(merged['100'].dependencies.map((d: { name: string }) => d.name)).toEqual([
      'github.com/acme/goala/ulog',
      'react',
    ]);
    expect(merged['100'].transitive_external_dropped).toBe(4);
    expect(merged['100'].config).toEqual({ 'go.go': '1.22', 'node.engines.node': '>=20' });
  });
});

describe('manifest self-declaration (manifest_config)', () => {
  it('records the runtime a package.json declares, which no dependency array can', async () => {
    // "Which assets still declare node 16" is the node equivalent of a lambda
    // runtime deprecation sweep, and it lives in `engines`, not in `dependencies`.
    const gh = fakeGh({
      'lambdas/go/get-toggles-aws-lambda/package.json': JSON.stringify({
        name: 'toggles-ui',
        version: '2.1.0',
        type: 'module',
        packageManager: 'pnpm@9.0.0',
        engines: { node: '>=20.11' },
        dependencies: { react: '^18.0.0' },
      }),
    });
    const [row] = await scanBuild(build(), gh, { internalPatterns: INTERNAL, now: NOW });
    expect(row.data.manifest_config).toMatchObject({
      'node.name': 'toggles-ui',
      'node.version': '2.1.0',
      'node.type': 'module',
      'node.packageManager': 'pnpm@9.0.0',
      'node.engines.node': '>=20.11',
    });
  });

  it('records the go directive and toolchain', async () => {
    const gh = fakeGh({
      'lambdas/go/get-toggles-aws-lambda/go.mod': 'module x\ngo 1.22.3\ntoolchain go1.22.5\n',
    });
    const [row] = await scanBuild(build(), gh, { internalPatterns: INTERNAL, now: NOW });
    expect(row.data.manifest_config).toEqual({ 'go.go': '1.22.3', 'go.toolchain': 'go1.22.5' });
  });
});

describe('compileInternalPatterns', () => {
  it('accepts the JSON string a config entry delivers', () => {
    const [re] = compileInternalPatterns('["^github\\\\.com/acme/"]');
    expect(re.test('github.com/acme/goala/ulog')).toBe(true);
    expect(re.test('github.com/aws/aws-sdk-go-v2')).toBe(false);
  });

  it('returns no patterns for an empty entry instead of throwing', () => {
    expect(compileInternalPatterns('')).toEqual([]);
    expect(compileInternalPatterns(undefined)).toEqual([]);
  });
});
