#!/usr/bin/env node
/**
 * Points an NP audit notification channel at `wf-a1-on-build`'s webhook, so
 * every build UPDATE in the organization reaches the listener (which keeps
 * only successful builds on watched branches).
 *
 *   NP_API_KEY=… node autofix/setup/04-build-channel.mjs
 *   …/04-build-channel.mjs --dry-run              # show what would be created
 *   …/04-build-channel.mjs --delete               # remove the channel (stops autofix)
 *   …/04-build-channel.mjs --workflow-id wf_…     # bypass setup/.uploaded.json
 *   …/04-build-channel.mjs --methods PATCH,POST   # audit methods to forward (default PATCH)
 *   …/04-build-channel.mjs --nrn organization=X:account=Y:namespace=Z:application=W
 *                                                 # scope the channel to one application (staging); default: the org
 *
 * Widening later: `--delete --nrn <the app nrn>` first, then re-run for the org —
 * channels are matched by description AND nrn, so an app-scoped channel is not
 * replaced by an org-scoped one (both would deliver, harmlessly but noisily).
 *
 * Run it AFTER 03-upload-workflows.mjs --alias live: the webhook URL only
 * exists once the trigger is active, and it carries an opaque per-registration
 * token that resolves to exactly one organization. That token IS the security
 * boundary, which is why this script reads the URL from the engine rather than
 * assembling one.
 *
 * THIS IS THE GO-LIVE SWITCH. Once the channel exists, successful builds start
 * producing action items and — for auto-fixable findings — pull requests on
 * real repositories. Stage it: watch one branch pattern, one application, and
 * confirm the first PR before widening AUTOFIX_BRANCHES.
 *
 * Idempotent: the channel is matched by its description, which is stamped with
 * the workflow id, so re-running converges instead of piling up duplicates. A
 * channel whose URL drifted (re-activated alias → fresh token) is recreated.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const API_BASE = process.env.NP_API_BASE ?? 'https://api.nullplatform.com';
const ENGINE_BASE = `${API_BASE}/workflows`;
const STATE_FILE = join(DIR, '.uploaded.json');
const DRY_RUN = process.argv.includes('--dry-run');
const DELETE = process.argv.includes('--delete');
const argValue = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const WORKFLOW_ID_ARG = argValue('--workflow-id');
const NRN_ARG = argValue('--nrn');
const METHODS = (argValue('--methods') ?? 'PATCH').split(',').map((s) => s.trim()).filter(Boolean);

/** The workflow whose webhook the channel targets, by client key. */
const WORKFLOW_KEY = 'autofix-on-build';
/** The trigger step id inside it. */
const TRIGGER_ID = 'on_build';

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

/** The webhook URL the engine publishes for the live trigger binding. */
async function webhookUrlFor(headers, workflowId) {
  const res = await fetch(`${ENGINE_BASE}/triggers?workflowId=${workflowId}`, { headers });
  if (!res.ok) throw new Error(`GET /triggers failed: ${res.status}`);
  const body = await res.json();
  const rows = body.data ?? body.triggers ?? body ?? [];
  const live = rows.filter((t) => t.triggerId === TRIGGER_ID || t.id === TRIGGER_ID || t.stepId === TRIGGER_ID);
  if (live.length === 0) {
    throw new Error(`no trigger '${TRIGGER_ID}' on ${workflowId} — upload wf-a1 and activate its alias first`);
  }
  const withUrl = live.find((t) => t.runtimeMetadata?.webhookUrl);
  if (!withUrl) {
    throw new Error(
      `trigger '${TRIGGER_ID}' has no webhookUrl yet (status: ${live.map((t) => t.status).join(', ')}) — is the alias ACTIVE?`,
    );
  }
  return withUrl.runtimeMetadata.webhookUrl;
}

function orgIdFromToken(jwt) {
  const part = jwt.split('.')[1];
  if (!part) return '';
  const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  const groups = claims['cognito:groups'] ?? [];
  const hit = groups.find((g) => String(g).includes('/organization='));
  return hit ? String(hit).split('/organization=')[1] : '';
}

async function findChannels(headers, nrn, description) {
  const res = await fetch(`${API_BASE}/notification/channel?nrn=${encodeURIComponent(nrn)}`, { headers });
  if (!res.ok) return [];
  const body = await res.json();
  const rows = body.results ?? body.data ?? [];
  return rows.filter((c) => c.description === description);
}

async function main() {
  // Channel management needs `notification_channel:create`, which an org API
  // key does not carry by default. `NP_SESSION_TOKEN` lets you run this with
  // YOUR bearer (the same way trigger activation stamps the activating actor).
  const sessionToken = process.env.NP_SESSION_TOKEN;
  const apiKey = process.env.NP_API_KEY;
  if (!sessionToken && !apiKey) throw new Error('export NP_SESSION_TOKEN or NP_API_KEY first');
  const { token, orgId } = sessionToken
    ? { token: sessionToken, orgId: orgIdFromToken(sessionToken) }
    : await mintToken(apiKey);
  if (!orgId) throw new Error('could not determine the organization from the token');
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  let workflowId = WORKFLOW_ID_ARG;
  if (!workflowId) {
    const state = JSON.parse(await readFile(STATE_FILE, 'utf8').catch(() => '{}'));
    workflowId = state[orgId]?.[WORKFLOW_KEY];
  }
  if (!workflowId) {
    throw new Error(`${WORKFLOW_KEY} is not uploaded for org ${orgId} — run 03-upload-workflows.mjs --alias live, or pass --workflow-id wf_…`);
  }

  const nrn = NRN_ARG ?? `organization=${orgId}`;
  if (!nrn.startsWith(`organization=${orgId}`)) throw new Error(`--nrn ${nrn} is not under organization=${orgId}`);
  const description = `Autofix — build updated [workflow=${workflowId}]`;
  const existing = await findChannels(headers, nrn, description);

  if (DELETE) {
    for (const c of existing) {
      const res = await fetch(`${API_BASE}/notification/channel/${c.id}`, { method: 'DELETE', headers });
      console.log(`deleted channel ${c.id} (${res.status})`);
    }
    if (existing.length === 0) console.log('nothing to delete');
    return;
  }

  const url = await webhookUrlFor(headers, workflowId);
  const payload = {
    nrn,
    description,
    source: ['audit'],
    type: 'http',
    configuration: { url },
    // Server-side filter: only build UPDATES reach the webhook (status flips
    // and metadata writes are PATCHes; creates are `pending` builds nobody
    // needs). Without it every audited mutation in the org would hit the
    // endpoint and be discarded by `extract_build`.
    filters: {
      $and: [
        { entity: { $eq: 'build' } },
        METHODS.length === 1 ? { method: { $eq: METHODS[0] } } : { method: { $in: METHODS } },
      ],
    },
  };

  if (DRY_RUN) {
    console.log(JSON.stringify({ existing: existing.map((c) => c.id), payload }, null, 2));
    return;
  }

  const match = existing.find((c) => (c.configuration?.url ?? c.url) === url);
  if (match) {
    console.log(`channel ${match.id} already points at the current webhook — nothing to do`);
    return;
  }
  for (const stale of existing) {
    await fetch(`${API_BASE}/notification/channel/${stale.id}`, { method: 'DELETE', headers });
    console.log(`deleted stale channel ${stale.id}`);
  }

  const res = await fetch(`${API_BASE}/notification/channel`, { method: 'POST', headers, body: JSON.stringify(payload) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`channel create failed (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
  console.log(`created channel ${body.id} (nrn ${nrn}) → ${url}`);
  console.log('Autofix is LIVE: successful builds on the watched branches now create items and pull requests.');
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
