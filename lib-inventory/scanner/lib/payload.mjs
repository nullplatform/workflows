import { SCANNER_VERSION } from './manifests.mjs';

export const EMPTY_COUNTS = {
  total_count: 0,
  direct_count: 0,
  internal_count: 0,
  local_count: 0,
  transitive_external_dropped: 0,
};

/**
 * One catalog-entity document per asset (spec `dependency-inventory`).
 *
 * Identity and provenance (`id`, `nrn`, `build_id`, `release_id`) come from
 * the caller; everything the platform already knows about the asset's
 * application or namespace is deliberately NOT here — the entity's `nrn`
 * encodes the hierarchy and the lake joins the rest. The spec declares
 * `additionalProperties: false`, so every key emitted here must stay declared
 * there: one unknown property rejects the ENTIRE record.
 */
export function payload(fields) {
  return {
    status: 'ok',
    status_detail: null,
    release_id: null,
    primary_language: null,
    languages: [],
    repository_path: null,
    commit: null,
    match_level: null,
    manifests: [],
    // `libraries`, NOT `dependencies`: the catalog API silently DROPS a
    // property named `dependencies` on write (a legacy JSON-Schema keyword its
    // schema engine treats specially) — every probe shape lost the array while
    // its sibling keys survived, hit live 2026-08-31.
    libraries: [],
    manifest_config: {},
    ...EMPTY_COUNTS,
    scanned_at: fields.scanned_at,
    scanner_version: SCANNER_VERSION,
    ...fields,
  };
}
