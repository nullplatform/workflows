/**
 * `code-exec` body for the `scan` step of wf-l1-backfill.
 *
 * Appended after scanner.mjs (with its `export` keywords stripped) by
 * `scripts/build-workflow.mjs`. Everything dynamic arrives via `inputs`;
 * expressions are NOT interpolated into a code-exec body.
 *
 * inputs:
 *   builds            [{app_id, app_name, repository_url, build_id, commit, assets_json}]
 *   githubToken       PAT with read access to the applications' repositories
 *   internalPatterns  regex sources marking a dependency as internal
 *   concurrency       builds scanned in parallel (default 6)
 *   keepTransitiveExternal  set true to store the full SBOM instead
 *
 * returns an OBJECT (code-exec wraps a bare array as `{result: [...]}`, which
 * would hide these behind `outputs.result`):
 *   rows            one entry per asset, with the metadata payload
 *   write_requests  the same rows shaped as np-api-call forEach items
 *                   (`spreadItem: true` merges `path`/`body` into its config)
 *   by_status       tally, so the step log alone answers "did this go well?"
 */

const builds = (inputs.builds || []).map((b) => ({
  ...b,
  // The lake hands `assets` over as a JSON string so a ClickHouse tuple array
  // never has to survive the plugin boundary.
  assets: (typeof b.assets_json === 'string' ? JSON.parse(b.assets_json) : b.assets_json || [])
    .map((a) => (Array.isArray(a) ? { id: a[0], name: a[1], type: a[2] } : a)),
}));

if (!inputs.githubToken) {
  throw new Error('githubToken is empty — set the GITHUB_TOKEN config entry on /lib-inventory');
}

const gh = makeGitHubTransport(inputs.githubToken);
const internalPatterns = compileInternalPatterns(inputs.internalPatterns || []);
const now = new Date().toISOString();
const opts = {
  internalPatterns,
  now,
  keepTransitiveExternal: inputs.keepTransitiveExternal === true,
};

const concurrency = Math.max(1, Number(inputs.concurrency) || 6);
const rows = [];
let cursor = 0;

async function worker() {
  for (;;) {
    const i = cursor++;
    if (i >= builds.length) return;
    const build = builds[i];
    try {
      rows.push(...(await scanBuild(build, gh, opts)));
    } catch (err) {
      // A build that blows up in an unexpected way must still produce a row per
      // asset — a missing row is indistinguishable from "never scanned", which
      // is precisely the silent failure this workflow exists to avoid.
      log.error(`scan failed for build ${build.build_id}: ${err.message}`);
      for (const a of build.assets) {
        rows.push({
          asset_id: a.id,
          asset_name: a.name,
          build_id: build.build_id,
          app_id: build.app_id,
          data: {
            status: 'repo_unreachable',
            status_detail: `scanner error: ${err.message}`,
            primary_language: null,
            languages: [],
            repository_url: build.repository_url || null,
            repository_path: null,
            commit: build.commit || null,
            match_level: null,
            manifests: [],
            dependencies: [],
            total_count: 0,
            direct_count: 0,
            internal_count: 0,
            local_count: 0,
            transitive_external_dropped: 0,
            scanned_at: now,
            scanner_version: SCANNER_VERSION,
          },
        });
      }
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, builds.length) }, worker));

const byStatus = {};
for (const r of rows) byStatus[r.data.status] = (byStatus[r.data.status] || 0) + 1;
log.info(`scanned ${builds.length} builds -> ${rows.length} assets`, byStatus);

return {
  rows,
  write_requests: rows.map((r) => ({
    path: `/metadata/asset/${r.asset_id}/dependencies`,
    body: r.data,
  })),
  by_status: byStatus,
};
