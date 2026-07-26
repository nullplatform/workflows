/**
 * STEP `resolve_assets` — each asset to a repository subtree. No network.
 *
 * The ladder: exact directory basename, then the name declared inside a
 * manifest, then a normalized basename, then a single-manifest repo. This is
 * the domain core of the workflow and the reason no AI is involved.
 */
const resolutions = resolveAssetsForPlans(inputs.plans || [], inputs.manifestResults || []);
const levels = {};
for (const r of resolutions) {
  for (const a of r.assets) {
    const k = a.hit ? a.hit.level : 'unresolved';
    levels[k] = (levels[k] || 0) + 1;
  }
}
log.info('asset resolution', levels);
return { resolutions, levels };
