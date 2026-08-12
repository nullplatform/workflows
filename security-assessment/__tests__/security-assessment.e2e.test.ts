/**
 * @file E2E tests for the security-assessment workflow suite (plugin-level stubs).
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeWorkflowDocument,
  parseYamlDocument,
  schemaValidate,
} from '@nullplatform/workflow-kit/test';
import type { IStepResult } from '@nullplatform/workflow-kit/test';
import { describe, expect, it } from 'vitest';

import { runWorkflowE2E } from '@nullplatform/workflow-kit/test';

const SUITE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENSURE = resolve(SUITE_DIR, 'wf3-ensure-security-action-item.yaml');
const ASSESS = resolve(SUITE_DIR, 'wf2-assess-deployment.yaml');
const SCANNER = resolve(SUITE_DIR, 'wf1-security-scanner.yaml');
const CLOSE = resolve(SUITE_DIR, 'wf4-close-resolved-finding.yaml');

const ok = (outputs: Record<string, unknown>): IStepResult => ({
  status: 'success',
  outputs,
  activePorts: ['default'],
});

const passthroughTrigger = { handler: () => ok({}), registryType: 'trigger' as const };

const FINDING = {
  finding_key: 'sec:9:hardcoded-secret-src-config-ts',
  scope_id: '111',
  scope_name: 'Production',
  scope_nrn: 'organization=4:account=17:namespace=3:application=9:scope=111',
  application: 'app-a',
  application_id: '9',
  deployment_id: '901',
  rule_id: 'hardcoded-secret',
  severity: 'high',
  priority: 'high',
  value: 300,
  title: 'AWS key committed in src/config.ts',
  file: 'src/config.ts',
  evidence: 'line 12: const AWS_KEY = "AKIA..."',
  recommendation: 'Move to a config entry secret.',
  repo: 'https://github.com/nullplatform/app-a',
  commit: 'abc123',
  due_date: '2026-08-25',
  metadata: {
    finding_key: 'sec:9:hardcoded-secret-src-config-ts',
    scope_id: '111',
    deployment_id: '901',
    application_id: '9',
    rule_id: 'hardcoded-secret',
    severity: 'high',
    file: 'src/config.ts',
    commit: 'abc123',
    detected_at: '2026-08-11T03:00:00Z',
  },
};

async function runEnsure(opts: {
  foundItems?: Array<Record<string, unknown>>;
  finding?: Record<string, unknown>;
}) {
  const calls: { created: Record<string, unknown>[]; updated: Record<string, unknown>[] } = {
    created: [],
    updated: [],
  };
  const items = opts.foundItems ?? [];
  const result = await runWorkflowE2E({
    yamlPath: ENSURE,
    inputs: {
      finding: opts.finding ?? FINDING,
      category_slug: 'security',
      organization_id: '4',
    },
    pluginStubs: {
      manual: passthroughTrigger,
      'np-action-item-find': {
        handler: () => ok({ count: items.length, items, firstMatch: items[0] ?? null }),
        executeMode: 'all' as const,
      },
      'np-action-item-create': {
        handler: (ctx: { inputs: Record<string, unknown> }) => {
          calls.created.push(ctx.inputs);
          return ok({ actionItemId: 'ai_new' });
        },
        executeMode: 'all' as const,
      },
      'np-action-item-update': {
        handler: (ctx: { inputs: Record<string, unknown> }) => {
          calls.updated.push(ctx.inputs);
          return ok({ actionItemId: 'ai_old' });
        },
        executeMode: 'all' as const,
      },
    },
  });
  return { result, calls };
}

describe('wf3-ensure-security-action-item (E2E)', () => {
  it('creates when no live item matches the finding_key', async () => {
    const { result, calls } = await runEnsure({});
    expect(result.outputs.action).toBe('created');
    expect(result.outputs.action_item_id).toBe('ai_new');
    expect(result.outputs.finding_key).toBe(FINDING.finding_key);
    expect(calls.created).toHaveLength(1);
    expect(calls.updated).toHaveLength(0);
  });

  it('no-ops when a live item exists for the same commit', async () => {
    const { result, calls } = await runEnsure({
      foundItems: [{ id: 'ai_old', metadata: { commit: 'abc123' } }],
    });
    expect(result.outputs.action).toBe('unchanged');
    expect(result.outputs.action_item_id).toBe('ai_old');
    expect(calls.created).toHaveLength(0);
    expect(calls.updated).toHaveLength(0);
  });

  it('patches metadata when the finding survived a redeploy (commit changed)', async () => {
    const { result, calls } = await runEnsure({
      foundItems: [{ id: 'ai_old', metadata: { commit: 'OLDSHA' } }],
    });
    expect(result.outputs.action).toBe('updated');
    expect(result.outputs.action_item_id).toBe('ai_old');
    expect(calls.created).toHaveLength(0);
    expect(calls.updated).toHaveLength(1);
  });

  it('YAML pins the payload constants the stubs cannot see', async () => {
    const yaml = await readFile(ENSURE, 'utf8');
    const parsed = parseYamlDocument(yaml);
    expect(parsed.errors.filter((e) => e.severity === 'error')).toEqual([]);
    const validated = schemaValidate(normalizeWorkflowDocument(parsed.document));
    expect(validated.ok).toBe(true);
    expect(yaml).toContain('metadataKey: finding_key');
    expect(yaml).toContain('createdBy: "agent:security-assessment"');
    expect(yaml).toContain('workflow_type: "security-assessment"');
  });
});

/** v2: an APP row (newest active deployment per application), not a scope row. */
const APP_ROW = {
  application_id: '9',
  application: 'app-a',
  repository_url: 'https://github.com/nullplatform/app-a',
  deployment_id: '901',
  scope_id: '111',
  scope_name: 'Production',
  scope_nrn: 'organization=4:account=17:namespace=3:application=9:scope=111',
  environment: 'production',
  deployed_at: '2026-08-01 10:00:00',
};

