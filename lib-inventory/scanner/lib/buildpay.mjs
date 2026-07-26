import { SUPPORTED_ECOSYSTEMS } from './manifests.mjs';
import { payload } from './payload.mjs';

/**
 * Merge the per-ecosystem `parseEcosystem` results into one entry per asset.
 *
 * NOT `Object.assign`: an asset whose subtree holds both a `go.mod` and a
 * `package.json` (a service with a bundled UI — ordinary) appears in BOTH
 * results, and a shallow merge keeps whichever parse step ran last and
 * silently discards the other ecosystem's dependencies entirely. The failure
 * is invisible in the record: `languages` still lists both, so it reads as a
 * complete scan that is missing half its data.
 */
export function mergeParsed(perEcosystem) {
  const out = {};
  for (const result of perEcosystem ?? []) {
    for (const [assetId, got] of Object.entries(result ?? {})) {
      const prev = out[assetId];
      if (!prev) {
        out[assetId] = {
          dependencies: [...(got.dependencies ?? [])],
          transitive_external_dropped: got.transitive_external_dropped ?? 0,
          config: { ...(got.config ?? {}) },
        };
        continue;
      }
      prev.dependencies.push(...(got.dependencies ?? []));
      prev.transitive_external_dropped += got.transitive_external_dropped ?? 0;
      // Config keys are already ecosystem-prefixed, so two ecosystems never
      // collide here.
      Object.assign(prev.config, got.config ?? {});
    }
  }
  return out;
}

/**
 * STEP 5 — assemble one metadata payload per asset.
 *
 * `parsed` is the merge of every `parseEcosystem` result. Builds that never got
 * past an earlier step arrive via `unscannable`/`failed` and still produce a
 * record — an asset with NO record must mean "never visited", nothing else.
 */
export function buildPayloads({ resolutions, parsed, unreachable, now }) {
  const rows = [];

  for (const { build, status, status_detail } of unreachable ?? []) {
    for (const a of build.assets || []) {
      rows.push({
        asset_id: a.id,
        asset_name: a.name,
        exists: a.exists === true,
        build_id: build.build_id,
        app_id: build.app_id,
        data: payload({
          repository_url: build.repository_url || null,
          commit: build.commit || null,
          scanned_at: now,
          status,
          status_detail,
        }),
      });
    }
  }

  for (const r of resolutions) {
    const base = {
      repository_url: r.plan.repository_url || null,
      commit: r.plan.commit || null,
      scanned_at: now,
    };
    for (const asset of r.assets) {
      const row = {
        asset_id: asset.asset_id,
        asset_name: asset.asset_name,
        exists: asset.exists === true,
        build_id: r.plan.build_id,
        app_id: r.plan.app_id,
      };
      if (!asset.hit) {
        row.data = payload({
          ...base,
          status: 'unresolved',
          status_detail: `no directory in ${r.plan.owner}/${r.plan.repo} matches asset name "${asset.asset_name}"`,
        });
        rows.push(row);
        continue;
      }

      const languages = [...new Set(asset.manifests.map((m) => m.ecosystem))].sort();
      const common = {
        ...base,
        repository_path: asset.hit.dir,
        match_level: asset.hit.level,
        languages,
        primary_language: languages[0] ?? null,
        manifests: asset.manifests.map((m) => ({ path: m.path, language: m.ecosystem })),
      };

      if (!asset.manifests.length) {
        row.data = payload({
          ...common,
          status: 'no_manifest',
          status_detail: `resolved to "${asset.hit.dir}" (${asset.hit.level}) but it contains no dependency manifest`,
        });
        rows.push(row);
        continue;
      }

      const got = parsed[asset.asset_id];
      if (!got) {
        row.data = payload({
          ...common,
          status: 'lang_unsupported',
          status_detail: `manifests found (${languages.join(', ')}) but no parser is enabled for them yet`,
        });
        rows.push(row);
        continue;
      }

      const deps = got.dependencies;
      const unparsed = languages.filter((l) => !SUPPORTED_ECOSYSTEMS.has(l));
      row.data = payload({
        ...common,
        status: 'ok',
        status_detail: unparsed.length ? `not parsed yet: ${unparsed.join(', ')}` : null,
        dependencies: deps,
        total_count: deps.filter((d) => !d.local).length,
        direct_count: deps.filter((d) => d.direct && !d.local).length,
        internal_count: deps.filter((d) => d.internal && !d.local).length,
        local_count: deps.filter((d) => d.local).length,
        transitive_external_dropped: got.transitive_external_dropped,
        manifest_config: got.config ?? {},
      });
      rows.push(row);
    }
  }

  return rows;
}
