import { CONFIG_READERS, PARSERS } from './parsers.mjs';

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
 */
export function parseEcosystem(resolutions, ecosystem, opts) {
  const parse = PARSERS[ecosystem];
  if (!parse) throw new Error(`no parser registered for ecosystem "${ecosystem}"`);
  const readConfig = CONFIG_READERS[ecosystem];
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
          for (const [k, v] of Object.entries(readConfig(text))) config[`${ecosystem}.${k}`] = v;
        }
        for (const d of parse(text)) {
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