const AGENT_FINDINGS = [
  {
    rule_id: 'hardcoded-secret',
    title: 'AWS key committed in src/config.ts',
    severity: 'high',
    file: 'src/config.ts',
    evidence: 'line 12: const AWS_KEY = "AKIA..."',
    recommendation: 'Move to a config entry secret.',
  },
  {
    rule_id: 'weak-crypto',
    title: 'MD5 used for password hashing',
    severity: 'critical',
    file: 'src/auth/hash.ts',
    evidence: 'crypto.createHash("md5") on user passwords',
    recommendation: 'Use bcrypt/argon2.',
  },
  {
    rule_id: 'debug-flag',
    title: 'DEBUG=true in production config',
    severity: 'low',
    file: 'config/prod.env',
    evidence: 'DEBUG=true',
    recommendation: 'Disable debug in production.',
  },
];

/** The open item wf3 would have created for AGENT_FINDINGS[0]. */
const OPEN_HARDCODED_SECRET = {
  id: 'ai_open_1',
  title: '[high] AWS key committed in src/config.ts (app-a / Production)',
  metadata: {
    finding_key: 'sec:9:hardcoded-secret-src-config-ts',
    application_id: '9',
    rule_id: 'hardcoded-secret',
    file: 'src/config.ts',
    severity: 'high',
    commit: 'OLDSHA',
  },
};

/**
 * An open item from ANOTHER detector that also tags `application_id`. The
 * metadata search mode of np-action-item-find is category-blind, so this DOES
 * come back from find_open — pack_open must drop it (no `sec:<app>:` key) so
 * it never reaches the agent and can never be closed by this workflow.
 */
const OPEN_FOREIGN_ITEM = {
  id: 'ai_cost_7',
  title: 'Overprovisioned scope',
  metadata: { finding_key: 'cost:9:overprovisioned-scope', application_id: '9' },
};

function buildContextStub(opts: { repoUrl?: string; commitSha?: string; fail?: boolean } = {}) {
  return {
    handler: () => {
      if (opts.fail) throw new Error('build-context exploded');
      return ok({
        scope: {
          type: 'web_pool',
          provider: 'k8s',
          visibility: 'private',
          parameters: { API_KEY: 'x' },
        },
        deployment: { id: '901', build_id: 'b1' },
        application: {
          repository_url: opts.repoUrl ?? 'https://github.com/nullplatform/app-a',
        },
        build: { commit_sha: opts.commitSha ?? 'abc123' },
        release: {},
        asset: {},
      });
    },
    executeMode: 'all' as const,
  };
}

interface AssessOpts {
  inputs?: Record<string, unknown>;
  /** Prior `security_assessment` metadata; omitted/null = never assessed. */
  priorState?: Record<string, unknown> | null;
  /** HTTP status the read_state GET returns (default 200). */
  readStatus?: number;
  /** Make the read_state call explode at transport level. */
  readStateFails?: boolean;
  /** Make the state PATCH explode at transport level (after its retries). */
  writeStateFails?: boolean;
  /** HTTP status the state PATCH returns (default 200; 404 → the POST fires). */
  patchStatus?: number;
  /** HTTP status the follow-up POST returns (default 200). */
  postStatus?: number;
  /** Make the follow-up POST explode at transport level. */
  postStateFails?: boolean;
  /** Index of the ensure_items child that fails (simulates a wf3 blowing up). */
  ensureFailAt?: number;
  agentFindings?: Record<string, unknown>[] | 'FAIL';
  agentResolved?: Record<string, unknown>[];
  openItems?: Record<string, unknown>[];
  repoUrl?: string;
  commitSha?: string;
  buildContextFails?: boolean;
}

