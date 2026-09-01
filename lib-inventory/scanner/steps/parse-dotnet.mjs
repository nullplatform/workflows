/**
 * STEP `parse_dotnet` — extract dependencies from the `*.csproj` files.
 * No network.
 *
 * A sibling of the other parse steps, one ecosystem per canvas node. .NET
 * reports DIRECT dependencies only (NuGet states transitivity in lock/assets
 * files that are not committed manifests); `<ProjectReference>` rows come out
 * flagged `local`. See `parseCsproj`.
 */
const parsed = parseEcosystem(inputs.resolutions || [], 'dotnet', {
  parse: parseCsproj,
  readConfig: csprojConfig,
  internalPatterns: compileInternalPatterns(inputs.internalPatterns),
  keepTransitiveExternal: inputs.keepTransitiveExternal === true,
});
log.info(`parsed dotnet for ${Object.keys(parsed).length} assets`);
return { parsed };
