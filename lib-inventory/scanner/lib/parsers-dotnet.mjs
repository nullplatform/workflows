/**
 * .NET (`*.csproj`) dependency parsing.
 *
 * DIRECT DEPENDENCIES ONLY, same contract as node and maven: NuGet states
 * transitivity in `packages.lock.json`/`project.assets.json`, artifacts that
 * are either not committed or large enough to reintroduce the payload problem
 * the per-build split exists to solve. Nothing here runs a restore.
 *
 * `version` is the DECLARED value. A `<PackageReference>` with no version at
 * all is Central Package Management — the version lives in
 * `Directory.Packages.props`, which is not a detected manifest — so the empty
 * string is the honest declared state, exactly like an unresolvable Maven
 * `${property}` staying verbatim.
 *
 * `<ProjectReference>` is code this repository ships, not a consumed library:
 * flagged `local`, named by its project file's basename, excluded from the
 * counts — the same treatment as Go's `replace`-to-a-path and npm's
 * `workspace:*`.
 */

/** Strip XML comments before any matching — same rule as the maven parser. */
function stripComments(text) {
  return String(text).replace(/<!--[\s\S]*?-->/g, '');
}

export function parseCsproj(text) {
  const body = stripComments(text);
  const deps = [];
  const seen = new Set();

  // <PackageReference Include="X" Version="1.2.3" /> — attribute order is
  // free, and Version may instead be a child element on the following lines.
  const pkgRe = /<PackageReference\b([^>]*?)(\/>|>([\s\S]*?)<\/PackageReference>)/g;
  for (const m of body.matchAll(pkgRe)) {
    const attrs = m[1];
    const inner = m[3] ?? '';
    const name = /\bInclude\s*=\s*"([^"]+)"/.exec(attrs)?.[1];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const version =
      /\bVersion\s*=\s*"([^"]+)"/.exec(attrs)?.[1] ??
      /<Version>\s*([^<]+?)\s*<\/Version>/.exec(inner)?.[1] ??
      '';
    deps.push({ name, version, direct: true, ecosystem: 'dotnet', local: false });
  }

  const projRe = /<ProjectReference\b[^>]*?\bInclude\s*=\s*"([^"]+)"/g;
  for (const m of body.matchAll(projRe)) {
    // `..\Acme.Domain\Acme.Domain.csproj` → `Acme.Domain`
    const base = m[1].split(/[\\/]/).pop() ?? m[1];
    const name = base.replace(/\.[a-z0-9]+proj$/i, '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    deps.push({ name, version: '', direct: true, ecosystem: 'dotnet', local: true });
  }

  return deps;
}

/**
 * What the project declares about ITSELF: the SDK and target framework answer
 * "which assets still target net6.0" — a runtime question no dependency list
 * answers.
 */
export function csprojConfig(text) {
  const body = stripComments(text);
  const config = {};
  const sdk = /<Project\b[^>]*?\bSdk\s*=\s*"([^"]+)"/.exec(body)?.[1];
  if (sdk) config.sdk = sdk;
  const tf =
    /<TargetFramework>\s*([^<]+?)\s*<\/TargetFramework>/.exec(body)?.[1] ??
    /<TargetFrameworks>\s*([^<]+?)\s*<\/TargetFrameworks>/.exec(body)?.[1];
  if (tf) config.target_framework = tf;
  return config;
}
