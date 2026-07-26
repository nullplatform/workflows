/**
 * Library inventory scanner.
 *
 * Resolves each NP asset to a subtree of its application's repository (at the
 * exact commit the build was made from), extracts the dependency manifests
 * found there, and emits one `dependencies` metadata payload per asset.
 *
 * This file is the source of truth for the scanning logic. It is inlined into
 * the `scan` step of `wf-l1-backfill.yaml` — keep the two in sync (there is no
 * include mechanism for `code-exec`; see `scripts/sync-scanner.mjs`).
 *
 * Design doc: docs/superpowers/specs/2026-07-25-library-inventory-design.md
 *
 * Contract: pure except for the injected `gh` transport, so the same code runs
 * under `code-exec` (sandboxed, egress locked to api.github.com) and locally
 * against the real API in tests.
 */

export const SCANNER_VERSION = 'lib-inventory/1.0.0';

/** Manifest filename -> ecosystem. */
export const MANIFEST_LANGS = {
  'go.mod': 'go',
  'package.json': 'node',
  'pom.xml': 'java-maven',
  'build.gradle': 'java-gradle',
  'build.gradle.kts': 'java-gradle',
  'requirements.txt': 'python',
  'pyproject.toml': 'python',
  Pipfile: 'python',
  Gemfile: 'ruby',
  'Cargo.toml': 'rust',
  'composer.json': 'php',
  'pubspec.yaml': 'dart',
};

/**
 * Asset-name suffixes that describe the deployment shape rather than the code,
 * stripped before the L3 normalized comparison.
 */
const NAME_SUFFIXES = [
  '-aws-lambda', '-aws-uks', '-lambda', '-service', '-local',
  '-docker-image', '-image', '-asset', '-app', '-api',
];

/** Ecosystems we can currently parse. Everything else is reported, not parsed. */
export const SUPPORTED_ECOSYSTEMS = new Set(['go']);

export function manifestLang(basename) {
  if (MANIFEST_LANGS[basename]) return MANIFEST_LANGS[basename];
  if (basename.endsWith('.csproj')) return 'dotnet';
  return null;
}

export function normalizeName(name) {
  let s = String(name).toLowerCase();
  for (let changed = true; changed; ) {
    changed = false;
    for (const suf of NAME_SUFFIXES) {
      if (s.endsWith(suf)) {
        s = s.slice(0, -suf.length);
        changed = true;
      }
    }
  }
  return s.replace(/[^a-z0-9]/g, '');
}

/** `https://github.com/acme/x(.git)` -> `{owner, repo}`; null when not GitHub. */
export function parseRepoUrl(url) {
  const m = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(url || ''));
  return m ? { owner: m[1], repo: m[2] } : null;
}

// ---------------------------------------------------------------- parsers ---

/**
 * Parse a `go.mod`. Returns direct and indirect requirements with the exact
 * version Go resolved — no `go.sum`, toolchain or module download needed.
 *
 * Modules redirected by a `replace` to a filesystem path are in-repo code, not
 * consumed libraries — they carry a placeholder version
 * (`v0.0.0-00010101000000-000000000000`) and would otherwise pollute the
 * inventory. They are kept, flagged `local: true`, and excluded from the
 * counts, so "which module does this asset share code with" stays answerable.
 */
export function parseGoMod(text) {
  const lines = String(text).split('\n');

  const localModules = new Set();
  let inReplace = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    if (/^replace\s*\($/.test(line)) { inReplace = true; continue; }
    if (inReplace && line === ')') { inReplace = false; continue; }

    let body = null;
    if (inReplace) body = line;
    else if (line.startsWith('replace ')) body = line.slice('replace '.length).trim();
    if (!body) continue;

    const m = /^(\S+)(?:\s+v\S+)?\s*=>\s*(\S+)/.exec(body);
    if (m && /^(\.{1,2}\/|\/)/.test(m[2])) localModules.add(m[1]);
  }

  const deps = [];
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    if (/^require\s*\($/.test(line)) { inBlock = true; continue; }
    if (inBlock && line === ')') { inBlock = false; continue; }

    let body = null;
    if (inBlock) body = line;
    else if (line.startsWith('require ')) body = line.slice('require '.length).trim();
    if (!body) continue;

    const m = /^(\S+)\s+(v\S+)(\s*\/\/\s*indirect)?/.exec(body);
    if (!m) continue;
    deps.push({
      name: m[1],
      version: m[2],
      direct: !m[3],
      ecosystem: 'go',
      local: localModules.has(m[1]),
    });
  }
  return deps;
}

const PARSERS = { go: parseGoMod };

// -------------------------------------------------------------- resolution ---

/**
 * Build the lookup structures a repo tree needs to answer "which subtree is
 * this asset?".
 */
