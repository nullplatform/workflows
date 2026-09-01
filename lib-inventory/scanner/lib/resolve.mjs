import { manifestLang, normalizeName, squashName } from './manifests.mjs';

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

  const manifestDirs = new Set(
    [...manifests.keys()].map((p) => {
      const i = p.lastIndexOf('/');
      return i < 0 ? '' : p.slice(0, i);
    }),
  );

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
    const ma = hasManifestUnder(a),
      mb = hasManifestUnder(b);
    if (ma !== mb) return ma ? -1 : 1;
    const da = a.split('/').length,
      db = b.split('/').length;
    if (da !== db) return da - db;
    return a.length - b.length;
  };
  const byBase = new Map();
  const byNorm = new Map();
  const bySquash = new Map();
  for (const d of dirs) {
    if (!d) continue;
    const base = d.slice(d.lastIndexOf('/') + 1);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(d);
    const n = normalizeName(base);
    if (!byNorm.has(n)) byNorm.set(n, []);
    byNorm.get(n).push(d);
    const q = squashName(base);
    if (!bySquash.has(q)) bySquash.set(q, []);
    bySquash.get(q).push(d);
  }
  for (const list of byBase.values()) list.sort(rank);
  for (const list of byNorm.values()) list.sort(rank);
  for (const list of bySquash.values()) list.sort(rank);

  return { manifests, manifestDirs, byBase, byNorm, bySquash, hasManifestUnder };
}

/**
 * Module name declared *inside* a manifest, for the L2 rung. Maven's
 * `<artifactId>` is the case that matters: `acme-savings-model` lives in
 * `modules/model/`, so the directory name never matches.
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
 * Resolve one asset to a repository subtree.
 * Returns `{ level, dir }`, or null when nothing matched (rung L5).
 *
 * Two rules beyond the original name ladder, both forced by organizations
 * that name assets after the BRANCH (`main`, `develop`) rather than the
 * component (measured live 2026-08-31: 30/30 assets of a maven pilot
 * L1-matched `src/main` — every maven repo has one):
 *
 * - A hit only SETTLES if its subtree contains a manifest; otherwise the
 *   later rungs keep trying. The one exception is the very end: if nothing
 *   else fired, a manifestless asset-name hit is returned so the record says
 *   `no_manifest` at that path instead of `unresolved` — that is the honest
 *   status for a directory that really is just a Dockerfile.
 * - The APPLICATION name gets its own rungs (A1 exact / A2 declared /
 *   A3 normalized) after the asset-name ones, and a final ROOT rung resolves
 *   to the repository root when a manifest lives there — the multi-module
 *   maven case, where L4 ("exactly one manifest") can never fire.
 */
export function resolveAsset(assetName, idx, declaredIndex, appName) {
  const settled = (hit) => (hit && idx.hasManifestUnder(hit.dir) ? hit : null);

  const nameRungs = (name, levels) => {
    if (!name) return null;
    const exact = idx.byBase.get(name);
    if (exact && exact.length && idx.hasManifestUnder(exact[0]))
      return { level: levels[0], dir: exact[0] };

    if (declaredIndex) {
      const d = declaredIndex.get(name) || declaredIndex.get(normalizeName(name));
      const hit = d !== undefined ? settled({ level: levels[1], dir: d }) : null;
      if (hit) return hit;
    }

    const norm = idx.byNorm.get(normalizeName(name));
    if (norm && norm.length && idx.hasManifestUnder(norm[0]))
      return { level: levels[2], dir: norm[0] };

    // Same rung, last spelling: every separator removed from both sides.
    // `conto-api` meets `ContoApi` — .NET names module directories in
    // concatenated PascalCase, which no dash/dot rule reaches (110 assets
    // stayed unresolved on the dots-into-dashes fix alone, 2026-09-01).
    const sq = idx.bySquash.get(squashName(name));
    if (sq && sq.length && idx.hasManifestUnder(sq[0])) return { level: levels[2], dir: sq[0] };
    return null;
  };

  const byAsset = nameRungs(assetName, ['L1', 'L2', 'L3']);
  if (byAsset) return byAsset;

  if (appName && appName !== assetName) {
    const byApp = nameRungs(appName, ['A1', 'A2', 'A3']);
    if (byApp) return byApp;
  }

  if (idx.manifestDirs.size === 1) {
    return { level: 'L4', dir: [...idx.manifestDirs][0] };
  }

  if (idx.manifestDirs.has('')) {
    return { level: 'ROOT', dir: '' };
  }

  // Last resort: the manifestless asset-name hit, so `no_manifest` keeps its
  // path. This is the pre-guard L1 behavior, now demoted to the bottom.
  const exact = idx.byBase.get(assetName);
  if (exact && exact.length) return { level: 'L1', dir: exact[0] };

  return null;
}

/** Manifests living inside (or at) a subtree, nearest first. */
export function manifestsUnder(idx, dir) {
  const prefix = dir ? `${dir}/` : '';
  const out = [];
  for (const [path, ecosystem] of idx.manifests) {
    if (dir === '' || path.startsWith(prefix)) out.push({ path, ecosystem });
  }
  out.sort(
    (a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path),
  );
  return out;
}
