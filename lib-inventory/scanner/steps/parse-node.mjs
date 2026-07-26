/**
 * STEP `parse_node` — extract dependencies from the `package.json` files.
 * No network.
 *
 * A sibling of `parse_go`, not a branch inside it: each ecosystem is its own
 * node on the canvas feeding `build_payloads`, so which ones an organization
 * actually needs is visible rather than buried in a config blob.
 *
 * Node reports DIRECT dependencies only — npm states transitivity in the
 * lockfile, and lockfiles are large enough to reintroduce the payload problem
 * the per-build split exists to solve. See `parsePackageJson`.
 */
const parsed = parseEcosystem(inputs.resolutions || [], 'node', {
  internalPatterns: compileInternalPatterns(inputs.internalPatterns),
  keepTransitiveExternal: inputs.keepTransitiveExternal === true,
});
log.info(`parsed node for ${Object.keys(parsed).length} assets`);
return { parsed };
