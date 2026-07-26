/**
 * Go (`go.mod`) dependency parsing.
 *
 * The only ecosystem here that states TRANSITIVITY in the manifest itself, via
 * the `// indirect` marker `go mod tidy` writes — which is why Go gets
 * transitive internals for free and every other parser has to say it cannot.
 */

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