export function indexTree(paths) {
  const manifests = new Map(); // path -> ecosystem
  const dirs = new Set(['']);
  for (const p of paths) {
    const slash = p.lastIndexOf('/');
    if (slash >= 0) {
      // register every ancestor directory
      let d = p.slice(0, slash);
      while (d) {
        dirs.add(d);
        const i = d.lastIndexOf('/');
        d = i < 0 ? '' : d.slice(0, i);
      }
    }
    const lang = manifestLang(slash >= 0 ? p.slice(slash + 1) : p);
    if (lang) manifests.set(p, lang);
  }

  const manifestDirs = new Set([...manifests.keys()].map((p) => {
    const i = p.lastIndexOf('/');
    return i < 0 ? '' : p.slice(0, i);
  }));

  const hasManifestUnder = (dir) => {
    if (!dir) return manifests.size > 0;
    const prefix = `${dir}/`;
    for (const p of manifests.keys()) if (p.startsWith(prefix)) return true;
    return false;
  };

  // basename -> candidate dirs, best first.
  // TIE-BREAK: a directory that actually contains a manifest wins; among those
  // the shallowest wins. Without this, `migrations` matches
  // `migrations/src/main/resources/db/migrations` instead of `migrations/`.
  const rank = (a, b) => {
    const ma = hasManifestUnder(a), mb = hasManifestUnder(b);
    if (ma !== mb) return ma ? -1 : 1;
    const da = a.split('/').length, db = b.split('/').length;
    if (da !== db) return da - db;
    return a.length - b.length;
  };
  const byBase = new Map();
  const byNorm = new Map();
  for (const d of dirs) {
    if (!d) continue;
    const base = d.slice(d.lastIndexOf('/') + 1);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(d);
    const n = normalizeName(base);
    if (!byNorm.has(n)) byNorm.set(n, []);
    byNorm.get(n).push(d);
  }
  for (const list of byBase.values()) list.sort(rank);
  for (const list of byNorm.values()) list.sort(rank);

  return { manifests, manifestDirs, byBase, byNorm, hasManifestUnder };
}

/**
 * Module name declared *inside* a manifest, for the L2 rung. Maven's
 * `<artifactId>` is the case that matters: an artifact named `<project>-model`
 * lives in `modules/model/`, so the directory name never matches.
 */
export function declaredName(ecosystem, text) {
  try {
    if (ecosystem === 'java-maven') {
      const body = String(text).replace(/<parent>[\s\S]*?<\/parent>/g, '');
      const m = /<artifactId>\s*([^<]+?)\s*<\/artifactId>/.exec(body);
      return m ? m[1] : null;
    }
    if (ecosystem === 'node') {
      const n = JSON.parse(text).name;
      return typeof n === 'string' ? n : null;
    }
    if (ecosystem === 'go') {
      const m = /^module\s+(\S+)/m.exec(String(text));
      return m ? m[1].split('/').pop() : null;
    }
  } catch {
    /* a malformed manifest simply does not contribute an L2 candidate */
  }
  return null;
}

/**
 * Resolve one asset name to a repository subtree.
 * Returns `{ level, dir }`, or null when nothing matched (rung L5).
 */
export function resolveAsset(assetName, idx, declaredIndex) {
  const exact = idx.byBase.get(assetName);
  if (exact && exact.length) return { level: 'L1', dir: exact[0] };

  if (declaredIndex) {
    const d = declaredIndex.get(assetName) || declaredIndex.get(normalizeName(assetName));
    if (d) return { level: 'L2', dir: d };
  }

  const norm = idx.byNorm.get(normalizeName(assetName));
  if (norm && norm.length) return { level: 'L3', dir: norm[0] };

  if (idx.manifestDirs.size === 1) {
    return { level: 'L4', dir: [...idx.manifestDirs][0] };
  }
  return null;
}

/** Manifests living inside (or at) a subtree, nearest first. */
export function manifestsUnder(idx, dir) {
  const prefix = dir ? `${dir}/` : '';
  const out = [];
  for (const [path, ecosystem] of idx.manifests) {
    if (dir === '' || path.startsWith(prefix)) out.push({ path, ecosystem });
  }
  out.sort((a, b) => a.path.split('/').length - b.path.split('/').length
    || a.path.localeCompare(b.path));
  return out;
}

// ------------------------------------------------------------------ scan ---

const EMPTY_COUNTS = {
  total_count: 0, direct_count: 0, internal_count: 0, local_count: 0,
  transitive_external_dropped: 0,
};

function payload(fields) {
  return {
    status: 'ok',
    status_detail: null,
    primary_language: null,
    languages: [],
    repository_url: null,
    repository_path: null,
    commit: null,
    match_level: null,
    manifests: [],
    dependencies: [],
    ...EMPTY_COUNTS,
    scanned_at: fields.scanned_at,
    scanner_version: SCANNER_VERSION,
    ...fields,
  };
}