async function runAssess(opts: AssessOpts) {
  const ensureCalls: Record<string, unknown>[] = [];
  const closeCalls: Record<string, unknown>[] = [];
  const agentCalls: Record<string, unknown>[] = [];
  /** Every state write, PATCH or POST — for the "nothing was written" assertions. */
  const writeCalls: Record<string, unknown>[] = [];
  const patchCalls: Record<string, unknown>[] = [];
  const postCalls: Record<string, unknown>[] = [];
  const readCalls: Record<string, unknown>[] = [];
  const findCalls: Record<string, unknown>[] = [];
  const openItems = opts.openItems ?? [];
  const repoUrl = opts.repoUrl ?? APP_ROW.repository_url;
  const result = await runWorkflowE2E({
    yamlPath: ASSESS,
    inputs: {
      deployment: { ...APP_ROW, repository_url: repoUrl },
      category_slug: 'security',
      organization_id: '4',
      ...(opts.inputs ?? {}),
    },
    pluginStubs: {
      manual: passthroughTrigger,
      'np-build-context': buildContextStub({
        repoUrl,
        ...(opts.commitSha !== undefined ? { commitSha: opts.commitSha } : {}),
        ...(opts.buildContextFails === true ? { fail: true } : {}),
      }),
      // One stub, two steps — dispatched on ctx.stepId (plugin `config:` is
      // invisible to a stub, so the write payload rides on declared step
      // `inputs:` and that is what the stub records).
      'np-api-call': {
        handler: (ctx: { stepId: string; inputs: Record<string, unknown> }) => {
          if (ctx.stepId === 'read_state') {
            readCalls.push(ctx.inputs);
            if (opts.readStateFails === true) throw new Error('metadata read exploded');
            const status = opts.readStatus ?? 200;
            const body =
              opts.priorState != null
                ? { security_assessment: opts.priorState, additional_properties: { id: '9' } }
                : { additional_properties: { id: '9' } };
            return ok({ status, body, headers: {} });
          }
          writeCalls.push(ctx.inputs);
          if (ctx.stepId === 'write_state_post') {
            postCalls.push(ctx.inputs);
            if (opts.postStateFails === true) throw new Error('metadata POST exploded');
            return ok({ status: opts.postStatus ?? 200, body: {}, headers: {} });
          }
          patchCalls.push(ctx.inputs);
          if (opts.writeStateFails === true) throw new Error('metadata PATCH exploded');
          return ok({ status: opts.patchStatus ?? 200, body: {}, headers: {} });
        },
        executeMode: 'all' as const,
      },
      'np-action-item-find': {
        handler: (ctx: { inputs: Record<string, unknown> }) => {
          findCalls.push(ctx.inputs);
          return ok({
            count: openItems.length,
            items: openItems,
            firstMatch: openItems[0] ?? null,
          });
        },
        executeMode: 'all' as const,
      },
      'claude-code-agent': {
        handler: (ctx: { inputs: Record<string, unknown> }) => {
          agentCalls.push(ctx.inputs);
          if (opts.agentFindings === 'FAIL') throw new Error('agent exploded');
          return ok({
            findings: opts.agentFindings ?? AGENT_FINDINGS,
            resolved: opts.agentResolved ?? [],
            summary: 'assessed',
            repo: APP_ROW.repository_url,
            commit: 'abc123',
            mode: ctx.inputs.mode,
          });
        },
        executeMode: 'all' as const,
      },
      'sub-workflow': {
        handler: (ctx: { stepId: string; inputs: Record<string, unknown> }) => {
          if (ctx.stepId === 'close_items') {
            closeCalls.push(ctx.inputs);
            return ok({ action: 'closed', action_item_id: `ai_closed_${closeCalls.length}` });
          }
          ensureCalls.push(ctx.inputs);
          // A failed forEach child settles as an EMPTY slot and the fan-out
          // still reports success — the exact shape finalize has to detect.
          if (opts.ensureFailAt === ensureCalls.length - 1) {
            return {
              status: 'failure' as const,
              error: { message: 'wf3 blew up', code: 'CHILD_FAILED', retryable: false },
            };
          }
          return ok({ action: 'created', action_item_id: `ai_${ensureCalls.length}` });
        },
        executeMode: 'all' as const,
      },
    },
  });
  return {
    result,
    ensureCalls,
    closeCalls,
    agentCalls,
    writeCalls,
    patchCalls,
    postCalls,
    readCalls,
    findCalls,
  };
}

