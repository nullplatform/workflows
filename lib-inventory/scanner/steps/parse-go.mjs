/**
 * STEP `parse_go` — extract dependencies from the Go manifests. No network.
 *
 * One step per ecosystem on purpose: adding Node or Maven becomes a new node on
 * the canvas feeding `build_payloads`, not another branch inside a growing
 * blob. `go.mod` is also the only manifest that states transitivity itself, via
 * the `// indirect` marker `go mod tidy` writes.
 */
const parsed = parseEcosystem(inputs.resolutions || [], 'go', {
  internalPatterns: compileInternalPatterns(inputs.internalPatterns),
  keepTransitiveExternal: inputs.keepTransitiveExternal === true,
});
log.info(`parsed go for ${Object.keys(parsed).length} assets`);
return { parsed };