/**
 * Scan one build.
 *
 * @param {object}   build  `{ app_id, app_name, repository_url, build_id, commit, assets: [{id,name,type}] }`
 * @param {object}   gh     transport: `{ tree(owner,repo,ref), blobs(owner,repo,ref,paths) }`
 * @param {object}   opts   `{ internalPatterns: RegExp[], now: string, maxManifestsPerAsset?: number }`
 * @returns {Promise<Array<{asset_id:number, asset_name:string, build_id:number, app_id:number, data:object}>>}
 */
export async function scanBuild(build, gh, opts) {
  const now = opts.now;
  const assets = build.assets || [];
  const base = { repository_url: build.repository_url || null, commit: build.commit || null, scanned_at: now };

  const fail = (status, detail) => assets.map((a) => ({
    asset_id: a.id,
    asset_name: a.name,
    build_id: build.build_id,
    app_id: build.app_id,
    data: payload({ ...base, status, status_detail: detail }),
  }));

  const repo = parseRepoUrl(build.repository_url);
  if (!repo) {
    return fail('repo_missing', build.repository_url
      ? `repository_url is not a GitHub URL: ${build.repository_url}`
      : 'application has no repository_url configured');
  }

  let paths;
  try {
    paths = await gh.tree(repo.owner, repo.repo, build.commit);
  } catch (err) {
    return fail('repo_unreachable', `could not read ${repo.owner}/${repo.repo}@${build.commit}: ${err.message}`);
  }

  const idx = indexTree(paths);

  // L1/L3/L4 first; only build the (expensive) L2 index if something needs it.
  const first = assets.map((a) => ({ asset: a, hit: resolveAsset(a.name, idx, null) }));
  let declaredIndex = null;
  if (first.some((r) => !r.hit)) {
    declaredIndex = new Map();
    const named = [...idx.manifests].filter(([, eco]) => ['java-maven', 'node', 'go'].includes(eco));
    if (named.length) {
      const texts = await gh.blobs(repo.owner, repo.repo, build.commit, named.map(([p]) => p));
      for (const [path, ecosystem] of named) {
        const n = declaredName(ecosystem, texts[path] || '');
        if (!n) continue;
        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        if (!declaredIndex.has(n)) declaredIndex.set(n, dir);
        const nn = normalizeName(n);
        if (!declaredIndex.has(nn)) declaredIndex.set(nn, dir);
      }
    }
    for (const r of first) if (!r.hit) r.hit = resolveAsset(r.asset.name, idx, declaredIndex);
  }

  // Collect every manifest we must read, across all assets, then fetch once.
  const cap = opts.maxManifestsPerAsset ?? 8;
  const perAsset = new Map();
  const wanted = new Set();
  for (const { asset, hit } of first) {
    if (!hit) continue;
    const found = manifestsUnder(idx, hit.dir).slice(0, cap);
    perAsset.set(asset.id, found);
    for (const m of found) if (SUPPORTED_ECOSYSTEMS.has(m.ecosystem)) wanted.add(m.path);
  }
  let texts = {};
  if (wanted.size) {
    try {
      texts = await gh.blobs(repo.owner, repo.repo, build.commit, [...wanted]);
    } catch (err) {
      return fail('repo_unreachable', `could not read manifests from ${repo.owner}/${repo.repo}: ${err.message}`);
    }
  }

  const isInternal = (name) => opts.internalPatterns.some((re) => re.test(name));

  return first.map(({ asset, hit }) => {
    const row = {
      asset_id: asset.id,
      asset_name: asset.name,
      build_id: build.build_id,
      app_id: build.app_id,
    };
    if (!hit) {
      row.data = payload({
        ...base,
        status: 'unresolved',
        status_detail: `no directory in ${repo.owner}/${repo.repo} matches asset name "${asset.name}"`,
      });
      return row;
    }

    const found = perAsset.get(asset.id) || [];
    const languages = [...new Set(found.map((m) => m.ecosystem))].sort();
    const common = {
      ...base,
      repository_path: hit.dir,
      match_level: hit.level,
      languages,
      primary_language: languages[0] ?? null,
      manifests: found.map((m) => ({ path: m.path, language: m.ecosystem })),
    };

    if (!found.length) {
      row.data = payload({
        ...common,
        status: 'no_manifest',
        status_detail: `resolved to "${hit.dir}" (${hit.level}) but it contains no dependency manifest`,
      });
      return row;
    }

    const parseable = found.filter((m) => SUPPORTED_ECOSYSTEMS.has(m.ecosystem));
    if (!parseable.length) {
      row.data = payload({
        ...common,
        status: 'lang_unsupported',
        status_detail: `manifests found (${languages.join(', ')}) but no parser is enabled for them yet`,
      });
      return row;
    }

    // What we keep, and why this is an INVENTORY and not an SBOM: transitive
    // *external* dependencies are 87% of the volume and nobody configured them
    // — they are whatever the module graph resolved. Dropping them takes the
    // payload from ~12 KB to ~2 KB per asset.
    // Transitive *internal* ones are kept regardless: an internal package
    // arrived indirectly on 292 assets, and 58 were still on another's v1 line —
    // exactly the migrations we are here to see. The `direct` flag survives on every
    // row so the dashboard can still separate "you declared this" from "this
    // reached you through something else" — only the first is a bump the owning
    // team can make on its own.
    const keepAll = opts.keepTransitiveExternal === true;
    const seen = new Set();
    const dependencies = [];
    let dropped = 0;
    for (const m of parseable) {
      const text = texts[m.path];
      if (text == null) continue;
      for (const d of PARSERS[m.ecosystem](text)) {
        const key = `${d.ecosystem} ${d.name} ${d.version}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const internal = isInternal(d.name);
        if (!keepAll && !d.direct && !internal && !d.local) { dropped += 1; continue; }
        dependencies.push({ local: false, ...d, internal });
      }
    }

    // Partial coverage is still `ok`, but say so: a Go+Node container reports
    // only its Go half today and the detail line is how you find out.
    const unparsed = languages.filter((l) => !SUPPORTED_ECOSYSTEMS.has(l));
    row.data = payload({
      ...common,
      status: 'ok',
      status_detail: unparsed.length ? `not parsed yet: ${unparsed.join(', ')}` : null,
      dependencies,
      // Counts describe consumed libraries; in-repo `replace` targets are code
      // this asset ships, not a library it depends on.
      total_count: dependencies.filter((d) => !d.local).length,
      direct_count: dependencies.filter((d) => d.direct && !d.local).length,
      internal_count: dependencies.filter((d) => d.internal && !d.local).length,
      local_count: dependencies.filter((d) => d.local).length,
      // Not a silent truncation: how much SBOM tail we deliberately did not store.
      transitive_external_dropped: dropped,
    });
    return row;
  });
}

// ------------------------------------------------------------- transport ---

/**
 * GitHub transport over REST (tree) + GraphQL (batched blobs).
 * One tree request plus one GraphQL request per ~60 manifests.
 */
export function makeGitHubTransport(token, fetchImpl = fetch) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'np-lib-inventory',
  };

  async function tree(owner, repo, ref) {
    const refs = [ref, 'main', 'master'].filter(Boolean);
    let lastErr = 'no ref tried';
    for (const r of refs) {
      const res = await fetchImpl(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${r}?recursive=1`,
        { headers },
      );
      if (res.status === 200) {
        const body = await res.json();
        if (body.truncated) {
          throw new Error(`tree for ${owner}/${repo}@${r} is truncated (>100k entries)`);
        }
        return body.tree.filter((n) => n.type === 'blob').map((n) => n.path);
      }
      lastErr = `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) break; // auth problems will not fix themselves
    }
    throw new Error(lastErr);
  }

  async function blobs(owner, repo, ref, paths) {
    const out = {};
    for (let i = 0; i < paths.length; i += 60) {
      const chunk = paths.slice(i, i + 60);
      const aliases = chunk
        .map((p, j) => `    f${j}: object(expression: ${JSON.stringify(`${ref}:${p}`)}) { ... on Blob { text } }`)
        .join('\n');
      const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {\n${aliases}\n} }`;
      const res = await fetchImpl('https://api.github.com/graphql', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      if (res.status !== 200) throw new Error(`graphql HTTP ${res.status}`);
      const body = await res.json();
      if (body.errors?.length) throw new Error(`graphql: ${body.errors[0].message}`);
      const repoNode = body.data?.repository;
      if (!repoNode) throw new Error('graphql: repository not visible to this token');
      chunk.forEach((p, j) => {
        const node = repoNode[`f${j}`];
        if (node && typeof node.text === 'string') out[p] = node.text;
      });
    }
    return out;
  }

  return { tree, blobs };
}

/**
 * Compile the configured internal-library patterns once.
 * Accepts an array or the JSON string a config entry delivers (entries are
 * always strings, so `LIB_INTERNAL_PATTERNS` arrives as `'["^github\\.com/Acme/"]'`).
 */
export function compileInternalPatterns(patterns) {
  let list = patterns;
  if (typeof list === 'string') {
    const raw = list.trim();
    if (!raw) return [];
    try {
      list = JSON.parse(raw);
    } catch {
      // Tolerate a bare comma-separated list so a mis-typed entry still works.
      list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  if (!Array.isArray(list)) return [];
  return list.map((p) => new RegExp(p));
}
