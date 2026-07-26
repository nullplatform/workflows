#!/usr/bin/env node
/**
 * Points an NP audit notification channel at `wf-l2-on-release`'s webhook, so
 * a release creation reaches the inventory within seconds.
 *
 *   NP_API_KEY=… pnpm tsx workflows/lib-inventory/setup/04-release-channel.mjs
 *   …/04-release-channel.mjs --dry-run     # show what would be created
 *   …/04-release-channel.mjs --delete      # remove the channel
 *
 * Run it AFTER uploading and activating wf-l2: the webhook URL only exists
 * once the trigger is live, and it carries an opaque per-registration token
 * that resolves to exactly one organization. That token IS the security
 * boundary, which is why this script reads the URL from the engine rather than
 * assembling one.
 *
 * Idempotent: the channel is matched by its description, which is stamped with
 * the workflow id, so re-running converges instead of piling up duplicates.
 * A channel whose URL drifted (the engine's public base changed, or the alias
 * was re-activated with a fresh token) is deleted and recreated.
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

/** The workflow whose webhook the channel targets, by client key. */
const WORKFLOW_KEY = 'lib_inventory_on_release';
/** The trigger step id inside it. */
const TRIGGER_ID = 'on_release_audit';

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

/**
 * The webhook URL the engine publishes for the live trigger binding.
 *
 * `GET /triggers` recomputes it from the current engine base on every read, so
 * it is the only trustworthy source — a URL cached anywhere else goes stale the
 * moment the deployment's public base changes.
 */
async function webhookUrlFor(headers, workflowId) {
  const res = await fetch(`${ENGINE_BASE}/triggers?workflowId=${workflowId}`, { headers });
  if (!res.ok) throw new Error(`GET /triggers failed: ${res.status}`);
  const body = await res.json();
  const rows = body.data ?? body.triggers ?? body ?? [];
  // The listing keys the binding as `triggerId` (not `id`); the alternatives
  // are accepted so this survives a field rename without going silent.
  const live = rows.filter(
    (t) => t.triggerId === TRIGGER_ID || t.id === TRIGGER_ID || t.stepId === TRIGGER_ID,
  );
  if (live.length === 0) {
    throw new Error(
      `no trigger '${TRIGGER_ID}' on ${workflowId} — upload wf-l2 and activate its alias first`,
    );
  }
  const withUrl = live.find((t) => t.runtimeMetadata?.webhookUrl);
  if (!withUrl) {
    throw new Error(
      `trigger '${TRIGGER_ID}' has no webhookUrl yet (status: ` +
        `${live.map((t) => t.status).join(', ')}) — is the alias ACTIVE?`,
    );
  }
  return withUrl.runtimeMetadata.webhookUrl;
}

/**
 * The organization a session bearer belongs to, read from its
 * `@nullplatform/organization=<id>` group claim. Decoding without verifying is
 * fine here: the value only picks which row of `.uploaded.json` to read, and
 * every request made with the token is authorised by NP, not by this.
 */
function orgIdFromToken(jwt) {
  const part = jwt.split('.')[1];
  if (!part) return '';
  const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  const groups = claims['cognito:groups'] ?? [];
  const hit = groups.find((g) => String(g).includes('/organization='));
  return hit ? String(hit).split('/organization=')[1] : '';
}

async function findChannels(headers, nrn, description) {
  const res = await fetch(`${API_BASE}/notification/channel?nrn=${encodeURIComponent(nrn)}`, {
    headers,
  });
  if (!res.ok) return [];
  const body = await res.json();
  const rows = body.results ?? body.data ?? [];
  return rows.filter((c) => c.description === description);
}

async function main() {
  // Channel management needs `notification_channel:create`, which an org API
  // key does not carry by default — a key without it fails the create with a
  // bare 401. `NP_SESSION_TOKEN` lets you run this with YOUR bearer, the same
  // way trigger activation already stamps the activating actor's token.
  const sessionToken = process.env.NP_SESSION_TOKEN;
  const apiKey = process.env.NP_API_KEY;
  if (!sessionToken && !apiKey) throw new Error('export NP_SESSION_TOKEN or NP_API_KEY first');
  const { token, orgId } = sessionToken
    ? { token: sessionToken, orgId: orgIdFromToken(sessionToken) }
    : await mintToken(apiKey);
  if (!orgId) throw new Error('could not determine the organization from the token');
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const state = JSON.parse(await readFile(STATE_FILE, 'utf8'));
  const workflowId = state[orgId]?.[WORKFLOW_KEY];
  if (!workflowId) {
    throw new Error(`${WORKFLOW_KEY} is not uploaded for org ${orgId} — run 03-upload first`);
  }

  const nrn = `organization=${orgId}`;
  const description = `Library inventory — release created [workflow=${workflowId}]`;
  const existing = await findChannels(headers, nrn, description);

  if (DELETE) {
    for (const c of existing) {
      const res = await fetch(`${API_BASE}/notification/channel/${c.id}`, {
        method: 'DELETE',
        headers,
      });
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
    // Server-side filter: only release CREATES reach the webhook. Without it
    // every audited mutation in the organization would hit this endpoint and
    // be discarded by `extract_release` — correct, but a lot of noise and a
    // lot of executions.
    filters: { $and: [{ entity: { $eq: 'release' } }, { method: { $eq: 'POST' } }] },
  };

  if (DRY_RUN) {
    console.log(JSON.stringify({ existing: existing.map((c) => c.id), payload }, null, 2));
    return;
  }

  // Converge: an existing channel already pointing at the current URL is the
  // desired state; anything else is deleted and recreated, so a rotated token
  // never leaves a channel posting into the void.
  const match = existing.find((c) => (c.configuration?.url ?? c.url) === url);
  if (match) {
    console.log(`channel ${match.id} already points at the current webhook — nothing to do`);
    return;
  }
  for (const stale of existing) {
    await fetch(`${API_BASE}/notification/channel/${stale.id}`, { method: 'DELETE', headers });
    console.log(`deleted stale channel ${stale.id}`);
  }

  const res = await fetch(`${API_BASE}/notification/channel`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`channel create failed (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
  }
  console.log(`created channel ${body.id} → ${url}`);
  console.log('Releases created from now on are scanned within seconds.');
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
