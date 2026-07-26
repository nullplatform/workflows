/**
 * STEP `plan_manifest_fetches` — trees → one batched GraphQL request per repo.
 * No network.
 *
 * Every manifest in the repository is fetched, not just the ones a resolved
 * asset needs: rung L2 has to read an artifact's DECLARED name, so fetching
 * everything once is one round trip instead of resolve-miss-refetch.
 */
const { requests, plans, failed } = planManifestFetches(inputs.plans || [], inputs.treeResults || []);
log.info(`planned ${requests.length} manifest fetches`, { unreachable: failed.length });
return { requests, plans, failed };
