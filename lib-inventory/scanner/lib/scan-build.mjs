import { SUPPORTED_ECOSYSTEMS, normalizeName, parseRepoUrl } from './manifests.mjs';
import { payload } from './payload.mjs';
import { CONFIG_READERS, PARSERS } from './registry.mjs';
import { declaredName, indexTree, manifestsUnder, resolveAsset } from './resolve.mjs';

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
  const base = {
    repository_url: build.repository_url || null,
    commit: build.commit || null,
    scanned_at: now,
  };

  const fail = (status, detail) =>
    assets.map((a) => ({
      asset_id: a.id,
      asset_name: a.name,
      build_id: build.build_id,
      app_id: build.app_id,
      data: payload({ ...base, status, status_detail: detail }),
    }));

  const repo = parseRepoUrl(build.repository_url);
  if (!repo) {
    return fail(
      'repo_missing',
      build.repository_url
        ? `repository_url is not a GitHub URL: ${build.repository_url}`
        : 'application has no repository_url configured',
    );
  }

  let paths;
  try {
    paths = await gh.tree(repo.owner, repo.repo, build.commit);
  } catch (err) {
    return fail(
      'repo_unreachable',
      `could not read ${repo.owner}/${repo.repo}@${build.commit}: ${err.message}`,
    );
  }

  const idx = indexTree(paths);

  // L1/L3/L4 first; only build the (expensive) L2 index if something needs it.
  const first = assets.map((a) => ({ asset: a, hit: resolveAsset(a.name, idx, null) }));
  let declaredIndex = null;
  if (first.some((r) => !r.hit)) {
    declaredIndex = new Map();
    const named = [...idx.manifests].filter(([, eco]) =>
      ['java-maven', 'node', 'go'].includes(eco),
    );
    if (named.length) {
      const texts = await gh.blobs(
        repo.owner,
        repo.repo,
        build.commit,
        named.map(([p]) => p),
      );
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
      return fail(
        'repo_unreachable',
        `could not read manifests from ${repo.owner}/${repo.repo}: ${err.message}`,
      );
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
    // Transitive *internal* ones are kept regardless: `goala/uenv` arrives
    // indirectly on 292 assets and `goala/utel` v1 on 58, and those are exactly
    // the migrations we are here to see. The `direct` flag survives on every
    // row so the dashboard can still separate "you declared this" from "this
    // reached you through something else" — only the first is a bump the owning
    // team can make on its own.
    const keepAll = opts.keepTransitiveExternal === true;
    const seen = new Set();
    const dependencies = [];
    const manifestConfig = {};
    let dropped = 0;
    for (const m of parseable) {
      const text = texts[m.path];
      if (text == null) continue;
      const readConfig = CONFIG_READERS[m.ecosystem];
      if (readConfig) {
        for (const [k, v] of Object.entries(readConfig(text, m.path, texts))) {
          manifestConfig[`${m.ecosystem}.${k}`] = v;
        }
      }
      for (const d of PARSERS[m.ecosystem](text, m.path, texts)) {
        const key = `${d.ecosystem} ${d.name} ${d.version}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const internal = isInternal(d.name);
        if (!keepAll && !d.direct && !internal && !d.local) {
          dropped += 1;
          continue;
        }
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
      manifest_config: manifestConfig,
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
