#!/usr/bin/env node
/**
 * Uploads the cost/right-sizing workflow definitions to the engine, patching
 * cross-workflow references (sub-workflow workflowId + agent tool workflow)
 * with the per-org wf_ ids as they are created — sub-workflow resolution is
 * by workflow id, client keys/slugs do NOT resolve at runtime.
 *
 * Run from the repo root with tsx (needs the workspace deps):
 *   NP_API_KEY=… pnpm tsx workflows/cost/setup/04-upload-workflows.mjs
 *
 * Idempotent: definitions already uploaded (tracked in setup/.uploaded.json,
 * per organization) get a new revision via PUT instead of a duplicate POST.
 * Prints — but does not run — the alias activation commands: activation has
 * side effects (cron schedules, the events trigger creates its NP channel)
 * and stays a manual, deliberate step.
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
  { file: 'wf1b-cost-scope-collect.yaml', key: 'cost_scope_collect' },
  { file: 'wf2c-cost-metrics-tool.yaml', key: 'cost_metrics_tool' },
  { file: 'wf2b-right-sizing-analyze-scope.yaml', key: 'right_sizing_analyze_scope' },
  { file: 'wf1-cost-tracker.yaml', key: 'cost_tracker' },
  { file: 'wf2-right-sizing-scanner.yaml', key: 'right_sizing_scanner' },
  { file: 'wf6-cluster-cost-calibration.yaml', key: 'cluster_cost_calibration' },
  { file: 'wf7b-rightsizing-verify-scope.yaml', key: 'right_sizing_verify_scope' },
  { file: 'wf7-rightsizing-closer.yaml', key: 'right_sizing_closer' },
  // Q&A before the events router (wf3 references it as a sub-workflow).
  { file: 'wf8-rightsizing-qa.yaml', key: 'right_sizing_qa' },
  // Reusable progressive-deploy pack (workflows/deploy) — tools first, then
  // the AI orchestrator, then wf4 which invokes it.
  { file: '../deploy/tools/deploy-start.yaml', key: 'deploy_start' },
  { file: '../deploy/tools/deploy-status.yaml', key: 'deploy_status' },
  { file: '../deploy/tools/deploy-switch-traffic.yaml', key: 'deploy_switch_traffic' },
  { file: '../deploy/tools/deploy-finish.yaml', key: 'deploy_finish' },
  { file: '../deploy/tools/deploy-metrics.yaml', key: 'deploy_metrics' },
  { file: '../deploy/tools/item-comment.yaml', key: 'item_comment' },
  { file: '../deploy/progressive-deploy.yaml', key: 'progressive_deploy' },
  { file: 'wf4-apply-rightsizing.yaml', key: 'right_sizing_apply' },
  { file: 'wf3-right-sizing-events.yaml', key: 'right_sizing_events' },
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
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  }

  console.log('\nAll definitions uploaded (NOT activated). To go live later:');
  for (const { key } of PLAN) {
    console.log(
      `  curl -X POST ${API_BASE}/workflows/definitions/${idByKey[key]}/aliases/prod/activate -H "Authorization: Bearer $TOKEN"`,
    );
  }
  console.log('\nManual smoke run (no activation needed):');
  console.log(
    `  curl -X POST ${API_BASE}/workflows/definitions/${idByKey.cost_tracker}/execute -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"inputs":{"nrn":"<acota-aca>"}}'`,
  );
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
