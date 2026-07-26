import { SCANNER_VERSION } from './manifests.mjs';

export const EMPTY_COUNTS = {
  total_count: 0,
  direct_count: 0,
  internal_count: 0,
  local_count: 0,
  transitive_external_dropped: 0,
};

export function payload(fields) {
  return {
    status: 'ok',
    status_detail: null,
    primary_language: null,
    languages: [],
    repository_url: null,
    repository_path: null,
    commit: null,
    match_level: null,
    manifests: [],
    dependencies: [],
    manifest_config: {},
    ...EMPTY_COUNTS,
    scanned_at: fields.scanned_at,
    scanner_version: SCANNER_VERSION,
    ...fields,
  };
}