describe('wf2-assess-application (E2E)', () => {
  it('first run (no baseline): forces a full assessment and creates the state via PATCH-404 → POST', async () => {
    const { result, ensureCalls, patchCalls, postCalls, agentCalls } = await runAssess({
      priorState: null,
      patchStatus: 404, // no metadata row for this app yet
    });
    // default min_severity medium: the 'low' finding is dropped
    expect(result.outputs.status).toBe('assessed');
    expect(result.outputs.mode).toBe('full');
    expect(result.outputs.total_findings).toBe(2);
    expect(result.outputs.created).toBe(2);
    expect(result.outputs.closed).toBe(0);
    expect(ensureCalls).toHaveLength(2);

    const finding = ensureCalls[0]!.finding as Record<string, unknown>;
    // App-scoped key (v2) — no scope_id in it.
    expect(finding.finding_key).toBe('sec:9:hardcoded-secret-src-config-ts');
    expect(finding.priority).toBe('high');
    expect(finding.value).toBe(300);
    const meta = finding.metadata as Record<string, string>;
    expect(meta.commit).toBe('abc123');
    expect(meta.application_id).toBe('9');
    expect(Object.values(meta).every((v) => typeof v === 'string')).toBe(true);

    // The agent is told it is a full run and has no baseline to diff from.
    expect(agentCalls[0]!.mode).toBe('full');
    expect(agentCalls[0]!.last_commit).toBe('');

    // PATCH is always attempted first (it can only ever touch OUR key); the
    // 404 is what proves the row has to be created, and only then does the
    // POST fire. Both carry the identical state.
    expect(patchCalls).toHaveLength(1);
    expect(postCalls).toHaveLength(1);
    expect(result.outputs.reason).toBe('');
    const state = postCalls[0]!.state as Record<string, string>;
    expect(state.last_commit).toBe('abc123');
    expect(state.last_mode).toBe('full');
    expect(state.last_full_at).toBe(state.last_run_at);
    expect(patchCalls[0]!.state).toEqual(state);
  });

  it('delta run on an unchanged commit: skips without assessing or writing anything', async () => {
    const { result, ensureCalls, closeCalls, agentCalls, writeCalls } = await runAssess({
      priorState: {
        last_commit: 'abc123',
        last_run_at: '2026-08-01T00:00:00Z',
        last_full_at: '2026-07-01T00:00:00Z',
      },
    });
    expect(result.outputs.status).toBe('skipped');
    expect(result.outputs.reason).toBe('no_change');
    expect(result.outputs.mode).toBe('delta');
    expect(agentCalls).toHaveLength(0);
    expect(ensureCalls).toHaveLength(0);
    expect(closeCalls).toHaveLength(0);
    // No metadata write on a skip — the baseline stays exactly as it was.
    expect(writeCalls).toHaveLength(0);
  });

  it('delta run on a new commit: creates the new finding, closes the resolved one, preserves last_full_at', async () => {
    const { result, ensureCalls, closeCalls, agentCalls, patchCalls, postCalls } = await runAssess({
      priorState: {
        last_commit: 'OLDSHA',
        last_run_at: '2026-08-01T00:00:00Z',
        last_full_at: '2026-07-01T00:00:00Z',
      },
      openItems: [OPEN_HARDCODED_SECRET, OPEN_FOREIGN_ITEM],
      // The agent found the weak-crypto issue and verified the hardcoded
      // secret is gone. It also claims a key that was never open.
      agentFindings: [AGENT_FINDINGS[1]!],
      agentResolved: [
        {
          finding_key: 'sec:9:hardcoded-secret-src-config-ts',
          evidence: 'src/config.ts now reads process.env',
        },
        { finding_key: 'sec:9:invented-by-the-agent', evidence: 'hallucinated' },
      ],
    });

    expect(result.outputs.status).toBe('assessed');
    expect(result.outputs.mode).toBe('delta');
    expect(result.outputs.total_findings).toBe(1);
    expect(result.outputs.created).toBe(1);
    expect(result.outputs.closed).toBe(1);

    // The agent sees the baseline and ONLY this app's security findings —
    // the cost item that also carries application_id is filtered out.
    expect(agentCalls[0]!.mode).toBe('delta');
    expect(agentCalls[0]!.last_commit).toBe('OLDSHA');
    expect(agentCalls[0]!.current_commit).toBe('abc123');
    const seen = JSON.parse(String(agentCalls[0]!.open_findings_json)) as Array<
      Record<string, string>
    >;
    expect(seen.map((f) => f.finding_key)).toEqual(['sec:9:hardcoded-secret-src-config-ts']);

    expect((ensureCalls[0]!.finding as Record<string, unknown>).finding_key).toBe(
      'sec:9:weak-crypto-src-auth-hash-ts',
    );

    // Exactly one close, for the key that WAS open. The invented key is
    // dropped by the intersection, never handed to wf4.
    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0]!.finding_key).toBe('sec:9:hardcoded-secret-src-config-ts');
    expect(closeCalls[0]!.evidence).toBe('src/config.ts now reads process.env');
    expect(closeCalls[0]!.commit).toBe('abc123');
    expect(closeCalls[0]!.organization_id).toBe('4');

    // Row exists → the PATCH succeeds and no POST is ever attempted. PATCH
    // replaces the whole value, so the delta run must carry the prior
    // last_full_at forward.
    expect(patchCalls).toHaveLength(1);
    expect(postCalls).toHaveLength(0);
    const state = patchCalls[0]!.state as Record<string, string>;
    expect(state.last_commit).toBe('abc123');
    expect(state.last_full_at).toBe('2026-07-01T00:00:00Z');
    expect(state.last_mode).toBe('delta');
  });

  it('delta run with a clean diff: no items touched, but the new commit IS recorded', async () => {
    // The common case once an app is healthy — nothing to create, nothing to
    // close, and the baseline must still move forward or every later run
    // re-diffs from the same stale commit.
    const { result, ensureCalls, closeCalls, writeCalls } = await runAssess({
      priorState: {
        last_commit: 'OLDSHA',
        last_run_at: '2026-08-01T00:00:00Z',
        last_full_at: '2026-07-01T00:00:00Z',
      },
      openItems: [OPEN_HARDCODED_SECRET],
      agentFindings: [],
      agentResolved: [],
    });
    expect(result.outputs.status).toBe('assessed');
    expect(result.outputs.total_findings).toBe(0);
    expect(result.outputs.created).toBe(0);
    expect(result.outputs.closed).toBe(0);
    expect(ensureCalls).toHaveLength(0);
    expect(closeCalls).toHaveLength(0);
    expect(writeCalls).toHaveLength(1);
    expect((writeCalls[0]!.state as Record<string, string>).last_commit).toBe('abc123');
  });

  it('never closes a finding the agent also re-reported as live', async () => {
    const { result, closeCalls } = await runAssess({
      priorState: {
        last_commit: 'OLDSHA',
        last_run_at: '2026-08-01T00:00:00Z',
        last_full_at: '2026-07-01T00:00:00Z',
      },
      openItems: [OPEN_HARDCODED_SECRET],
      agentFindings: [AGENT_FINDINGS[0]!], // same rule_id+file as the open item
      agentResolved: [
        { finding_key: 'sec:9:hardcoded-secret-src-config-ts', evidence: 'contradicts itself' },
      ],
    });
    expect(result.outputs.closed).toBe(0);
    expect(closeCalls).toHaveLength(0);
  });

  it('mode=full forces an assessment even when the commit is unchanged', async () => {
    const { result, agentCalls, patchCalls, postCalls } = await runAssess({
      inputs: { mode: 'full' },
      priorState: {
        last_commit: 'abc123',
        last_run_at: '2026-08-01T00:00:00Z',
        last_full_at: '2026-07-01T00:00:00Z',
      },
    });
    expect(result.outputs.status).toBe('assessed');
    expect(result.outputs.mode).toBe('full');
    expect(agentCalls[0]!.mode).toBe('full');
    expect(patchCalls).toHaveLength(1);
    expect(postCalls).toHaveLength(0);
    const state = patchCalls[0]!.state as Record<string, string>;
    // A full run refreshes last_full_at instead of preserving it.
    expect(state.last_full_at).not.toBe('2026-07-01T00:00:00Z');
    expect(state.last_full_at).toBe(state.last_run_at);
  });

  it('honors min_severity=low (keeps all three)', async () => {
    const { result } = await runAssess({ priorState: null, inputs: { min_severity: 'low' } });
    expect(result.outputs.total_findings).toBe(3);
  });

  it('dedupes agent findings with identical rule_id+file (first wins)', async () => {
    const dup = [...AGENT_FINDINGS.slice(0, 1), ...AGENT_FINDINGS.slice(0, 1)];
    const { result } = await runAssess({ priorState: null, agentFindings: dup });
    expect(result.outputs.total_findings).toBe(1);
  });

  it('skips when the application has no repository_url', async () => {
    const { result, ensureCalls, closeCalls, writeCalls } = await runAssess({ repoUrl: '' });
    expect(result.outputs.status).toBe('skipped');
    expect(result.outputs.reason).toBe('no_repo');
    expect(ensureCalls).toHaveLength(0);
    expect(closeCalls).toHaveLength(0);
    expect(writeCalls).toHaveLength(0);
  });

  it('completes with status failed when the agent fails (never propagates)', async () => {
    const { result, ensureCalls, closeCalls, writeCalls } = await runAssess({
      priorState: null,
      agentFindings: 'FAIL',
    });
    expect(result.outputs.status).toBe('failed');
    expect(result.outputs.reason).toBe('agent_failed');
    expect(ensureCalls).toHaveLength(0);
    expect(closeCalls).toHaveLength(0);
    expect(writeCalls).toHaveLength(0);
  });

  it('completes with status failed when build-context fails (never propagates)', async () => {
    const { result, ensureCalls, writeCalls } = await runAssess({ buildContextFails: true });
    expect(result.outputs.status).toBe('failed');
    expect(result.outputs.reason).toBe('build_context_failed');
    expect(ensureCalls).toHaveLength(0);
    expect(writeCalls).toHaveLength(0);
  });

  it('holds the baseline when an ensure child fails, so the next run re-derives the lost finding', async () => {
    // A failed forEach child settles as an empty slot and the fan-out still
    // reports success. If the baseline advanced here, the next delta run
    // would skip on "no change" and the finding would be silently lost until
    // someone ran mode:full.
    const { result, ensureCalls, writeCalls } = await runAssess({
      priorState: {
        last_commit: 'OLDSHA',
        last_run_at: '2026-08-01T00:00:00Z',
        last_full_at: '2026-07-01T00:00:00Z',
      },
      ensureFailAt: 1,
    });
    expect(result.outputs.status).toBe('assessed');
    expect(result.outputs.reason).toBe('items_incomplete');
    // Counts stay REAL: 2 findings, only 1 of them settled.
    expect(result.outputs.total_findings).toBe(2);
    expect(result.outputs.created).toBe(1);
    expect(ensureCalls).toHaveLength(2);
    // Neither write is attempted — the whole chain is short-circuited.
    expect(writeCalls).toHaveLength(0);
  });

  it('advances the baseline normally when every ensure child settles', async () => {
    const { result, writeCalls } = await runAssess({
      priorState: {
        last_commit: 'OLDSHA',
        last_run_at: '2026-08-01T00:00:00Z',
        last_full_at: '2026-07-01T00:00:00Z',
      },
    });
    expect(result.outputs.status).toBe('assessed');
    expect(result.outputs.reason).toBe('');
    expect(result.outputs.created).toBe(2);
    expect(writeCalls).toHaveLength(1);
  });

  it('reports state_not_persisted when the row has to be created and the POST fails', async () => {
    const { result, patchCalls, postCalls } = await runAssess({
      priorState: null,
      patchStatus: 404,
      postStateFails: true,
    });
    expect(patchCalls).toHaveLength(1);
    // The POST's own retry budget is spent (3 attempts) before the fallback.
    expect(postCalls).toHaveLength(3);
    expect(result.outputs.status).toBe('assessed');
    expect(result.outputs.reason).toBe('state_not_persisted');
    expect(result.outputs.created).toBe(2);
  });

  it('reports state_not_persisted when the created row POSTs a non-2xx', async () => {
    const { result } = await runAssess({ priorState: null, patchStatus: 404, postStatus: 500 });
    expect(result.outputs.status).toBe('assessed');
    expect(result.outputs.reason).toBe('state_not_persisted');
  });

  it('keeps status assessed (with the real counts) when the state WRITE explodes', async () => {
    // The creates and closes already happened by the time the state write chain runs —
    // reporting this as "failed" would tell the scanner an assessment that
    // did land its side effects did not. The only real consequence is that
    // the next run re-derives from the older baseline.
    const { result, ensureCalls, closeCalls } = await runAssess({
      priorState: {
        last_commit: 'OLDSHA',
        last_run_at: '2026-08-01T00:00:00Z',
        last_full_at: '2026-07-01T00:00:00Z',
      },
      openItems: [OPEN_HARDCODED_SECRET],
      agentFindings: [AGENT_FINDINGS[1]!],
      agentResolved: [{ finding_key: 'sec:9:hardcoded-secret-src-config-ts', evidence: 'gone' }],
      writeStateFails: true,
    });
    expect(result.outputs.status).toBe('assessed');
    expect(result.outputs.reason).toBe('state_not_persisted');
    expect(result.outputs.created).toBe(1);
    expect(result.outputs.closed).toBe(1);
    expect(ensureCalls).toHaveLength(1);
    expect(closeCalls).toHaveLength(1);
  });

  it('flags a non-2xx state write the same way, without failing the assessment', async () => {
    const { result } = await runAssess({ priorState: null, patchStatus: 500 });
    expect(result.outputs.status).toBe('assessed');
    expect(result.outputs.reason).toBe('state_not_persisted');
    expect(result.outputs.created).toBe(2);
  });

  it('sends a STRING metadataValue to find_open even when application_id is numeric', async () => {
    // np-action-item-find only enters metadata-search mode when metadataValue
    // is typeof 'string'; a number silently degrades it to list mode (every
    // open item in the org, first page) and closes stop happening. The value
    // is sourced from extract_repo's String()-coerced application_id, so it
    // cannot depend on the scanner's lake query doing a toString().
    const { result, findCalls, ensureCalls } = await runAssess({
      priorState: null,
      inputs: { deployment: { ...APP_ROW, application_id: 9 } },
    });
    expect(findCalls).toHaveLength(1);
    expect(findCalls[0]!.application_id).toBe('9');
    expect(typeof findCalls[0]!.application_id).toBe('string');
    // …and the key stays app-scoped and identical to the string-id case.
    expect((ensureCalls[0]!.finding as Record<string, unknown>).finding_key).toBe(
      'sec:9:hardcoded-secret-src-config-ts',
    );
    expect(result.outputs.status).toBe('assessed');
  });

  it('completes with status failed when the state read explodes (never propagates)', async () => {
    const { result, ensureCalls, writeCalls } = await runAssess({ readStateFails: true });
    expect(result.outputs.status).toBe('failed');
    expect(result.outputs.reason).toBe('read_state_failed');
    expect(ensureCalls).toHaveLength(0);
    expect(writeCalls).toHaveLength(0);
  });

  it('treats a non-2xx metadata read as "no baseline" rather than a failure', async () => {
    const { result, agentCalls, writeCalls } = await runAssess({
      priorState: null,
      readStatus: 404,
    });
    expect(result.outputs.status).toBe('assessed');
    expect(result.outputs.mode).toBe('full');
    expect(agentCalls[0]!.last_commit).toBe('');
    expect(writeCalls).toHaveLength(1);
    expect(result.outputs.reason).toBe('');
  });

  it('YAML pins the contracts the stubs cannot see', async () => {
    const yaml = await readFile(ASSESS, 'utf8');
    const parsed = parseYamlDocument(yaml);
    expect(parsed.errors.filter((e) => e.severity === 'error')).toEqual([]);
    const validated = schemaValidate(normalizeWorkflowDocument(parsed.document));
    expect(validated.ok).toBe(true);
    expect(yaml).toContain('id: security_assess_application');
    expect(yaml).toContain('GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}"');
    expect(yaml).toContain('blockSubprocess: false');
    expect(yaml).toContain('workflowId: security_ensure_action_item');
    expect(yaml).toContain('workflowId: security_close_finding');
    expect(yaml).toContain('model: "${{ vars.SEC_AGENT_MODEL || \'claude-opus-5\' }}"');
    // Metadata endpoints (API-CONTRACTS.md §1).
    expect(yaml).toContain('path: "/metadata/application/${{ inputs.application_id }}"');
    // metadataValue must come from the String()-coerced step output, never
    // straight from the app row (a number degrades the plugin to list mode).
    expect(yaml).toContain('metadataValue: "${{ inputs.application_id }}"');
    // Counting precedes the state write so the write-failure resolver has
    // the real counts to report.
    expect(yaml.indexOf('id: finalize\n')).toBeLessThan(yaml.indexOf('id: write_state_patch\n'));
    // PATCH is attempted before POST: POST on a row holding another team's
    // metadata could replace it, PATCH can only ever touch our own key.
    expect(yaml.indexOf('id: write_state_patch\n')).toBeLessThan(
      yaml.indexOf('id: write_state_post\n'),
    );
    expect(yaml).toContain('expression: "steps.write_state_patch.outputs.status == 404"');
    // The close fan-out explodes {finding_key, evidence} into wf4's inputs —
    // the forEach `inputs:` block resolves once, so `$item` is unavailable there.
    expect(yaml).toContain('spread_item: true');
    // Agent prompts must use inputs.*, never ${{ steps.* }} (arrives as "undefined").
    const promptBlock = yaml.slice(
      yaml.indexOf('systemPrompt:'),
      yaml.indexOf('env:\n        GITHUB_TOKEN'),
    );
    expect(promptBlock).not.toContain('${{ steps.');
    // Prompt-injection guard: the agent reads adversarial repo content and its
    // resolved[] verdicts close real action items, so repo content must be
    // framed as untrusted DATA and a claimed remediation must not be evidence.
    expect(promptBlock).toContain('UNTRUSTED DATA');
    expect(promptBlock).toContain('instructions you follow');
    expect(promptBlock).toContain('is NOT evidence that it was');
    expect(promptBlock).toContain('concrete code-level evidence');
    // fallback edges declared
    expect(yaml).toContain('to: resolve_ctx_failure,   condition: "false"');
    expect(yaml).toContain('to: resolve_state_failure, condition: "false"');
    expect(yaml).toContain('to: resolve_agent_failure, condition: "false"');
    expect(yaml).toContain('to: resolve_write_failure, condition: "false"');
    expect(yaml).toContain('to: resolve_post_failure,  condition: "false"');
  });
});

