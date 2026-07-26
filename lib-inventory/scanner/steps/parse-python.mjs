/**
 * STEP `parse_python` — extract dependencies from the Python manifests.
 * No network.
 *
 * Python declares them in three unrelated files (`requirements.txt`,
 * `pyproject.toml`, `Pipfile`), so this is the one ecosystem whose parser
 * dispatches on the filename. Direct declarations only — transitivity lives in
 * a lock file, and lock files are the artifact large enough to reintroduce the
 * payload problem the per-build split exists to solve.
 */
const parsed = parseEcosystem(inputs.resolutions || [], 'python', {
  parse: parsePython,
  readConfig: pythonConfig,
  internalPatterns: compileInternalPatterns(inputs.internalPatterns),
  keepTransitiveExternal: inputs.keepTransitiveExternal === true,
});
log.info(`parsed python for ${Object.keys(parsed).length} assets`);
return { parsed };
