#!/usr/bin/env node
/**
 * Uploads the security-assessment workflow definitions to the engine.
 *
 * Same contract as the runtime-lifecycle uploader it is adapted from:
 *   NP_API_KEY=… pnpm tsx workflows/security-assessment/setup/02-upload-workflows.mjs
 *   pnpm tsx workflows/security-assessment/setup/02-upload-workflows.mjs --dry-run
 *
 * Idempotent: definitions already uploaded (tracked per organization in
 * setup/.uploaded.json) get a new revision via PUT instead of a duplicate POST.
 * Activation is NOT performed — it has side effects and stays deliberate.
 *
 * Alias dance (do not skip): without an ACTIVE alias, PUT upserts the revision
 * IN-PLACE and workers keep serving the stale cached definition. First go-live
 * is create → POST .../aliases/prod/activate; every later change is PUT
 * followed by re-activating the SAME alias, never a fresh one.
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
const DRY_RUN = process.argv.includes('--dry-run');

// ORDER MATTERS: children first — callers reference them by client key and
// patchReferences can only rewrite once the child has a wf_… id.
const FILES = [
  { file: 'wf3-ensure-security-action-item.yaml', key: 'security_ensure_action_item' },
  { file: 'wf2-assess-deployment.yaml', key: 'security_assess_deployment' },
  { file: 'wf1-security-scanner.yaml', key: 'security_scanner' },
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
  // DIR is workflows/runtime-lifecycle/setup; join(DIR, '..', file) lands on
  // workflows/runtime-lifecycle/ for sibling wf-r* files, and on
  // workflows/deploy/... for the '../deploy/...' entries (one more '..'
  // baked into the file path itself) — same resolution the cost uploader
  // uses from its own setup/ directory, unchanged here.
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
        if (tool?.type === 'workflow' && idByKey[tool.workflow]) {
          tool.workflow = idByKey[tool.workflow];
        }
      }
    }
  }
}

/**
 * Resolves `${{ vars.NP_ORGANIZATION_ID }}` inside TRIGGER configs to the
 * uploading org's literal id. Trigger ACTIVATION does not run the template
 * resolver: the engine sent `nrn: "organization=${{ vars.… }}"` verbatim to
 * POST /notification/channel and NP's NRN-based authz rejected it with 401
 * (verified live 2026-07-20 — the same request with the literal nrn is a
 * 200). Runtime step configs still resolve vars normally; only activation
 * needs the literal.
 */
function patchTriggerOrg(def, orgId) {
  const needle = '${{ vars.NP_ORGANIZATION_ID }}';
  const patch = (cfg) => {
    if (!cfg || typeof cfg !== 'object') return;
    for (const [k, v] of Object.entries(cfg)) {
      if (typeof v === 'string' && v.includes(needle)) {
        cfg[k] = v.split(needle).join(orgId);
      } else if (v && typeof v === 'object') {
        patch(v);
      }
    }
  };
  for (const trg of def.triggers ?? []) patch(trg.config);
  const steps = Array.isArray(def.steps) ? def.steps : Object.values(def.steps ?? {});
  for (const step of steps) {
    if (step?.type === 'trigger') patch(step.config);
  }
}

function countConnections(def) {
  return Array.isArray(def.connections) ? def.connections.length : 0;
}

async function dryRun() {
  console.log(`dry run: normalizing ${FILES.length} file(s), no network calls\n`);
  let failed = 0;
  for (const { file, key } of FILES) {
    try {
      const def = await loadDefinition(file);
      const steps = Array.isArray(def.steps) ? def.steps : Object.values(def.steps ?? {});
      console.log(
        `ok    ${key.padEnd(32)} ${file.padEnd(38)} steps=${steps.length} connections=${countConnections(def)}`,
      );
    } catch (err) {
      failed += 1;
      console.error(`FAIL  ${key.padEnd(32)} ${file.padEnd(38)} ${err.message ?? err}`);
    }
  }
  console.log(`\n${FILES.length - failed}/${FILES.length} normalized cleanly.`);
  if (failed > 0) process.exit(1);
}

async function main() {
  if (DRY_RUN) {
    await dryRun();
    return;
  }

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
    patchTriggerOrg(def, orgId);

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
    // A revision PUT does NOT move the workflow ENTITY in the folder tree —
    // its `path` is fixed at create time (live finding 2026-07-21: the v4
    // /action-items move left every entity under the old folder). Converge it.
    if (existing && typeof def.path === 'string') {
      const pres = await fetch(`${API_BASE}/workflows/definitions/${wfId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ path: def.path }),
      });
      if (!pres.ok) console.log(`  WARN: entity path converge failed (${pres.status})`);
    }

    // Carry every ACTIVE alias onto the revision just uploaded. Activating an
    // alias does NOT move it: `POST .../aliases/prod/activate` re-activates
    // whatever revision it already points at, so an upload followed by an
    // activate left production serving the PREVIOUS revision while every
    // console output said "activated" (hit twice on 2026-07-26 alone).
    // Repoint first (PUT), then activate, and print what actually went live.
    if (rev !== '?' && Number.isFinite(Number(rev))) {
      const alRes = await fetch(`${API_BASE}/workflows/definitions/${wfId}/aliases`, { headers });
      const alBody = await alRes.json().catch(() => ({}));
      const aliases = (alBody.data ?? alBody.aliases ?? []).filter(
        (a) => a.active === true && a.name !== 'latest',
      );
      for (const alias of aliases) {
        if (alias.revision === Number(rev)) continue;
        const put = await fetch(`${API_BASE}/workflows/definitions/${wfId}/aliases/${alias.name}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ revision: Number(rev) }),
        });
        if (!put.ok) {
          console.log(`  WARN: could not repoint alias '${alias.name}' (${put.status})`);
          continue;
        }
        const act = await fetch(
          `${API_BASE}/workflows/definitions/${wfId}/aliases/${alias.name}/activate`,
          { method: 'POST', headers },
        );
        const actBody = await act.json().catch(() => ({}));
        const live = actBody.alias?.revision ?? '?';
        console.log(
          `  alias '${alias.name}' ${alias.revision} → ${live}` +
            (act.ok ? '' : ` (activate FAILED ${act.status})`),
        );
      }
    }
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  }

  console.log('\nAll definitions uploaded (NOT activated). To go live later:');
  for (const { key } of FILES) {
    console.log(
      `  curl -X POST ${API_BASE}/workflows/definitions/${idByKey[key]}/aliases/prod/activate -H "Authorization: Bearer $TOKEN"`,
    );
  }
  console.log(
    '\nRepoint reminder: definitions already on an ACTIVE alias (e.g. runtime_catalog_sync) only',
  );
  console.log('  need the SAME alias re-activated after this PUT — do not create a second alias.');
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