/** v2: one row PER APPLICATION (newest active deployment), not per scope. */
const LAKE_ROWS_SCAN = [
  {
    application_id: '9',
    application: 'grafana',
    repository_url: 'https://github.com/nullplatform/grafana',
    deployment_id: '901',
    scope_id: '111',
    scope_name: 'Production',
    scope_nrn: 'organization=4:account=17:namespace=3:application=9',
    environment: 'production',
    deployed_at: '2026-08-01 10:00:00',
  },
  {
    application_id: '10',
    application: 'Services API',
    repository_url: 'https://github.com/nullplatform/services-api',
    deployment_id: '902',
    scope_id: '222',
    scope_name: 'Production',
    scope_nrn: 'organization=4:account=17:namespace=3:application=10',
    environment: 'production',
    deployed_at: '2026-08-02 10:00:00',
  },
  {
    application_id: '11',
    application: 'other-app',
    repository_url: 'https://github.com/nullplatform/other-app',
    deployment_id: '903',
    scope_id: '333',
    scope_name: 'Stage',
    scope_nrn: 'organization=4:account=17:namespace=3:application=11',
    environment: 'development',
    deployed_at: '2026-08-03 10:00:00',
  },
];

async function runScanner(opts: {
  inputs?: Record<string, unknown>;
  rows?: Record<string, unknown>[];
}) {
  const assessCalls: Record<string, unknown>[] = [];
  const result = await runWorkflowE2E({
    yamlPath: SCANNER,
    inputs: opts.inputs ?? {},
    pluginStubs: {
      manual: passthroughTrigger,
      cron: passthroughTrigger,
      'np-lake-query': {
        handler: () =>
          ok({ rows: opts.rows ?? LAKE_ROWS_SCAN, rowCount: (opts.rows ?? LAKE_ROWS_SCAN).length }),
        executeMode: 'all' as const,
      },
      'sub-workflow': {
        handler: (ctx: { inputs: Record<string, unknown> }) => {
          assessCalls.push(ctx.inputs);
          const dep = ctx.inputs.deployment as Record<string, unknown>;
          return ok({
            status: 'assessed',
            reason: '',
            total_findings: 2,
            created: 2,
            updated: 0,
            unchanged: 0,
            closed: 0,
            application: dep.application,
            application_id: dep.application_id,
            deployment_id: dep.deployment_id,
          });
        },
        executeMode: 'all' as const,
      },
    },
  });
  return { result, assessCalls };
}

