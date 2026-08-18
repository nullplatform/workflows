/**
 * @file Unit tests for the deterministic JavaScript of `arch-rule-check`.
 *
 * The E2E suite stubs `code-exec` by step id, so the body of `gather` never
 * runs there. It is a pure function of its `$item` plus HTTP, so here the
 * `config.code` block is read straight out of the YAML and executed with a
 * fake `fetch` — no network, and the assertions are on the real source that
 * ships, not on a copy.
 *
 * Covered: the checkpoint scan over prior approvals. GET /approval returns
 * its results ASCENDING by created_at, so the scan must pick the NEWEST
 * stamped verdict, not the first row the API happens to return.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parse } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const WF_PATH = resolve(HERE, '..', 'arch-rule-check.yaml');

interface WorkflowDoc {
  steps: Array<{ id: string; config?: { code?: string } }>;
}

function stepCode(stepId: string): string {
  const doc = parse(readFileSync(WF_PATH, 'utf8')) as WorkflowDoc;
  const code = doc.steps.find((s) => s.id === stepId)?.config?.code;
  if (typeof code !== 'string') throw new Error(`step "${stepId}" has no config.code`);
  return code;
}

type FakeFetch = (url: string, init?: Record<string, unknown>) => Promise<FakeResponse>;

interface FakeResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}

function res(status: number, body: unknown): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
  };
}

async function runStepCode<T>(
  code: string,
  item: Record<string, unknown>,
  fetchImpl: FakeFetch,
): Promise<T> {
  const body = new Function('$item', 'fetch', `return (async () => {\n${code}\n})();`) as (
    item: Record<string, unknown>,
    fetchImpl: FakeFetch,
  ) => Promise<T>;
  return body(item, fetchImpl);
}

const GATHER_CODE = stepCode('gather');

interface GatherOutput {
  mode: string;
  analyzed_sha: string;
  prev: { approval_id: number; sha: string } | null;
}

/**
 * Two stamped verdicts exist for the app: an ancient one (sha OLD) and the
 * most recent one (sha CURRENT, passed). The approvals API lists them
 * ASCENDING by created_at — oldest first — which is the order production
 * returns. A scan that takes the first stamped row lands on the ancient
 * verdict, diffs OLD...CURRENT and re-analyses; the correct scan finds the
 * newest verdict, sees the sha unchanged, and carries the result over.
 */
function fetchWithAscendingApprovals(requested: string[] = []): FakeFetch {
  const OLD_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const CURRENT_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const stamped = (sha: string) => ({
    items: [
      {
        id: 'no_secrets_in_code',
        status: 'passed',
        state: { details: { analyzed_sha: sha, findings: [], markdown: 'ok' } },
      },
    ],
  });
  return async (url: string) => {
    requested.push(url);
    if (url.endsWith('/token')) return res(200, { access_token: 'tok' });
    if (url.includes('/application/'))
      return res(200, {
        id: 1,
        name: 'demo',
        nrn: 'organization=1:application=1',
        repository_url: 'https://github.com/acme/demo',
      });
    if (url.includes('/release/')) return res(200, { id: 9, build_id: 8 });
    if (url.includes('/build/'))
      return res(200, { commit: { id: CURRENT_SHA }, branch: 'main' });
    if (url.includes('/approval?'))
      return res(200, {
        results: [
          { id: 100, mode: 'checklist', created_at: '2026-01-01T00:00:00Z' },
          { id: 200, mode: 'checklist', created_at: '2026-02-01T00:00:00Z' },
        ],
      });
    if (url.includes('/approval/100/checklist')) return res(200, stamped(OLD_SHA));
    if (url.includes('/approval/200/checklist')) return res(200, stamped(CURRENT_SHA));
    if (url.includes('/compare/'))
      return res(200, { files: [{ filename: 'src/index.js' }], commits: [] });
    if (url.includes('/git/trees/')) return res(200, { tree: [] });
    if (url.includes('/repos/acme/demo'))
      return res(200, { default_branch: 'main' });
    throw new Error(`unexpected fetch: ${url}`);
  };
}

describe('arch-rule-check — checkpoint picks the newest stamped verdict', () => {
  it('carries over when the newest verdict already covers the current sha', async () => {
    const requested: string[] = [];
    const out = await runStepCode<GatherOutput>(
      GATHER_CODE,
      {
        application_id: '1',
        release_id: '9',
        rule_id: 'no_secrets_in_code',
        file_pattern: '',
        force_full: '',
        callbackUrl: 'https://api.nullplatform.com/approval/999/checklist/item',
        np_api_key: 'k',
        github_token: 'g',
      },
      fetchWithAscendingApprovals(requested),
    );
    // The window matters, not just the order: limit=10 of an ascending list
    // is the ten oldest, so the query itself must ask for newest first.
    const listUrl = requested.find((u) => u.includes('/approval?'));
    expect(listUrl).toContain('sort=created_at:desc');
    expect(out.mode).toBe('carry_over');
    expect(out.prev?.approval_id).toBe(200);
    expect(out.prev?.sha).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  });
});
