/**
 * STEP `build_payloads` — one metadata record per asset. No network.
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
});

const byStatus = {};
for (const r of rows) byStatus[r.data.status] = (byStatus[r.data.status] || 0) + 1;
log.info(`built ${rows.length} asset records`, byStatus);

return {
  rows,
  by_status: byStatus,
  // POST only: the lake query already excluded assets that have a record, and
  // the metadata API is create-or-update, not upsert (POST on an existing one
  // is a 400). An asset is pinned to an immutable commit, so there is nothing
  // to update — only assets never seen before reach this step.
  write_requests: rows.map((r) => ({
    path: `/metadata/asset/${r.asset_id}/dependencies`,
    body: r.data,
  })),
};