describe('wf1-security-scanner (E2E)', () => {
  it('fans out one assessment per app, appends :scope= to scope_nrn, defaults mode to delta', async () => {
    const { result, assessCalls } = await runScanner({});
    expect(assessCalls).toHaveLength(3); // one child per app row (the lake query already dedupes to newest-per-app)
    expect(result.outputs.selected).toBe(3);
    expect(result.outputs.assessed).toBe(3);
    expect(result.outputs.total_findings).toBe(6);
    expect(result.outputs.created).toBe(6);
    const dep = assessCalls[0]!.deployment as Record<string, unknown>;
    expect(dep.deployment_id).toBe('901');
    expect(dep.scope_nrn).toBe('organization=4:account=17:namespace=3:application=9:scope=111');
    expect(assessCalls[0]!.mode).toBe('delta');
    // vars unset in harness → min_severity falls back to 'medium'
    expect(assessCalls[0]!.min_severity).toBe('medium');
  });

  it('filters by the applications list (names, case-insensitive) and ids', async () => {
    const byName = await runScanner({ inputs: { applications: 'grafana, services api' } });
    expect(byName.assessCalls).toHaveLength(2);
    const byId = await runScanner({ inputs: { applications: '11' } });
    expect(byId.assessCalls).toHaveLength(1);
    expect((byId.assessCalls[0]!.deployment as Record<string, unknown>).application).toBe(
      'other-app',
    );
  });

  it('applies max_deployments and reports the dropped count (no silent cap)', async () => {
    const { result, assessCalls } = await runScanner({ inputs: { max_deployments: 1 } });
    expect(assessCalls).toHaveLength(1);
    expect(result.outputs.dropped_by_cap).toBe(2);
  });

  it('drops apps without a repository_url and counts them as skipped_no_repo', async () => {
    const rows = [
      ...LAKE_ROWS_SCAN,
      {
        application_id: '12',
        application: 'no-repo-app',
        repository_url: '',
        deployment_id: '904',
        scope_id: '444',
        scope_name: 'Production',
        scope_nrn: 'organization=4:account=17:namespace=3:application=12',
        environment: 'production',
        deployed_at: '2026-08-04 10:00:00',
      },
    ];
    const { result, assessCalls } = await runScanner({ rows });
    expect(assessCalls).toHaveLength(3);
    expect(result.outputs.skipped_no_repo).toBe(1);
    expect(result.outputs.selected).toBe(3);
  });

  it('passes mode: full through to every child', async () => {
    const { assessCalls } = await runScanner({ inputs: { mode: 'full' } });
    expect(assessCalls).toHaveLength(3);
    expect(assessCalls.every((c) => c.mode === 'full')).toBe(true);
  });

  it('aggregates assessed/skipped_no_change/closed across mixed child statuses without failing the scan', async () => {
    const rows = [
      ...LAKE_ROWS_SCAN,
      {
        application_id: '13',
        application: 'fourth-app',
        repository_url: 'https://github.com/nullplatform/fourth-app',
        deployment_id: '905',
        scope_id: '555',
        scope_name: 'Production',
        scope_nrn: 'organization=4:account=17:namespace=3:application=13',
        environment: 'production',
        deployed_at: '2026-08-05 10:00:00',
      },
    ];
    // One of each: clean assess, assess with a lost baseline write (still
    // counted as assessed, flagged separately), a no-op skip, and a failure.
    const outcomes = [
      {
        status: 'assessed',
        reason: '',
        total_findings: 1,
        created: 1,
        updated: 0,
        unchanged: 0,
        closed: 0,
      },
      {
        status: 'assessed',
        reason: 'state_not_persisted',
        total_findings: 1,
        created: 0,
        updated: 1,
        unchanged: 0,
        closed: 2,
      },
      {
        status: 'skipped',
        reason: 'no_change',
        total_findings: 0,
        created: 0,
        updated: 0,
        unchanged: 0,
        closed: 0,
      },
      {
        status: 'failed',
        reason: 'agent_failed',
        total_findings: 0,
        created: 0,
        updated: 0,
        unchanged: 0,
        closed: 0,
      },
    ];
    let i = 0;
    const result = await runWorkflowE2E({
      yamlPath: SCANNER,
      inputs: {},
      pluginStubs: {
        manual: passthroughTrigger,
        cron: passthroughTrigger,
        'np-lake-query': {
          handler: () => ok({ rows, rowCount: rows.length }),
          executeMode: 'all' as const,
        },
        'sub-workflow': {
          handler: (ctx: { inputs: Record<string, unknown> }) => {
            const outcome = outcomes[i++]!;
            const dep = ctx.inputs.deployment as Record<string, unknown>;
            return ok({
              ...outcome,
              application: dep.application,
              application_id: dep.application_id,
              deployment_id: dep.deployment_id,
            });
          },
          executeMode: 'all' as const,
        },
      },
    });
    expect(result.outputs.assessed).toBe(2);
    expect(result.outputs.skipped_no_change).toBe(1);
    expect(result.outputs.skipped_no_repo_child).toBe(0);
    expect(result.outputs.failed).toBe(1);
    expect(result.outputs.created).toBe(1);
    expect(result.outputs.updated).toBe(1);
    expect(result.outputs.closed).toBe(2);
  });
});

