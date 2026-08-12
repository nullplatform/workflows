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

const ENSURE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'wf3-ensure-security-action-item.yaml');
const ASSESS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'wf2-assess-deployment.yaml');
const SCANNER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'wf1-security-scanner.yaml');

const ok = (outputs: Record<string, unknown>): IStepResult => ({
  status: 'success',
  outputs,
  activePorts: ['default'],
});

const passthroughTrigger = { handler: () => ok({}), registryType: 'trigger' as const };

const FINDING = {
  finding_key: 'sec:111:hardcoded-secret-src-config-ts',
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
    finding_key: 'sec:111:hardcoded-secret-src-config-ts',
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

const DEPLOYMENT_ROW = {
  deployment_id: '901',
  scope_id: '111',
  scope_name: 'Production',
  scope_nrn: 'organization=4:account=17:namespace=3:application=9:scope=111',
  application: 'app-a',
  application_id: '9',
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

function buildContextStub(opts: { repoUrl?: string; commitSha?: string; fail?: boolean } = {}) {
  return {
    handler: () => {
      if (opts.fail) throw new Error('build-context exploded');
      return ok({
        scope: { type: 'web_pool', provider: 'k8s', visibility: 'private', parameters: { API_KEY: 'x' } },
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

async function runAssess(opts: {
  inputs?: Record<string, unknown>;
  agentFindings?: Record<string, unknown>[] | 'FAIL';
  repoUrl?: string;
  buildContextFails?: boolean;
}) {
  const ensureCalls: Record<string, unknown>[] = [];
  const result = await runWorkflowE2E({
    yamlPath: ASSESS,
    inputs: {
      deployment: DEPLOYMENT_ROW,
      category_slug: 'security',
      organization_id: '4',
      ...(opts.inputs ?? {}),
    },
    pluginStubs: {
      manual: passthroughTrigger,
      'np-build-context': buildContextStub({ repoUrl: opts.repoUrl, fail: opts.buildContextFails }),
      'claude-code-agent': {
        handler: () => {
          if (opts.agentFindings === 'FAIL') throw new Error('agent exploded');
          return ok({
            findings: opts.agentFindings ?? AGENT_FINDINGS,
            summary: 'assessed',
            repo: 'https://github.com/nullplatform/app-a',
            commit: 'abc123',
          });
        },
        executeMode: 'all' as const,
      },
      'sub-workflow': {
        handler: (ctx: { inputs: Record<string, unknown> }) => {
          ensureCalls.push(ctx.inputs);
          return ok({ action: 'created', action_item_id: `ai_${ensureCalls.length}` });
        },
        executeMode: 'all' as const,
      },
    },
  });
  return { result, ensureCalls };
}

describe('wf2-assess-deployment (E2E)', () => {
  it('normalizes agent findings, filters by min severity, fans out ensure per finding', async () => {
    const { result, ensureCalls } = await runAssess({});
    // default min_severity medium: the 'low' finding is dropped
    expect(result.outputs.status).toBe('assessed');
    expect(result.outputs.total_findings).toBe(2);
    expect(result.outputs.created).toBe(2);
    expect(ensureCalls).toHaveLength(2);
    const finding = ensureCalls[0]!.finding as Record<string, unknown>;
    expect(finding.finding_key).toBe('sec:111:hardcoded-secret-src-config-ts');
    expect(finding.priority).toBe('high');
    expect(finding.value).toBe(300);
    const meta = finding.metadata as Record<string, string>;
    expect(meta.commit).toBe('abc123');
    expect(Object.values(meta).every((v) => typeof v === 'string')).toBe(true);
  });

  it('honors min_severity=low (keeps all three)', async () => {
    const { result } = await runAssess({ inputs: { min_severity: 'low' } });
    expect(result.outputs.total_findings).toBe(3);
  });

  it('skips when the application has no repository_url', async () => {
    const { result, ensureCalls } = await runAssess({ repoUrl: '' });
    expect(result.outputs.status).toBe('skipped');
    expect(result.outputs.reason).toBe('no_repo');
    expect(ensureCalls).toHaveLength(0);
  });

  it('completes with status failed when the agent fails (never propagates)', async () => {
    const { result, ensureCalls } = await runAssess({ agentFindings: 'FAIL' });
    expect(result.outputs.status).toBe('failed');
    expect(result.outputs.reason).toBe('agent_failed');
    expect(ensureCalls).toHaveLength(0);
  });

  it('completes with status failed when build-context fails (never propagates)', async () => {
    const { result, ensureCalls } = await runAssess({ buildContextFails: true });
    expect(result.outputs.status).toBe('failed');
    expect(result.outputs.reason).toBe('build_context_failed');
    expect(ensureCalls).toHaveLength(0);
  });

  it('dedupes agent findings with identical rule_id+file (first wins)', async () => {
    const dup = [...AGENT_FINDINGS.slice(0, 1), ...AGENT_FINDINGS.slice(0, 1)];
    const { result } = await runAssess({ agentFindings: dup });
    expect(result.outputs.total_findings).toBe(1);
  });

  it('YAML pins the agent guardrails the stubs cannot see', async () => {
    const yaml = await readFile(ASSESS, 'utf8');
    expect(yaml).toContain('GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}"');
    expect(yaml).toContain('blockSubprocess: false');
    expect(yaml).toContain('workflowId: security_ensure_action_item');
    expect(yaml).not.toContain('${{ steps.'.concat('extract_repo.outputs.repo }}"\n      userPrompt')); // prompts must use inputs.*
    // fallback edges declared
    expect(yaml).toContain('to: resolve_ctx_failure,   condition: "false"');
    expect(yaml).toContain('to: resolve_agent_failure, condition: "false"');
  });
});

const LAKE_ROWS_SCAN = [
  { deployment_id: '901', scope_id: '111', scope_name: 'Prod', scope_nrn: 'organization=4:account=17:namespace=3:application=9', application: 'grafana', application_id: '9', deployed_at: '2026-08-01 10:00:00', environment: 'production' },
  { deployment_id: '902', scope_id: '222', scope_name: 'Prod', scope_nrn: 'organization=4:account=17:namespace=3:application=10', application: 'Services API', application_id: '10', deployed_at: '2026-08-02 10:00:00', environment: 'production' },
  { deployment_id: '903', scope_id: '333', scope_name: 'Stage', scope_nrn: 'organization=4:account=17:namespace=3:application=11', application: 'other-app', application_id: '11', deployed_at: '2026-08-03 10:00:00', environment: 'development' },
  // same scope as 901, older deployment — must be deduped away
  { deployment_id: '800', scope_id: '111', scope_name: 'Prod', scope_nrn: 'organization=4:account=17:namespace=3:application=9', application: 'grafana', application_id: '9', deployed_at: '2026-07-01 10:00:00', environment: 'production' },
];

async function runScanner(opts: { inputs?: Record<string, unknown>; rows?: Record<string, unknown>[] }) {
  const assessCalls: Record<string, unknown>[] = [];
  const result = await runWorkflowE2E({
    yamlPath: SCANNER,
    inputs: opts.inputs ?? {},
    pluginStubs: {
      manual: passthroughTrigger,
      cron: passthroughTrigger,
      'np-lake-query': {
        handler: () => ok({ rows: opts.rows ?? LAKE_ROWS_SCAN, rowCount: (opts.rows ?? LAKE_ROWS_SCAN).length }),
        executeMode: 'all' as const,
      },
      'sub-workflow': {
        handler: (ctx: { inputs: Record<string, unknown> }) => {
          assessCalls.push(ctx.inputs);
          return ok({
            status: 'assessed', reason: '', total_findings: 2, created: 2, updated: 0, unchanged: 0,
            application: (ctx.inputs.deployment as Record<string, unknown>).application,
            deployment_id: (ctx.inputs.deployment as Record<string, unknown>).deployment_id,
          });
        },
        executeMode: 'all' as const,
      },
    },
  });
  return { result, assessCalls };
}

describe('wf1-security-scanner (E2E)', () => {
  it('dedupes per scope, assesses every unique deployment, aggregates counts', async () => {
    const { result, assessCalls } = await runScanner({});
    expect(assessCalls).toHaveLength(3); // 4 rows, one scope duplicated
    expect(result.outputs.selected).toBe(3);
    expect(result.outputs.assessed).toBe(3);
    expect(result.outputs.total_findings).toBe(6);
    expect(result.outputs.created).toBe(6);
    const dep = assessCalls[0]!.deployment as Record<string, unknown>;
    expect(dep.deployment_id).toBe('901'); // newest kept, ':scope=' appended
    expect(dep.scope_nrn).toBe('organization=4:account=17:namespace=3:application=9:scope=111');
    // vars unset in harness → min_severity falls back to 'medium'
    expect(assessCalls[0]!.min_severity).toBe('medium');
  });

  it('filters by the applications list (names, case-insensitive) and ids', async () => {
    const byName = await runScanner({ inputs: { applications: 'grafana, services api' } });
    expect(byName.assessCalls).toHaveLength(2);
    const byId = await runScanner({ inputs: { applications: '11' } });
    expect(byId.assessCalls).toHaveLength(1);
    expect((byId.assessCalls[0]!.deployment as Record<string, unknown>).application).toBe('other-app');
  });

  it('applies max_deployments and reports the dropped count (no silent cap)', async () => {
    const { result, assessCalls } = await runScanner({ inputs: { max_deployments: 1 } });
    expect(assessCalls).toHaveLength(1);
    expect(result.outputs.dropped_by_cap).toBe(2);
  });

  it('counts failed/skipped children without failing the scan', async () => {
    // Stub returning one of each status
    const statuses = ['assessed', 'skipped', 'failed'];
    let i = 0;
    const assessCalls: Record<string, unknown>[] = [];
    const result = await runWorkflowE2E({
      yamlPath: SCANNER,
      inputs: {},
      pluginStubs: {
        manual: passthroughTrigger,
        cron: passthroughTrigger,
        'np-lake-query': {
          handler: () => ok({ rows: LAKE_ROWS_SCAN.slice(0, 3), rowCount: 3 }),
          executeMode: 'all' as const,
        },
        'sub-workflow': {
          handler: (ctx: { inputs: Record<string, unknown> }) => {
            assessCalls.push(ctx.inputs);
            const status = statuses[i++ % 3]!;
            return ok({
              status, reason: status === 'failed' ? 'agent_failed' : '',
              total_findings: status === 'assessed' ? 1 : 0,
              created: status === 'assessed' ? 1 : 0, updated: 0, unchanged: 0,
              deployment_id: 'x', application: 'y',
            });
          },
          executeMode: 'all' as const,
        },
      },
    });
    expect(result.outputs.assessed).toBe(1);
    expect(result.outputs.skipped).toBe(1);
    expect(result.outputs.failed).toBe(1);
  });
});
