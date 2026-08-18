#!/usr/bin/env node
/**
 * Uploads the deploy-analysis workflow definitions to the engine, patching
 * the backfill's sub-workflow reference (`deploy_change_analysis`) with the
 * per-org wf_ id as it is created — sub-workflow resolution is by workflow
 * id, client keys/slugs do NOT resolve at runtime.
 *
 * Run from the engine repo root with tsx (needs the workspace deps):
 *   NP_API_KEY=… pnpm tsx workflows/deploy-analysis/setup/03-upload-workflows.mjs
 *
 * Idempotent: definitions already uploaded (tracked in setup/.uploaded.json,
 * per organization) get a new revision via PUT instead of a duplicate POST.
 * Prints — but does not run — the alias activation commands: activation has
 * side effects (cron schedules) and stays a manual, deliberate step.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeWorkflowDocument,
  parseYamlDocument,
  schemaValidate,
} from '../../../packages/dsl/src/yaml/index.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const API_BASE = process.env.NP_API_BASE ?? 'https://api.nullplatform.com';
const STATE_FILE = join(DIR, '.uploaded.json');

// Upload order respects the reference graph (callee before caller).
const PLAN = [
  { file: 'deploy-change-analysis.yaml', key: 'deploy_change_analysis' },
  { file: 'deploy-backfill.yaml', key: 'deploy_backfill' },
  { file: 'deploy-weekly-summary.yaml', key: 'deploy_weekly_summary' },
];

async function mintToken(apiKey) {
  const res = await fetch(`${API_BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ api_key: apiKey }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const data = await res.json();
  return { token: data.access_token, orgId: String(data.organization_id ?? '') };
}

async function loadDefinition(file) {
  const yaml = await readFile(join(DIR, '..', file), 'utf8');
  const parsed = parseYamlDocument(yaml);
  const errors = parsed.errors.filter((e) => e.severity === 'error');
  if (errors.length > 0) throw new Error(`${file}: ${JSON.stringify(errors)}`);
  const validated = schemaValidate(normalizeWorkflowDocument(parsed.document));
  if (!validated.ok) throw new Error(`${file}: ${JSON.stringify(validated.errors)}`);
  return validated.value;
}

/** Rewrites client-key sub-workflow references to per-org wf_ ids. */
function patchReferences(def, idByKey) {
  const steps = Array.isArray(def.steps) ? def.steps : Object.values(def.steps ?? {});
  for (const step of steps) {
    const config = step?.config;
    if (!config) continue;
    if (typeof config.workflowId === 'string' && idByKey[config.workflowId]) {
      config.workflowId = idByKey[config.workflowId];
    }
  }
}

async function main() {
  const apiKey = process.env.NP_API_KEY;
  if (!apiKey) throw new Error('export NP_API_KEY first');
  const { token, orgId } = await mintToken(apiKey);
  console.log(`organization: ${orgId}`);

  let state = {};
  try {
    state = JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    /* first run */
  }
  state[orgId] = state[orgId] ?? {};
  const orgState = state[orgId];

  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const idByKey = { ...orgState };

  for (const { file, key } of PLAN) {
    const def = await loadDefinition(file);
    patchReferences(def, idByKey);

    const existing = orgState[key];
    const url = existing
      ? `${API_BASE}/workflows/definitions/${existing}`
      : `${API_BASE}/workflows/definitions`;
    const res = await fetch(url, {
      method: existing ? 'PUT' : 'POST',
      headers,
      body: JSON.stringify(def),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        `${file} upload failed (${res.status}): ${JSON.stringify(body).slice(0, 300)}`,
      );
    }
    const wfId = body.id ?? body.workflowId ?? body.data?.id ?? body.workflow?.id ?? existing;
    if (!wfId) {
      throw new Error(
        `${file}: could not extract the workflow id from the response — keys: ${Object.keys(body).join(',')}`,
      );
    }
    idByKey[key] = wfId;
    orgState[key] = wfId;
    const rev =
      typeof body.revision === 'object' ? (body.revision?.revision ?? '?') : (body.revision ?? '?');
    console.log(`${existing ? 'revised' : 'created'} ${key} → ${wfId} (rev ${rev})`);
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  }

  console.log('\nAll definitions uploaded (NOT activated). To go live later:');
  for (const { key } of PLAN) {
    console.log(
      `  curl -X POST ${API_BASE}/workflows/definitions/${idByKey[key]}/aliases/live/activate -H "Authorization: Bearer $TOKEN"`,
    );
  }
  console.log('\nInitial backfill (after activating deploy_change_analysis):');
  console.log(
    `  curl -X POST "${API_BASE}/workflows/definitions/${idByKey.deploy_backfill}/execute?alias=live" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"inputs":{"days":15}}'`,
  );
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