async function runClose(opts: {
  foundItems?: Array<Record<string, unknown>>;
  closeSkipped?: boolean;
  inputs?: Record<string, unknown>;
}) {
  const order: string[] = [];
  const calls: { close: Record<string, unknown>[]; comment: Record<string, unknown>[] } = {
    close: [],
    comment: [],
  };
  const items = opts.foundItems ?? [];
  const result = await runWorkflowE2E({
    yamlPath: CLOSE,
    inputs: {
      finding_key: 'sec:9:hardcoded-secret-src-config-ts',
      organization_id: '4',
      commit: 'def456',
      evidence: 're-scan found no matches',
      ...(opts.inputs ?? {}),
    },
    pluginStubs: {
      manual: passthroughTrigger,
      'np-action-item-find': {
        handler: () => ok({ count: items.length, items, firstMatch: items[0] ?? null }),
        executeMode: 'all' as const,
      },
      'np-action-item-update': {
        handler: (ctx: { inputs: Record<string, unknown> }) => {
          calls.close.push(ctx.inputs);
          order.push('close');
          return ok({
            actionItem: opts.closeSkipped ? null : { id: ctx.inputs.actionItemId },
            status: opts.closeSkipped ? 'open' : 'closed',
            skipped: opts.closeSkipped ?? false,
          });
        },
        executeMode: 'all' as const,
      },
      'np-action-item-add-comment': {
        handler: (ctx: { inputs: Record<string, unknown> }) => {
          calls.comment.push(ctx.inputs);
          order.push('comment');
          return ok({ commentId: 'c1' });
        },
        executeMode: 'all' as const,
      },
    },
  });
  return { result, calls, order };
}

