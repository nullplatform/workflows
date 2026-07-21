/**
 * @file E2E for `check_release_staged`.
 *
 * Stubs:
 *   - `np-checklist-trigger` as a passthrough (workflow inputs flow through).
 *   - `np-entity-paginated-fetch` to return a synthetic deployment listing.
 *   - `np-checklist-item-resolve` to capture the resolution payload.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { runWorkflowE2E } from '@nullplatform/workflow-kit/test';

const WF_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'check-release-staged.yaml');

const TRIGGER_OUTPUTS = {
  kind: 'check-release-staged',
  runId: 'crun_test',
  itemId: 'release_passed_stage',
  callbackUrl: 'https://approval-api.test/approval/9001/checklist/items/release_passed_stage',
  callbackToken: 'tok_signed_xxx',
  inputs: { release_id: 'rel_777', application_id: 1521043056 },
  approvalRequestId: 9001,
  applicationId: 1521043056,
  nrn: 'organization=4::account=95118862::namespace=1078333155::application=1521043056',
};

interface DeploymentRow {
  id: string;
  release_id: string;
  scope_id: number;
  scope?: { dimensions: { environment: string } };
  created_at: string;
}

interface ResolveCall {
  status: unknown;
  message: unknown;
  details: unknown;
}

async function run(deployments: DeploymentRow[]) {
  let resolveCall: ResolveCall | null = null;
  const result = await runWorkflowE2E({
    yamlPath: WF_PATH,
    inputs: TRIGGER_OUTPUTS,
    pluginStubs: {
      'np-checklist-trigger': {
        handler: () => ({ status: 'success', outputs: {}, activePorts: ['default'] }),
        registryType: 'trigger',
      },
      'np-entity-paginated-fetch': {
        handler: () => ({
          status: 'success',
          outputs: { items: deployments, totalFetched: deployments.length, pages: 1 },
          activePorts: ['default'],
        }),
        // Force single-call semantics so code-exec sees the wrapper object
        // as a single upstream item rather than getting fan-out per record.
        executeMode: 'all',
      },
      // Progress pings are fire-and-forget HTTP calls — a passthrough stub
      // keeps the graph valid without asserting on them.
      'np-checklist-item-progress': () => ({
        status: 'success',
        outputs: { ok: true, statusCode: 200 },
        activePorts: ['default'],
      }),
      'np-checklist-item-resolve': (ctx) => {
        const i = ctx.inputs ?? {};
        resolveCall = {
          status: i.status,
          message: i.message,
          details: i.details,
        };
        return {
          status: 'success',
          outputs: { ok: true, statusCode: 200, body: {} },
          activePorts: ['default'],
        };
      },
    },
  });
  return { result, resolveCall };
}

const STAGE_MATCH: DeploymentRow = {
  id: 'dep_1',
  release_id: 'rel_777',
  scope_id: 999,
  scope: { dimensions: { environment: 'stage' } },
  created_at: '2026-05-19T10:00:00Z',
};

const PROD_MATCH: DeploymentRow = {
  id: 'dep_2',
  release_id: 'rel_777',
  scope_id: 1000,
  scope: { dimensions: { environment: 'production' } },
  created_at: '2026-05-20T10:00:00Z',
};

const STAGE_OTHER: DeploymentRow = {
  id: 'dep_3',
  release_id: 'rel_111',
  scope_id: 999,
  scope: { dimensions: { environment: 'stage' } },
  created_at: '2026-05-18T10:00:00Z',
};

describe('check_release_staged (E2E)', () => {
  it('passes when a stage deploy with the same release_id exists', async () => {
    const { result, resolveCall } = await run([PROD_MATCH, STAGE_MATCH, STAGE_OTHER]);
    const call = resolveCall as ResolveCall;
    expect(call.status).toBe('passed');
    expect(String(call.message)).toMatch(/rel_777/);
    expect((call.details as Record<string, unknown>).matched_deployment_id).toBe('dep_1');
    expect(result.outputs.resolved_status).toBe('passed');
  });

  it('fails when only production deploys carry the release_id', async () => {
    const { resolveCall } = await run([PROD_MATCH, STAGE_OTHER]);
    const call = resolveCall as ResolveCall;
    expect(call.status).toBe('failed');
    expect(String(call.message)).toMatch(/not found/i);
    expect((call.details as Record<string, unknown>).stage_deploy_count).toBe(1);
  });

  it('fails when the recent deploys list is empty', async () => {
    const { resolveCall } = await run([]);
    const call = resolveCall as ResolveCall;
    expect(call.status).toBe('failed');
    expect((call.details as Record<string, unknown>).stage_deploy_count).toBe(0);
  });
});
