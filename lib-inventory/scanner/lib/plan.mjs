import { buildBlobQuery } from './blobs.mjs';
import { manifestLang, parseRepoUrl } from './manifests.mjs';

/** Max manifests fetched per repository. Bounds a pathological monorepo. */
export const MAX_MANIFESTS_PER_REPO = 120;

/**
 * STEP 1 — turn lake rows into GitHub tree requests.
 *
 * Emits `requests` (index-aligned with `plans`, consumed by the `http-request`
 * forEach) and `unscannable` for builds that can never be fetched. Note the
 * request carries ONLY a url: the credential lives in the http-request step's
 * own config as `${{ secrets.GITHUB_TOKEN }}`, so it never passes through a
 * `code-exec` output and never reaches the execution state.
 */
export function planTreeFetches(builds) {
  const requests = [];
  const plans = [];
  const unscannable = [];
  for (const build of builds) {
    const repo = parseRepoUrl(build.repository_url);
    if (!repo) {
      unscannable.push({
        build,
        status: 'repo_missing',
        status_detail: build.repository_url
          ? `repository_url is not a GitHub URL: ${build.repository_url}`
          : 'application has no repository_url configured',
      });
      continue;
    }
    // Pinned to the build's commit, with no fallback to a branch: reading
    // `main` when the commit is gone would silently describe DIFFERENT code
    // than the one that shipped. A missing commit is `repo_unreachable`.
    requests.push({
      url:
        `https://api.github.com/repos/${repo.owner}/${repo.repo}` +
        `/git/trees/${encodeURIComponent(build.commit)}?recursive=1`,
    });
    plans.push({ ...build, owner: repo.owner, repo: repo.repo });
  }
  return { requests, plans, unscannable };
}

/**
 * STEP 2 — from the fetched trees, list every manifest and build one batched
 * GraphQL request per repository.
 *
 * `treeResults[i]` is the http-request result for `plans[i]`. A forEach
 * iteration that exhausted its retries is absorbed as an EMPTY slot in the same
 * position — that empty slot is the signal for `repo_unreachable`, which is why
 * the arrays must stay index-aligned.
 */
export function planManifestFetches(plans, treeResults) {
  const requests = [];
  const kept = [];
  const failed = [];

  plans.forEach((plan, i) => {
    const res = treeResults?.[i];
    const paths = res?.body?.tree;
    if (!res || !Array.isArray(paths)) {
      failed.push({
        build: plan,
        status: 'repo_unreachable',
        status_detail:
          `could not read the tree of ${plan.owner}/${plan.repo}@${plan.commit}` +
          (res?.statusCode ? ` (HTTP ${res.statusCode})` : ' (request failed)'),
      });
      return;
    }
    if (res.body.truncated === true) {
      failed.push({
        build: plan,
        status: 'repo_unreachable',
        status_detail: `the tree of ${plan.owner}/${plan.repo} is truncated (>100k entries)`,
      });
      return;
    }

    // `output_projection` trims each entry to its `path`, so accept both the
    // projected string form and the raw GitHub object.
    const files = paths
      .map((p) => (typeof p === 'string' ? p : p?.path))
      .filter((p) => typeof p === 'string');
    const manifests = files
      .filter((p) => manifestLang(p.slice(p.lastIndexOf('/') + 1)) !== null)
      .slice(0, MAX_MANIFESTS_PER_REPO);

    kept.push({ ...plan, files, manifests });
    requests.push({
      url: 'https://api.github.com/graphql',
      method: 'POST',
      body: { query: buildBlobQuery(plan.owner, plan.repo, plan.commit, manifests) },
    });
  });

  return { requests, plans: kept, failed };
}
