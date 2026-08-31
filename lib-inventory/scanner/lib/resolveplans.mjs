import { readBlobResponse } from './blobs.mjs';
import { manifestLang, normalizeName } from './manifests.mjs';
import { declaredName, indexTree, manifestsUnder, resolveAsset } from './resolve.mjs';

/**
 * STEP 3 — resolve every asset to a repository subtree.
 *
 * Pure: no network. The declared-name index (rung L2) is built from the
 * manifest texts fetched in the previous step, so no extra round trip.
 */
export function resolveAssetsForPlans(plans, manifestResults) {
  return plans.map((plan, i) => {
    const texts = readBlobResponse(plan.manifests, manifestResults?.[i]);
    const idx = indexTree(plan.files);

    const declaredIndex = new Map();
    for (const path of plan.manifests) {
      const ecosystem = manifestLang(path.slice(path.lastIndexOf('/') + 1));
      if (!['java-maven', 'node', 'go'].includes(ecosystem)) continue;
      const n = declaredName(ecosystem, texts[path] || '');
      if (!n) continue;
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      if (!declaredIndex.has(n)) declaredIndex.set(n, dir);
      const nn = normalizeName(n);
      if (!declaredIndex.has(nn)) declaredIndex.set(nn, dir);
    }

    const assets = (plan.assets || []).map((a) => {
      const hit = resolveAsset(a.name, idx, declaredIndex);
      if (!hit)
        return {
          asset_id: a.id,
          asset_name: a.name,
          asset_nrn: a.nrn,
          exists: a.exists === true,
          hit: null,
          manifests: [],
        };
      return {
        asset_id: a.id,
        asset_name: a.name,
        asset_nrn: a.nrn,
        exists: a.exists === true,
        hit,
        manifests: manifestsUnder(idx, hit.dir).slice(0, 8),
      };
    });

    return { plan, texts, assets };
  });
}