describe('wf4-close-resolved-finding (E2E)', () => {
  it('closes then comments when a live open item matches the finding_key', async () => {
    const { result, calls, order } = await runClose({
      foundItems: [{ id: 'ai_open', status: 'open', metadata: { commit: 'abc123' } }],
    });
    expect(result.outputs.action).toBe('closed');
    expect(result.outputs.action_item_id).toBe('ai_open');
    expect(calls.close).toHaveLength(1);
    expect(calls.comment).toHaveLength(1);
    // Ordering decision (see wf4 YAML header + API-CONTRACTS.md §2): close
    // FIRST, then comment — the ami-drift v2.2 idiom, not comment-then-close.
    // (Plugin `config:` — actionItemId/action/actor — isn't visible on the
    // stub's ctx.inputs, same as wf3's create_item/update_item stubs: the
    // np-* plugins merge resolvedConfig in their own `configure()`, which
    // these stubs deliberately skip. Order and call counts are what a stub
    // at this boundary can observe; the resolved actionItemId is verified
    // indirectly via `result.outputs.action_item_id` below.)
    expect(order).toEqual(['close', 'comment']);
  });

  it('no-ops to not_found when no live item matches, calling neither close nor comment', async () => {
    const { result, calls } = await runClose({ foundItems: [] });
    expect(result.outputs.action).toBe('not_found');
    expect(result.outputs.action_item_id).toBeNull();
    expect(calls.close).toHaveLength(0);
    expect(calls.comment).toHaveLength(0);
  });

  it('skips the comment when close no-ops (already closed by a prior run)', async () => {
    const { result, calls } = await runClose({
      foundItems: [{ id: 'ai_open', status: 'open', metadata: { commit: 'abc123' } }],
      closeSkipped: true,
    });
    expect(result.outputs.action).toBe('closed');
    expect(result.outputs.action_item_id).toBe('ai_open');
    expect(calls.close).toHaveLength(1);
    expect(calls.comment).toHaveLength(0);
  });

  it('YAML pins the close ordering and idempotency contract the stubs cannot see', async () => {
    const yaml = await readFile(CLOSE, 'utf8');
    const parsed = parseYamlDocument(yaml);
    expect(parsed.errors.filter((e) => e.severity === 'error')).toEqual([]);
    const validated = schemaValidate(normalizeWorkflowDocument(parsed.document));
    expect(validated.ok).toBe(true);
    expect(yaml).toContain('metadataKey: finding_key');
    expect(yaml).toContain('action: close');
    expect(yaml).toContain('ignoreInvalidTransition: true');
    expect(yaml).toContain('actor: "workflow:security-assessment"');
    // close must be wired before comment (ordering decision), not after.
    expect(yaml.indexOf('id: close\n')).toBeLessThan(yaml.indexOf('id: comment\n'));
  });
});
