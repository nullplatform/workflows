/**
 * STEP `parse_maven` — extract dependencies from the `pom.xml` files.
 * No network.
 *
 * Direct declarations only, and no reactor resolution: a real Maven resolve
 * walks parent POMs and imported BOMs, which means either running Maven (we
 * never build) or chasing artifacts across the network from a sandbox. A
 * version that comes from a parent POM reaches the record verbatim as
 * `${some.version}` — obviously unresolved, rather than a guess.
 */
const parsed = parseEcosystem(inputs.resolutions || [], 'java-maven', {
  parse: parsePomXml,
  readConfig: pomConfig,
  internalPatterns: compileInternalPatterns(inputs.internalPatterns),
  keepTransitiveExternal: inputs.keepTransitiveExternal === true,
});
log.info(`parsed java-maven for ${Object.keys(parsed).length} assets`);
return { parsed };
