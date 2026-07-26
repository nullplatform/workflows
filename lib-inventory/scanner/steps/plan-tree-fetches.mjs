/**
 * STEP `plan_tree_fetches` — lake rows → GitHub tree requests. No network.
 *
 * The request carries only a `url`. The credential stays in the http-request
 * step's own config as `${{ secrets.GITHUB_TOKEN }}`, so it never passes
 * through a code-exec output and never lands in the execution state.
 */
const builds = (inputs.rows || []).map((r) => ({
  app_id: r.app_id,
  app_name: r.app_name,
  repository_url: r.repository_url,
  build_id: r.build_id,
  commit: r.commit,
  assets: (typeof r.assets_json === 'string' ? JSON.parse(r.assets_json) : r.assets_json || []).map(
    (a) => (Array.isArray(a) ? { id: a[0], name: a[1], type: a[2] } : a),
  ),
}));

const { requests, plans, unscannable } = planTreeFetches(builds);
log.info(`planned ${requests.length} tree fetches`, { unscannable: unscannable.length });
return { requests, plans, unscannable };
