/**
 * Parse a `go.mod`. Returns direct and indirect requirements with the exact
 * version Go resolved — no `go.sum`, toolchain or module download needed.
 *
 * Modules redirected by a `replace` to a filesystem path are in-repo code, not
 * consumed libraries — they carry a placeholder version
 * (`v0.0.0-00010101000000-000000000000`) and would otherwise pollute the
 * inventory. They are kept, flagged `local: true`, and excluded from the
 * counts, so "which module does this asset share code with" stays answerable.
 */
export function parseGoMod(text) {
  const lines = String(text).split('\n');

  const localModules = new Set();
  let inReplace = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    if (/^replace\s*\($/.test(line)) {
      inReplace = true;
      continue;
    }
    if (inReplace && line === ')') {
      inReplace = false;
      continue;
    }

    let body = null;
    if (inReplace) body = line;
    else if (line.startsWith('replace ')) body = line.slice('replace '.length).trim();
    if (!body) continue;

    const m = /^(\S+)(?:\s+v\S+)?\s*=>\s*(\S+)/.exec(body);
    if (m && /^(\.{1,2}\/|\/)/.test(m[2])) localModules.add(m[1]);
  }

  const deps = [];
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    if (/^require\s*\($/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ')') {
      inBlock = false;
      continue;
    }

    let body = null;
    if (inBlock) body = line;
    else if (line.startsWith('require ')) body = line.slice('require '.length).trim();
    if (!body) continue;

    const m = /^(\S+)\s+(v\S+)(\s*\/\/\s*indirect)?/.exec(body);
    if (!m) continue;
    deps.push({
      name: m[1],
      version: m[2],
      direct: !m[3],
      ecosystem: 'go',
      local: localModules.has(m[1]),
    });
  }
  return deps;
}

/**
 * Dependency blocks of a `package.json`, in the order they are merged. A name
 * declared twice keeps its FIRST scope — `dependencies` outranks
 * `devDependencies`, which is what a duplicate almost always means.
 */
const NODE_BLOCKS = [
  ['dependencies', { dev: false, optional: false }],
  ['peerDependencies', { dev: false, optional: false, peer: true }],
  ['optionalDependencies', { dev: false, optional: true }],
  ['devDependencies', { dev: true, optional: false }],
];

/** Specifiers that point at code in this repository rather than a registry. */
const NODE_LOCAL_SPEC = /^(file:|link:|workspace:|portal:)/;

/**
 * Parse a `package.json`.
 *
 * DIRECT DEPENDENCIES ONLY, and that is a real limitation rather than an
 * oversight: npm states transitivity in the LOCKFILE, and lockfiles are the
 * one artifact large enough to reintroduce the size problem the whole
 * per-build split exists to solve (megabyte `package-lock.json` files are
 * ordinary). Go is the exception here, not the rule — `go.mod` carries
 * `// indirect` inline, so it gets transitive internals for free.
 *
 * `version` is the DECLARED RANGE (`^1.2.3`, `workspace:*`, a git URL), not a
 * resolved version. Nothing is installed or resolved, so a range is the honest
 * answer; a consumer asking "who is behind" has to compare ranges, not points.
 *
 * Workspace/file/link specifiers are in-repo code, not consumed libraries —
 * same treatment as Go's `replace` to a path: kept, flagged `local`, excluded
 * from the counts.
 */
export function parsePackageJson(text) {
  let pkg;
  try {
    pkg = JSON.parse(String(text));
  } catch {
    // A package.json that does not parse is not a dependency list. Returning
    // nothing lets the asset fall through to `no_manifest`/partial coverage
    // instead of failing the whole build's scan.
    return [];
  }
  if (pkg === null || typeof pkg !== 'object') return [];

  const deps = [];
  const seen = new Set();
  for (const [block, flags] of NODE_BLOCKS) {
    const entry = pkg[block];
    if (entry === null || typeof entry !== 'object') continue;
    for (const [name, spec] of Object.entries(entry)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const version = typeof spec === 'string' ? spec : '';
      deps.push({
        name,
        version,
        direct: true,
        ecosystem: 'node',
        local: NODE_LOCAL_SPEC.test(version),
        ...flags,
      });
    }
  }
  return deps;
}

/**
 * What a `go.mod` declares about ITSELF — the language version the module is
 * built against, and the pinned toolchain when there is one.
 */
export function goModConfig(text) {
  const cfg = {};
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    const go = /^go\s+(\S+)/.exec(line);
    if (go) cfg.go = go[1];
    const tc = /^toolchain\s+(\S+)/.exec(line);
    if (tc) cfg.toolchain = tc[1];
  }
  return cfg;
}

/**
 * What a `package.json` declares about ITSELF.
 *
 * Separate from the dependency list on purpose: `engines.node` is a RUNTIME
 * statement, not a library one, and it answers a different question — "which
 * assets still declare node 16" is the node equivalent of the lambda-runtime
 * deprecation sweep, and it is invisible in a dependency array.
 */
export function packageJsonConfig(text) {
  let pkg;
  try {
    pkg = JSON.parse(String(text));
  } catch {
    return {};
  }
  if (pkg === null || typeof pkg !== 'object') return {};
  const cfg = {};
  if (typeof pkg.name === 'string') cfg.name = pkg.name;
  if (typeof pkg.version === 'string') cfg.version = pkg.version;
  if (typeof pkg.type === 'string') cfg.type = pkg.type;
  if (typeof pkg.packageManager === 'string') cfg.packageManager = pkg.packageManager;
  if (pkg.engines !== null && typeof pkg.engines === 'object') {
    for (const [k, v] of Object.entries(pkg.engines)) {
      if (typeof v === 'string') cfg[`engines.${k}`] = v;
    }
  }
  // A workspaces field is the difference between "an app" and "a monorepo
  // root", which is exactly what an L4 match cannot tell you on its own.
  if (Array.isArray(pkg.workspaces)) cfg.workspaces = String(pkg.workspaces.length);
  return cfg;
}

/**
 * Ecosystem -> self-declaration reader. Optional: an ecosystem with no entry
 * simply contributes nothing to `manifest_config`.
 */
export const CONFIG_READERS = { go: goModConfig, node: packageJsonConfig };

/** Ecosystem -> manifest parser. Adding one here is what enables a parse step. */
export const PARSERS = { go: parseGoMod, node: parsePackageJson };
