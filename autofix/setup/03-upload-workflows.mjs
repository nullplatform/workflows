#!/usr/bin/env node
/**
 * Uploads the autofix workflow definitions to the engine and (optionally)
 * points + activates an alias on each.
 *
 *   NP_API_KEY=… node autofix/setup/03-upload-workflows.mjs                 # upload only
 *   NP_API_KEY=… node autofix/setup/03-upload-workflows.mjs --alias live    # upload + repoint + activate `live`
 *   node autofix/setup/03-upload-workflows.mjs --dry-run                    # normalize locally, no network
 *
 * Idempotent: definitions already uploaded (tracked per organization in
 * setup/.uploaded.json) get a new revision via PUT instead of a duplicate POST.
 *
 * ORDER MATTERS: wf-a2 first. wf-a1 references it by the client key
 * `autofix-fix` (sub-workflow `workflowId`), which `patchReferences` rewrites
 * to the per-org `wf_…` id — possible only once wf-a2 has one.
 *
 * Alias dance (do not skip): without an ACTIVE alias, PUT upserts the revision
 * in place and workers keep serving the stale cached definition. First go-live
 * is `--alias live`; every later change is a re-run with the SAME alias.
 * wf-a1 dispatches wf-a2 through `alias: live`, so both must carry it.
 *
 * Activation registers wf-a1's webhook trigger and mints its token-bearing URL —
 * that is a pure engine-side effect. Nothing reaches this workflow until
 * 04-build-channel.mjs points an NP notification channel at that URL.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeWorkflowDocument,
  parseYamlDocument,
  schemaValidate,
} from '@nullplatform/workflow-kit/test';

const DIR = dirname(fileURLToPath(import.meta.url));
const API_BASE = process.env.NP_API_BASE ?? 'https://api.nullplatform.com';
const STATE_FILE = join(DIR, '.uploaded.json');
const DRY_RUN = process.argv.includes('--dry-run');
const aliasArg = process.argv.find((a) => a.startsWith('--alias'));
const ALIAS = aliasArg
  ? (aliasArg.includes('=') ? aliasArg.split('=')[1] : process.argv[process.argv.indexOf(aliasArg) + 1])
  : null;

const FILES = [
  { file: 'wf-a2-fix.yaml', key: 'autofix-fix' },
  { file: 'wf-a1-on-build.yaml', key: 'autofix-on-build' },
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

/** Rewrites client-key references (sub-workflow + agent tools) to wf_ ids. */
function patchReferences(def, idByKey) {
  const steps = Array.isArray(def.steps) ? def.steps : Object.values(def.steps ?? {});
  for (const step of steps) {
    const config = step?.config;
    if (!config) continue;
    if (typeof config.workflowId === 'string' && idByKey[config.workflowId]) {
      config.workflowId = idByKey[config.workflowId];
    }
    if (Array.isArray(config.tools)) {
      for (const tool of config.tools) {
        if (tool?.type === 'workflow' && idByKey[tool.workflow]) tool.workflow = idByKey[tool.workflow];
      }
    }
  }
}

function stepCount(def) {
  return (Array.isArray(def.steps) ? def.steps : Object.values(def.steps ?? {})).length;
}

async function dryRun() {
  console.log(`dry run: normalizing ${FILES.length} file(s), no network calls\n`);
  let failed = 0;
  for (const { file, key } of FILES) {
    try {
      const def = await loadDefinition(file);
      console.log(`ok    ${key.padEnd(20)} ${file.padEnd(24)} steps=${stepCount(def)} connections=${def.connections?.length ?? 0}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL  ${key.padEnd(20)} ${file.padEnd(24)} ${err.message ?? err}`);
    }
  }
  console.log(`\n${FILES.length - failed}/${FILES.length} normalized cleanly.`);
  if (failed > 0) process.exit(1);
}

async function pointAndActivate(headers, wfId, alias, revision) {
  // PUT repoints an EXISTING alias; a missing one answers 404 and is created
  // with POST on the collection (verified live 2026-09-08).
  let put = await fetch(`${API_BASE}/workflows/definitions/${wfId}/aliases/${alias}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ revision }),
  });
  if (put.status === 404) {
    put = await fetch(`${API_BASE}/workflows/definitions/${wfId}/aliases`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: alias, revision }),
    });
  }
  if (!put.ok) throw new Error(`could not point alias '${alias}' at rev ${revision} (${put.status})`);
  const act = await fetch(`${API_BASE}/workflows/definitions/${wfId}/aliases/${alias}/activate`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  const body = await act.json().catch(() => ({}));
  if (!act.ok) throw new Error(`activate '${alias}' failed (${act.status}): ${JSON.stringify(body).slice(0, 300)}`);
  console.log(`  alias '${alias}' → rev ${body.alias?.revision ?? revision}, active`);
}

async function main() {
  if (DRY_RUN) return dryRun();

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

  for (const { file, key } of FILES) {
    const def = await loadDefinition(file);
    patchReferences(def, idByKey);

    const existing = orgState[key];
    const url = existing
      ? `${API_BASE}/workflows/definitions/${existing}`
      : `${API_BASE}/workflows/definitions`;
    const res = await fetch(url, { method: existing ? 'PUT' : 'POST', headers, body: JSON.stringify(def) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${file} upload failed (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
    const wfId = body.id ?? body.workflowId ?? body.data?.id ?? body.workflow?.id ?? existing;
    if (!wfId) throw new Error(`${file}: could not extract the workflow id — keys: ${Object.keys(body).join(',')}`);
    idByKey[key] = wfId;
    orgState[key] = wfId;
    const rev = typeof body.revision === 'object' ? (body.revision?.revision ?? '?') : (body.revision ?? '?');
    console.log(`${existing ? 'revised' : 'created'} ${key} → ${wfId} (rev ${rev})`);
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2));

    if (ALIAS && Number.isFinite(Number(rev))) {
      await pointAndActivate(headers, wfId, ALIAS, Number(rev));
    }
  }

  if (!ALIAS) {
    console.log('\nUploaded (NOT activated). To go live: re-run with --alias live, then 04-build-channel.mjs.');
  } else {
    console.log(`\nBoth workflows live on alias '${ALIAS}'. Next: node autofix/setup/04-build-channel.mjs`);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
