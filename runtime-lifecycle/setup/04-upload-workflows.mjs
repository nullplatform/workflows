#!/usr/bin/env node
/**
 * Uploads the runtime-lifecycle workflow definitions to the engine, patching
 * cross-workflow references (sub-workflow workflowId + agent tool workflow)
 * with the per-org wf_ ids as they are created — sub-workflow resolution is
 * by workflow id, client keys/slugs do NOT resolve at runtime.
 *
 * Run from the repo root with tsx (needs the workspace deps):
 *   NP_API_KEY=… pnpm tsx workflows/runtime-lifecycle/setup/04-upload-workflows.mjs
 *
 * Dry run (no NP_API_KEY needed, no network calls, nothing written):
 *   pnpm tsx workflows/runtime-lifecycle/setup/04-upload-workflows.mjs --dry-run
 * Parses + normalizes + schema-validates every file in FILES through the
 * exact same loadDefinition() path a real upload uses, and prints
 * name → key plus step/connection counts. POSTs/PUTs nothing.
 *
 * Idempotent: definitions already uploaded (tracked in setup/.uploaded.json,
 * per organization) get a new revision via PUT instead of a duplicate POST.
 * Prints — but does not run — the alias activation commands: activation has
 * side effects (cron schedules, the events trigger creates its NP channel)
 * and stays a manual, deliberate step.
 *
 * Alias dance (do not skip): without an ACTIVE alias, PUT upserts the
 * revision IN-PLACE and workers keep serving the stale cached definition.
 * The correct sequence for a definition's first-ever go-live is create →
 * POST .../aliases/prod/activate; every later change is PUT (new revision)
 * followed by re-activating (repoint) the SAME alias, never a fresh one.
 * wf-r1 (runtime_catalog_sync) already lives on kwik-e-mart as
 * wf_S4C7aHyzmrB2 with alias `prod` per the existing
 * workflows/runtime-lifecycle/setup/.uploaded.json — that file is untracked
 * runtime state; this script reads it but must never be told to discard it.
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

// Upload order respects the reference graph (callee before caller): the
// shared progressive-deploy pack (tools, then the orchestrator) first since
// wf-r4 invokes it as a sub-workflow, then the runtime-lifecycle suite
// itself in dependency order. Both scanner (wf-r2) and closer (wf-r5) write
// FLAT now — there are no wf-r2b/wf-r5b sub-workflow children anymore.
// wf-r4/wf-r5 go before wf-r3, which routes events to both.
const FILES = [
  { file: '../deploy/tools/deploy-start.yaml', key: 'deploy_start' },
  { file: '../deploy/tools/deploy-status.yaml', key: 'deploy_status' },
  { file: '../deploy/tools/deploy-switch-traffic.yaml', key: 'deploy_switch_traffic' },
  { file: '../deploy/tools/deploy-finish.yaml', key: 'deploy_finish' },
  { file: '../deploy/tools/deploy-metrics.yaml', key: 'deploy_metrics' },
  { file: '../deploy/tools/item-comment.yaml', key: 'item_comment' },
  { file: '../deploy/progressive-deploy.yaml', key: 'progressive_deploy' },
  { file: 'wf-r1-catalog-sync.yaml', key: 'runtime_catalog_sync' },
  { file: 'wf-r2-scanner.yaml', key: 'runtime_deprecation_scanner' },
  { file: 'wf-r5-closer.yaml', key: 'runtime_lifecycle_closer' },
  { file: 'wf-r4-apply.yaml', key: 'runtime_lifecycle_apply' },
  { file: 'wf-r3-events.yaml', key: 'runtime_lifecycle_events' },
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
