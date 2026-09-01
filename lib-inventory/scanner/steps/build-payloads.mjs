/**
 * STEP `build_payloads` — one catalog-entity document per asset. No network.
 *
 * Merges every parse step's output. Builds that never got past an earlier step
 * arrive through `unreachable` and STILL produce a record: an asset with no
 * record has to mean "never visited", nothing else, or coverage stops being
 * measurable.
 */
const parsed = mergeParsed((inputs.parsed || []).filter(Boolean));
const rows = buildPayloads({
  resolutions: inputs.resolutions || [],
  parsed,
  unreachable: [...(inputs.unscannable || []), ...(inputs.failed || [])],
  now: new Date().toISOString(),
  releaseId: inputs.releaseId || null,
});

const byStatus = {};
for (const r of rows) byStatus[r.data.status] = (byStatus[r.data.status] || 0) + 1;
log.info(`built ${rows.length} asset records`, byStatus);

return {
  rows,
  by_status: byStatus,
  // PATCH + `upsert=true` on the catalog: create and update are the same
  // request, so a rescan (forced by deleting nothing — just run it) simply
  // replaces the document. Two writers racing on a fresh asset can hit a 409
  // on the create path; the step's retry takes the update path a moment later.
  write_requests: rows.map((r) => ({
    path: `/catalog/instances/dependency-inventory/${r.asset_id}?upsert=true`,
    body: r.data,
  })),
};
