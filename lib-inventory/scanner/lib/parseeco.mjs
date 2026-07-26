/**
 * STEP 4 — parse the manifests of ONE ecosystem.
 *
 * Kept per-ecosystem on purpose: adding Node or Maven becomes a new step on the
 * canvas feeding `build_payloads`, not another branch inside a growing blob.
 * Returns `{ [asset_id]: { dependencies, transitive_external_dropped, config } }`.
 *
 * `config` is what the manifests declare about THEMSELVES (`engines.node`, the
 * `go` directive, the package manager) — runtime statements that answer
 * "which assets still declare node 16", a question no dependency array can.
 * Keys are prefixed with the ecosystem so two manifests never collide.
 *
 * The parser is PASSED IN rather than looked up in a registry. Importing the
 * registry would drag every ecosystem's parser into every parse step's inlined
 * bundle — the Maven step carrying the Go and Python parsers it never calls —
 * which is exactly the "each step gets only what it uses" property the module
 * split exists to preserve. It went from 780 lines a step back to ~300.
 */
export function parseEcosystem(resolutions, ecosystem, opts) {
  const parse = opts.parse;
  if (!parse) throw new Error(`no parser passed for ecosystem "${ecosystem}"`);
  const readConfig = opts.readConfig;
  const keepAll = opts.keepTransitiveExternal === true;
  const isInternal = (name) => opts.internalPatterns.some((re) => re.test(name));

  const out = {};
  for (const r of resolutions) {
    for (const asset of r.assets) {
      const mine = asset.manifests.filter((m) => m.ecosystem === ecosystem);
      if (!mine.length) continue;

      const seen = new Set();
      const deps = [];
      const config = {};
      let dropped = 0;
      for (const m of mine) {
        const text = r.texts[m.path];
        if (text == null) continue;
        if (readConfig) {
          // Last manifest wins on a collision. An asset with several manifests
          // of one ecosystem is a monorepo subtree; the deepest one is listed
          // last and is the more specific statement.
          for (const [k, v] of Object.entries(readConfig(text, m.path, r.texts))) {
            config[`${ecosystem}.${k}`] = v;
          }
        }
        // The whole repository's fetched manifests, so a parser can resolve a
        // SIBLING file without a network call. Maven needs it: a module pom
        // inherits its `<properties>` from a parent pom that, in a monorepo of
        // lambdas, sits at the repository root and has already been fetched.
        for (const d of parse(text, m.path, r.texts)) {
          const key = `${d.ecosystem} ${d.name} ${d.version}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const internal = isInternal(d.name);
          if (!keepAll && !d.direct && !internal && !d.local) {
            dropped += 1;
            continue;
          }
          deps.push({ local: false, ...d, internal });
        }
      }
      out[asset.asset_id] = { dependencies: deps, transitive_external_dropped: dropped, config };
    }
  }
  return out;
}
