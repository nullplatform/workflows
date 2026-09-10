# FinOps Phase 0: async package runner (engine plugin + callback) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workflow can call the `cloud-query` package on an agent asynchronously, receive the result through the engine's per-execution callback, and read it as step outputs.

**Architecture:** Two repos. In `workflow-system-demo` (engine) a new two-phase MODULE plugin `np-package-call` dispatches `package-exec` through `POST /controlplane/agent_command` with `execution_config.async` and returns `IStepResult.wait`; phase 2 validates a per-dispatch token and exposes the runner response as outputs. In `nullplatform/workflows` (this worktree) the `cloud-query` package POSTs its response to the callback URL it receives, and a reusable child workflow `finops/tool-cloud-query.yaml` wraps the plugin.

**Tech Stack:** TypeScript (engine: Node 22 ESM, Vitest; package: bun 1.4, `@nullplatform/plugin@0.0.4`, AWS SDK v3), workflow YAML (`@nullplatform/workflow-kit`), Docker (local controlplane agent).

**Spec:** `docs/superpowers/specs/2026-09-10-finops-cost-allocation-design.md` (sections 2, 4.1, 4.2, 4.3, 7 phase 0).

## Global Constraints

- Engine repo: `/Users/geisbruch/workspace/null/workflow-system-demo`, branch `fix/parallel-ready-steps` has unrelated uncommitted work. Create and use branch `feat/np-package-call` from `main` in a NEW worktree at `/Users/geisbruch/workspace/null/workflow-system-demo/.worktrees/np-package-call` (verify `.worktrees` is git-ignored first with `git check-ignore -q .worktrees`; if not, add it to `.gitignore` and commit that alone).
- Workflows repo worktree: `/Users/geisbruch/workspace/null/workflows/.worktrees/cost-v2`, branch `feat/cost-v2`.
- Engine plugin rules (CLAUDE.md): credentials via config `apikey: "${{ secrets.NP_API_KEY }}"`, never `ctx.secrets` as primary; composite waits use the two-phase protocol (`IStepResult.wait` + `ctx.resume`), never `ctx.helpers.waitForSignal()`; no `Date.now()`/`Math.random()` (use `ctx.helpers.uuid()`); `validateConfig()` runs before `execute()`; descriptors declare `outputPorts` statically; only the `default` port is wired in YAML.
- Runner output contract (spec 4.1): progress on stderr, exactly one JSON document on stdout, per-call cap `maxResultBytes` default 300 KB.
- `execution_config.retry.max_attempts` sent by the plugin defaults to 1 (spec 4.2).
- Async dispatch URL: `POST {baseUrl}/controlplane/agent_command`; callback URL: `{callbackBaseUrl}/workflows/webhooks/callback/{executionId}/{signalName}`; signal name `package-call.{stepId}`; correlation key `executionId`.
- Before every engine commit: `pnpm -w run lint`, `pnpm --filter @nullplatform/workflow-core build`, `pnpm --filter @nullplatform/workflow-core test`.
- Before every workflows commit that touches YAML: `npx np-workflow validate <file>` and `npx vitest finops`.
- The shell prints harmless `setValueForKeyFakeAssocArray ... _encode` noise on every command; ignore it.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File structure

Engine (`workflow-system-demo/packages/core/src/plugins/built-in/np-package-call/`):

| File | Responsibility |
|---|---|
| `descriptor.ts` | `NP_PACKAGE_CALL_ERROR_CODES`, config JSON schema, UI schema, descriptor object |
| `plugin.ts` | `NpPackageCallPlugin`: config merge, validation, sync execute, phase 1 dispatch, phase 2 resume |
| `index.ts` | re-exports |
| `__tests__/np-package-call.test.ts` | descriptor, validation, sync, phase 1, phase 2, error mapping |

Engine touch points: `packages/core/src/plugins/built-in/index.ts` (add export line), `packages/core/src/plugins/bootstrap.ts` (import + register).

Workflows (`workflows/.worktrees/cost-v2/finops/`):

| File | Responsibility |
|---|---|
| `packages/cloud-query/src/callback.ts` | `postCallback(url, body, fetchImpl)` with retries; pure and testable |
| `packages/cloud-query/src/index.ts` | wire `callback` + `token` echo into the response |
| `packages/cloud-query/test/callback.test.ts` | retry/backoff/failure behavior |
| `packages/cloud-query/mise.toml` | `run` task on `:latest` with `NP_WORKER_PATCHES` |
| `packages/cloud-query/README.md` | request/response contract, local run |
| `tool-cloud-query.yaml` | reusable child workflow |
| `__tests__/tool-cloud-query.e2e.test.ts` | `runWorkflowE2E` with `np-package-call` mocked |
| `README.md` | suite overview (phase 0 scope only) |

---

### Task 1: Runner callback POST (package)

**Files:**
- Create: `finops/packages/cloud-query/src/callback.ts`
- Create: `finops/packages/cloud-query/test/callback.test.ts`
- Modify: `finops/packages/cloud-query/src/runner.ts` (add `callback` + `token` to `CloudQueryRequest`/`CloudQueryResponse`)
- Modify: `finops/packages/cloud-query/src/index.ts`

**Interfaces:**
- Produces: `postCallback(url: string, body: unknown, opts?: { fetchImpl?: typeof fetch; attempts?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> }): Promise<{ ok: true; status: number } | { ok: false; error: string }>`
- Produces: request fields `callback?: { url: string; token?: string }`; response field `token?: string`.

- [ ] **Step 1: Write the failing tests**

```ts
// finops/packages/cloud-query/test/callback.test.ts
import { describe, expect, test } from "bun:test";
import { postCallback } from "../src/callback";

function fakeFetch(responses: Array<number | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response("ok", { status: next ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const noSleep = async () => {};

describe("postCallback", () => {
  test("POSTs JSON once on 2xx", async () => {
    const { fetchImpl, calls } = fakeFetch([200]);
    const r = await postCallback("http://cb/x", { a: 1 }, { fetchImpl, sleep: noSleep });
    expect(r).toEqual({ ok: true, status: 200 });
    expect(calls.length).toBe(1);
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(calls[0]!.init.body).toBe(JSON.stringify({ a: 1 }));
  });
  test("retries on 5xx and network errors, then succeeds", async () => {
    const { fetchImpl, calls } = fakeFetch([503, new Error("ECONNRESET"), 200]);
    const r = await postCallback("http://cb/x", {}, { fetchImpl, sleep: noSleep, attempts: 3 });
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(3);
  });
  test("does not retry on 4xx", async () => {
    const { fetchImpl, calls } = fakeFetch([404]);
    const r = await postCallback("http://cb/x", {}, { fetchImpl, sleep: noSleep });
    expect(r).toEqual({ ok: false, error: "callback returned HTTP 404" });
    expect(calls.length).toBe(1);
  });
  test("gives up after attempts", async () => {
    const { fetchImpl, calls } = fakeFetch([500, 500, 500]);
    const r = await postCallback("http://cb/x", {}, { fetchImpl, sleep: noSleep, attempts: 3 });
    expect(r.ok).toBe(false);
    expect(calls.length).toBe(3);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd finops/packages/cloud-query && PATH="$HOME/.local/share/mise/shims:$PATH" bun test test/callback.test.ts`
Expected: FAIL, `Cannot find module "../src/callback"`.

- [ ] **Step 3: Implement `callback.ts`**

```ts
// finops/packages/cloud-query/src/callback.ts
/**
 * Push the runner response to the workflow engine's per-execution callback.
 * The URL is an unguessable capability minted by the engine; the body carries
 * the `token` the plugin issued so a forged POST cannot be mistaken for ours.
 */
export interface PostCallbackOptions {
  fetchImpl?: typeof fetch;
  attempts?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type PostCallbackResult = { ok: true; status: number } | { ok: false; error: string };

export async function postCallback(url: string, body: unknown, opts: PostCallbackOptions = {}): Promise<PostCallbackResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const attempts = opts.attempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const payload = JSON.stringify(body);
  let lastError = "";
  for (let i = 0; i < attempts; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, signal: ac.signal });
      if (res.ok) return { ok: true, status: res.status };
      lastError = `callback returned HTTP ${res.status}`;
      if (res.status < 500) return { ok: false, error: lastError };
    } catch (err) {
      lastError = `callback request failed: ${(err as Error).message}`;
    } finally {
      clearTimeout(timer);
    }
    if (i < attempts - 1) await sleep(1000 * (i + 1));
  }
  return { ok: false, error: lastError };
}
```

- [ ] **Step 4: Extend the request/response types in `runner.ts`**

Add to `CloudQueryRequest`:

```ts
  /** Where to POST the response (engine per-execution callback). Optional. */
  callback?: { url: string; token?: string };
```

Add to `CloudQueryResponse`:

```ts
  /** `callback.token` echoed back so the caller can verify provenance. */
  token?: string;
  callbackDelivered?: boolean;
```

In `validateRequest`, after the calls loop:

```ts
  if (r.callback !== undefined) {
    if (typeof r.callback !== "object" || typeof (r.callback as { url?: unknown }).url !== "string" || !/^https?:\/\//.test((r.callback as { url: string }).url)) {
      return "callback.url must be an http(s) URL";
    }
  }
```

- [ ] **Step 5: Wire the callback in `index.ts`**

Replace the block that starts at `if ("arn" in identity) response.identity = identity;` with:

```ts
      if ("arn" in identity) response.identity = identity;
      if (cq.callback?.token) response.token = cq.callback.token;
      if (cq.callback) {
        const cb = await postCallback(cq.callback.url, response);
        response.callbackDelivered = cb.ok;
        log(`[cloud-query] callback ${cb.ok ? `delivered (HTTP ${cb.status})` : `FAILED: ${cb.error}`}`);
        if (!cb.ok) {
          req.emit({ stdout: JSON.stringify(response) });
          return { success: false, errorCode: "CALLBACK_FAILED", error: cb.error, data: response };
        }
      }
      req.emit({ stdout: JSON.stringify(response) });
      const failed = response.calls.filter((c) => !c.ok);
```

and add `import { postCallback } from "./callback";` at the top.

- [ ] **Step 6: Run all package tests**

Run: `PATH="$HOME/.local/share/mise/shims:$PATH" bun test`
Expected: 11 pass (7 existing + 4 new), 0 fail.

- [ ] **Step 7: Add a runner test for callback validation**

Append to `test/runner.test.ts` inside `describe("validateRequest")`:

```ts
  test("validates callback url", () => {
    const calls = [{ id: "a", service: "ce", operation: "GetCostAndUsage" }];
    expect(validateRequest({ calls, callback: { url: "ftp://x" } })).toContain("callback.url");
    expect(validateRequest({ calls, callback: { url: "http://host.docker.internal:3000/cb", token: "t" } })).toBeUndefined();
  });
```

Run: `bun test` → 12 pass.

- [ ] **Step 8: Commit**

```bash
cd /Users/geisbruch/workspace/null/workflows/.worktrees/cost-v2
git add finops/packages/cloud-query/src finops/packages/cloud-query/test
git commit -m "finops(cloud-query): POST the response to the engine callback with retries

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Runner local-run task and README (package)

**Files:**
- Modify: `finops/packages/cloud-query/mise.toml` (task `run`)
- Modify: `finops/packages/cloud-query/README.md` (replace template text)

**Interfaces:**
- Consumes: nothing.
- Produces: `mise run run` starts the agent on `:latest` with `NP_WORKER_PATCHES` from `$NP_WORKER_AWS_ACCESS_KEY_ID` / `$NP_WORKER_AWS_SECRET_ACCESS_KEY` / `$NP_WORKER_AWS_REGION`.

- [ ] **Step 1: Replace the `run` task in `mise.toml`**

```toml
[tasks.run]
description = "Run locally: an agent (docker backend, :latest) that spawns the lean worker"
depends = ["build:image"]
run = """
set -eu
: "${NP_API_KEY:?set NP_API_KEY}"
: "${NP_WORKER_AWS_ACCESS_KEY_ID:?set NP_WORKER_AWS_ACCESS_KEY_ID (dev only; in a cluster the pod's IAM role is used)}"
: "${NP_WORKER_AWS_SECRET_ACCESS_KEY:?set NP_WORKER_AWS_SECRET_ACCESS_KEY}"
region="${NP_WORKER_AWS_REGION:-us-east-1}"
patches=$(printf '[{"target":{"package":"cloud-query"},"merge":{"spec":{"containers":[{"name":"worker","env":[{"name":"AWS_ACCESS_KEY_ID","value":"%s"},{"name":"AWS_SECRET_ACCESS_KEY","value":"%s"},{"name":"AWS_REGION","value":"%s"}]}]}}}]' "$NP_WORKER_AWS_ACCESS_KEY_ID" "$NP_WORKER_AWS_SECRET_ACCESS_KEY" "$region")
docker rm -f np-cloud-query-agent >/dev/null 2>&1 || true
docker rm -f "np-worker-$(docker info --format '{{.Name}}')-cloud-query" >/dev/null 2>&1 || true
docker run -d --name np-cloud-query-agent --network host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e NP_API_KEY -e NP_LOG_LEVEL="${NP_LOG_LEVEL:-INFO}" \
  -e NP_WORKER_BACKEND=docker \
  -e NP_WORKER_IMAGE=cloud-query-worker:dev \
  -e NP_WORKER_PATCHES="$patches" \
  "${NP_AGENT_IMAGE:-public.ecr.aws/nullplatform/controlplane-agent:latest}" \
  -runtime=host -tags=package:cloud-query,local:"${NP_LOCAL_USER:-$USER}",env:local >/dev/null
echo "agent started; follow with: docker logs -f np-cloud-query-agent" >&2
"""
```

- [ ] **Step 2: Write `README.md`**

```markdown
# cloud-query

Generic cloud SDK call runner, shipped as a nullplatform **package** (`simple`
type). A workflow sends a list of SDK calls; the worker runs them with the
credentials of the pod/container it runs in (IAM role in a cluster) and returns
the raw responses. It carries no cost semantics.

## Request (`NP_ACTION_CONTEXT.cloud_query`)

| Field | Type | Notes |
|---|---|---|
| `provider` | `"aws"` | only AWS for now |
| `region` | string | default `AWS_REGION` of the worker, else `us-east-1` |
| `assumeRole` | `{ roleArn, sessionName?, externalId? }` | optional STS AssumeRole before the calls |
| `calls[]` | `{ id, service, operation, params?, paginate?, maxPages? }` | `service` in `ce`, `cost-explorer`, `cloudwatch`, `ec2`, `sts`; `operation` PascalCase SDK command |
| `maxResultBytes` | number | per-call cap, default 307200 |
| `callback` | `{ url, token? }` | POST the response here (engine callback); `token` is echoed |

## Response

`{ provider, region, identity?, token?, callbackDelivered?, calls: [{ id, ok, pages?, durationMs, result?, errorCode?, error? }] }`

Output contract: progress on **stderr**, the response JSON alone on **stdout**
(the control plane exposes a command's stdout, not the gRPC `data`). Keep
results under the cap: Cost Explorer daily grouped by SERVICE+USAGE_TYPE for
14 days is ~360 KB; larger windows must be split by the caller.

## Local run

```bash
export NP_API_KEY=...            # org API key (the agent registers with it)
export NP_WORKER_AWS_ACCESS_KEY_ID=... NP_WORKER_AWS_SECRET_ACCESS_KEY=...
mise run run                     # builds the image, starts the agent with tags package:cloud-query,local:$USER
```

Dispatch by hand (sync, small):

```bash
curl -s -X POST https://api.nullplatform.com/controlplane/agent_command \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"selector":{"package":"cloud-query","local":"'$USER'"},"execution_config":{"retry":{"max_attempts":1}},
       "command":{"type":"package-exec","data":{"package":"cloud-query","environment":{"NP_ACTION_CONTEXT":"{\"cloud_query\":{\"calls\":[{\"id\":\"who\",\"service\":\"sts\",\"operation\":\"GetCallerIdentity\"}]}}"}}}}'
```

## Tests

`mise run test` (bun). No live AWS in tests.
```

- [ ] **Step 3: Verify the task starts the agent**

Run (with the kwik key and the `kwik_admin` AWS keys exported as the three `NP_WORKER_*` vars): `PATH="$HOME/.local/share/mise/shims:$PATH" mise run run` then `docker logs np-cloud-query-agent | grep -m1 'Successfully connected'`.
Expected: the line appears within 10 s.

- [ ] **Step 4: Commit**

```bash
git add finops/packages/cloud-query/mise.toml finops/packages/cloud-query/README.md
git commit -m "finops(cloud-query): local run on agent :latest with worker patches; README

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Engine worktree + `np-package-call` descriptor and config validation

**Files:**
- Create: `packages/core/src/plugins/built-in/np-package-call/descriptor.ts`
- Create: `packages/core/src/plugins/built-in/np-package-call/plugin.ts` (validation only in this task)
- Create: `packages/core/src/plugins/built-in/np-package-call/index.ts`
- Create: `packages/core/src/plugins/built-in/np-package-call/__tests__/np-package-call.test.ts`

**Interfaces:**
- Produces: `NpPackageCallConfig`, `NP_PACKAGE_CALL_ERROR_CODES`, `npPackageCallDescriptor`, `NpPackageCallPlugin` (`configure`, `validateConfig`, `execute`, `destroy`).

- [ ] **Step 1: Create the engine worktree**

```bash
cd /Users/geisbruch/workspace/null/workflow-system-demo
git check-ignore -q .worktrees || (echo ".worktrees/" >> .gitignore && git add .gitignore && git commit -m "infra: ignore .worktrees" )
git fetch -q origin
git worktree add .worktrees/np-package-call -b feat/np-package-call origin/main
cd .worktrees/np-package-call && pnpm install --frozen-lockfile 2>&1 | tail -2
pnpm --filter @nullplatform/workflow-core test -- np-agent-command 2>&1 | tail -5
```
Expected: install ok, np-agent-command tests pass (baseline).

- [ ] **Step 2: Write the failing descriptor/validation tests**

```ts
// packages/core/src/plugins/built-in/np-package-call/__tests__/np-package-call.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IStepExecutionContext, IStepResumeContext } from '@nullplatform/workflow-sdk';
import { makeStepContext } from '../../__tests__/context-fixture.js';
import { __clearTokenCacheForTests } from '../../np-agent-command/auth.js';
import { NP_PACKAGE_CALL_ERROR_CODES } from '../descriptor.js';
import { NpPackageCallPlugin } from '../plugin.js';

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  __clearTokenCacheForTests();
});
afterEach(() => vi.unstubAllGlobals());

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const TOKEN_RESPONSE = { access_token: 'jwt', token_expires_at: 4102444800000 };

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apikey: 'apikey-1',
    agent_selector: { tags: { package: 'cloud-query', local: 'gabriel' } },
    package: 'cloud-query',
    action_context: { cloud_query: { calls: [{ id: 'who', service: 'sts', operation: 'GetCallerIdentity' }] } },
    ...overrides,
  };
}
function phase1Ctx(): IStepExecutionContext {
  const { ctx } = makeStepContext({ executionId: 'ex_1', stepId: 'query' });
  return { ...ctx, helpers: { ...ctx.helpers, uuid: () => 'tok_1' } };
}
function phase2Ctx(resume: IStepResumeContext): IStepExecutionContext {
  const { ctx } = makeStepContext({ executionId: 'ex_1', stepId: 'query' });
  return { ...ctx, resume };
}

describe('np-package-call — descriptor & config', () => {
  it('declares a single default port and the awaits-signal capability', () => {
    const p = new NpPackageCallPlugin();
    expect(p.descriptor.name).toBe('np-package-call');
    expect(p.descriptor.outputPorts?.map((x) => x.name)).toEqual(['default']);
    expect(p.descriptor.capabilities).toContain('awaits-signal');
    expect(p.descriptor.executeMode).toBe('all');
  });
  it('accepts a good config and rejects missing package / selector / bad mode', () => {
    const ok = new NpPackageCallPlugin();
    ok.configure(baseConfig({ mode: 'sync', timeout: '10m' }));
    expect(ok.validateConfig().valid).toBe(true);

    const noPkg = new NpPackageCallPlugin();
    noPkg.configure(baseConfig({ package: '' }));
    expect(noPkg.validateConfig().valid).toBe(false);

    const noSel = new NpPackageCallPlugin();
    noSel.configure(baseConfig({ agent_selector: { tags: {} } }));
    expect(noSel.validateConfig().valid).toBe(false);

    const badMode = new NpPackageCallPlugin();
    badMode.configure(baseConfig({ mode: 'later' }));
    expect(badMode.validateConfig().valid).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @nullplatform/workflow-core test -- np-package-call`
Expected: FAIL, cannot resolve `../descriptor.js`.

- [ ] **Step 4: Write `descriptor.ts`**

```ts
// packages/core/src/plugins/built-in/np-package-call/descriptor.ts
/**
 * `np-package-call` — call a nullplatform PACKAGE (a worker image the agent
 * spawns) through `POST /controlplane/agent_command` `package-exec`.
 *
 * Async mode (default) is the two-phase wait protocol: phase 1 dispatches with
 * `execution_config.async: true` and returns `IStepResult.wait`; the worker
 * POSTs its result to the engine's per-execution callback URL, which resumes
 * phase 2. Sync mode is a one-shot call for small, fast requests (the platform
 * cuts sync calls at 60 s and drops completions above ~400 KB).
 */
import type { IPluginDescriptor } from '@nullplatform/workflow-sdk';

export const NP_PACKAGE_CALL_ERROR_CODES = {
  NOT_CONFIGURED: 'NP_PACKAGE_CALL_NOT_CONFIGURED',
  TOKEN_EXCHANGE_FAILED: 'NP_PACKAGE_CALL_TOKEN_EXCHANGE_FAILED',
  DISPATCH_FAILED: 'NP_PACKAGE_CALL_DISPATCH_FAILED',
  AGENT_NOT_FOUND: 'NP_PACKAGE_CALL_AGENT_NOT_FOUND',
  BAD_RUNNER_OUTPUT: 'NP_PACKAGE_CALL_BAD_RUNNER_OUTPUT',
  CALLBACK_TOKEN_MISMATCH: 'NP_PACKAGE_CALL_CALLBACK_TOKEN_MISMATCH',
  CALLS_FAILED: 'NP_PACKAGE_CALL_CALLS_FAILED',
  TIMEOUT: 'NP_PACKAGE_CALL_TIMEOUT',
} as const;
export type NpPackageCallErrorCode = (typeof NP_PACKAGE_CALL_ERROR_CODES)[keyof typeof NP_PACKAGE_CALL_ERROR_CODES];

export const NP_PACKAGE_CALL_MODES = ['async', 'sync'] as const;
export type NpPackageCallMode = (typeof NP_PACKAGE_CALL_MODES)[number];

export const DEFAULT_CALLBACK_BASE_URL = 'https://api.nullplatform.com';
export const DEFAULT_CALLBACK_KEY = 'cloud_query.callback';
export const DEFAULT_WAIT_TIMEOUT = '30m';

const configSchema = {
  type: 'object',
  required: ['agent_selector', 'package', 'action_context'],
  properties: {
    apikey: { type: 'string', title: 'API key', description: 'Org API key, from a config entry: "${{ secrets.NP_API_KEY }}".' },
    base_url: { type: 'string', title: 'Platform base URL', default: 'https://api.nullplatform.com' },
    agent_selector: {
      type: 'object',
      title: 'Agent selector',
      required: ['tags'],
      properties: {
        nrn: { type: 'string', description: 'Restrict matching agents to this NRN subtree.' },
        tags: { type: 'object', additionalProperties: { type: 'string' }, description: 'Subset match on agent tags, e.g. {"package":"cloud-query"}. Never pin an agent id: ids change on restart.' },
      },
    },
    package: { type: 'string', title: 'Package slug', description: 'e.g. cloud-query' },
    version: { type: 'string', title: 'Package version (semver, optional)' },
    action_context: { type: 'object', title: 'Action context', description: 'JSON handed to the worker as NP_ACTION_CONTEXT.' },
    mode: { type: 'string', enum: [...NP_PACKAGE_CALL_MODES], default: 'async', title: 'Mode' },
    callback_base_url: { type: 'string', default: DEFAULT_CALLBACK_BASE_URL, title: 'Engine base URL for the callback', description: 'The worker must reach this URL. Locally: http://host.docker.internal:3000.' },
    callback_key: { type: 'string', default: DEFAULT_CALLBACK_KEY, title: 'Dotted path inside action_context where {url, token} is written' },
    timeout: { type: 'string', default: DEFAULT_WAIT_TIMEOUT, title: 'Wait timeout (async)', description: 'Duration string, e.g. "30m". On timeout the step FAILS; route with error_handling.fallback_step.' },
    retry_max_attempts: { type: 'integer', minimum: 1, default: 1, title: 'Platform re-delivery attempts', description: 'execution_config.retry.max_attempts. Keep 1: a re-delivered package-exec re-runs the calls.' },
    timeout_seconds: { type: 'integer', minimum: 1, title: 'HTTP timeout for the dispatch call', description: 'Default 30 (async) / 120 (sync).' },
  },
} as const;

const configUiSchema = {
  type: 'VerticalLayout',
  elements: [
    { type: 'Control', scope: '#/properties/package' },
    { type: 'Control', scope: '#/properties/version' },
    { type: 'Control', scope: '#/properties/agent_selector' },
    { type: 'Control', scope: '#/properties/mode', options: { format: 'select' } },
    { type: 'Control', scope: '#/properties/action_context', options: { format: 'json' } },
    { type: 'Control', scope: '#/properties/apikey', options: { format: 'password' } },
    {
      type: 'Group', label: 'Advanced',
      elements: [
        { type: 'Control', scope: '#/properties/callback_base_url' },
        { type: 'Control', scope: '#/properties/callback_key' },
        { type: 'Control', scope: '#/properties/timeout' },
        { type: 'Control', scope: '#/properties/retry_max_attempts' },
        { type: 'Control', scope: '#/properties/timeout_seconds' },
        { type: 'Control', scope: '#/properties/base_url' },
      ],
    },
  ],
} as const;

export const npPackageCallDescriptor: IPluginDescriptor = {
  name: 'np-package-call',
  version: '1.0.0',
  displayName: 'NP Package Call',
  description: 'Run a nullplatform package (agent-spawned worker) with an arbitrary action context; async with callback, or sync for small calls.',
  semanticDescription:
    'Dispatches package-exec to an agent selected by tags. Async mode returns a wait and resumes when the worker POSTs its result to the engine callback URL injected into the action context. Use for cloud billing/SDK queries (cloud-query) and any custom command handler package.',
  category: 'nullplatform',
  icon: 'package',
  tags: ['nullplatform', 'agent', 'package', 'finops'],
  executeMode: 'all',
  configSchema,
  configUiSchema,
  inputPorts: [{ name: 'default', displayName: 'Input' }],
  outputPorts: [{ name: 'default', displayName: 'Result' }],
  capabilities: ['awaits-signal'],
  previewTemplate: '{{ config.package }} ({{ config.mode | default: "async" }})',
  outputSchema: {
    type: 'object',
    properties: {
      commandId: { type: 'string' },
      agentId: { type: 'string' },
      response: { description: 'The worker response (cloud-query: {calls[], identity}).' },
      calls: { type: 'array' },
      failed: { type: 'array', items: { type: 'string' }, description: 'Ids of calls with ok=false.' },
    },
  },
  examples: [
    {
      name: 'Cost Explorer by service (async)',
      description: 'One day of AWS cost grouped by service through the cloud-query package.',
      config: {
        apikey: '${{ secrets.NP_API_KEY }}',
        agent_selector: { tags: { package: 'cloud-query' } },
        package: 'cloud-query',
        action_context: {
          cloud_query: {
            calls: [{ id: 'by_service', service: 'ce', operation: 'GetCostAndUsage', params: { TimePeriod: { Start: '2026-09-01', End: '2026-09-02' }, Granularity: 'DAILY', Metrics: ['UnblendedCost'], GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }] } }],
          },
        },
      },
    },
    {
      name: 'Who am I (sync)',
      config: { apikey: '${{ secrets.NP_API_KEY }}', agent_selector: { tags: { package: 'cloud-query' } }, package: 'cloud-query', mode: 'sync', action_context: { cloud_query: { calls: [{ id: 'who', service: 'sts', operation: 'GetCallerIdentity' }] } } },
    },
  ],
  documentation: `## np-package-call

Runs a package on an agent. **Async** (default): the step waits until the worker POSTs to
\`{callback_base_url}/workflows/webhooks/callback/{executionId}/package-call.{stepId}\`. The plugin injects
\`{url, token}\` at \`callback_key\` inside \`action_context\`; the worker must echo \`token\` in its response body.
**Sync**: one-shot; the response is parsed from the command's stdout. Keep sync calls small and fast.

Select agents by **tags**, never by id. Timeouts fail the step: wire \`error_handling.fallback_step\`.`,
};
```

- [ ] **Step 5: Write `plugin.ts` (config + validation only)**

```ts
// packages/core/src/plugins/built-in/np-package-call/plugin.ts
import { ExtensionMetadata } from '@nullplatform/workflow-sdk';
import type {
  IModulePlugin,
  IPluginDescriptor,
  IStepExecutionContext,
  IStepResult,
  IValidationResult,
} from '@nullplatform/workflow-sdk';
import { DEFAULT_NP_API_BASE_URL, TokenExchangeError, getAccessToken } from '../np-agent-command/auth.js';
import {
  DEFAULT_CALLBACK_BASE_URL,
  DEFAULT_CALLBACK_KEY,
  DEFAULT_WAIT_TIMEOUT,
  NP_PACKAGE_CALL_ERROR_CODES,
  NP_PACKAGE_CALL_MODES,
  type NpPackageCallMode,
  npPackageCallDescriptor,
} from './descriptor.js';

export interface NpPackageCallConfig {
  apikey?: string;
  base_url?: string;
  agent_selector?: { nrn?: string; tags?: Record<string, string> };
  package?: string;
  version?: string;
  action_context?: Record<string, unknown>;
  mode?: NpPackageCallMode;
  callback_base_url?: string;
  callback_key?: string;
  timeout?: string;
  retry_max_attempts?: number;
  timeout_seconds?: number;
}

export class NpPackageCallPlugin implements IModulePlugin {
  readonly descriptor: IPluginDescriptor = npPackageCallDescriptor;
  readonly extensions = new ExtensionMetadata();
  #config: NpPackageCallConfig | undefined;

  configure(config: Record<string, unknown>): void {
    this.#config = config as NpPackageCallConfig;
  }

  validateConfig(): IValidationResult {
    const cfg = this.#config ?? {};
    const errors: IValidationResult['errors'] = [];
    if (typeof cfg.package !== 'string' || cfg.package.length === 0) {
      errors.push({ path: 'package', message: 'package is required', code: NP_PACKAGE_CALL_ERROR_CODES.NOT_CONFIGURED });
    }
    const tags = cfg.agent_selector?.tags;
    if (!tags || typeof tags !== 'object' || Object.keys(tags).length === 0) {
      errors.push({ path: 'agent_selector.tags', message: 'agent_selector.tags must have at least one tag', code: NP_PACKAGE_CALL_ERROR_CODES.NOT_CONFIGURED });
    }
    if (cfg.action_context !== undefined && (typeof cfg.action_context !== 'object' || cfg.action_context === null)) {
      errors.push({ path: 'action_context', message: 'action_context must be an object', code: NP_PACKAGE_CALL_ERROR_CODES.NOT_CONFIGURED });
    }
    if (cfg.mode !== undefined && !(NP_PACKAGE_CALL_MODES as readonly string[]).includes(cfg.mode)) {
      errors.push({ path: 'mode', message: `mode must be one of ${NP_PACKAGE_CALL_MODES.join(', ')}`, code: NP_PACKAGE_CALL_ERROR_CODES.NOT_CONFIGURED });
    }
    if (cfg.retry_max_attempts !== undefined && (!Number.isInteger(cfg.retry_max_attempts) || cfg.retry_max_attempts < 1)) {
      errors.push({ path: 'retry_max_attempts', message: 'retry_max_attempts must be an integer >= 1', code: NP_PACKAGE_CALL_ERROR_CODES.NOT_CONFIGURED });
    }
    return errors.length > 0 ? { valid: false, errors } : { valid: true, errors: [] };
  }

  destroy(): void {
    this.#config = undefined;
  }

  async execute(ctx: IStepExecutionContext): Promise<IStepResult> {
    return failure('not implemented', NP_PACKAGE_CALL_ERROR_CODES.NOT_CONFIGURED, false);
  }
}

export function failure(message: string, code: string, retryable: boolean, details?: Record<string, unknown>): IStepResult {
  return { status: 'failure', error: { message, code, retryable, ...(details ? { details } : {}) } };
}

// re-exported for the tests and the next task
export { DEFAULT_NP_API_BASE_URL, TokenExchangeError, getAccessToken, DEFAULT_CALLBACK_BASE_URL, DEFAULT_CALLBACK_KEY, DEFAULT_WAIT_TIMEOUT };
```

Note: `IValidationResult['errors']` entries in this codebase are `{ path, message, code }` (see `np-action-item-wait/plugin.ts`); if the type differs, match `slack-ask/plugin.ts`.

- [ ] **Step 6: Write `index.ts`**

```ts
export { NpPackageCallPlugin, type NpPackageCallConfig } from './plugin.js';
export {
  npPackageCallDescriptor,
  NP_PACKAGE_CALL_ERROR_CODES,
  NP_PACKAGE_CALL_MODES,
  type NpPackageCallErrorCode,
  type NpPackageCallMode,
} from './descriptor.js';
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @nullplatform/workflow-core test -- np-package-call`
Expected: 2 pass.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/plugins/built-in/np-package-call
git commit -m "core: np-package-call descriptor + config validation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `np-package-call` sync mode

**Files:**
- Modify: `packages/core/src/plugins/built-in/np-package-call/plugin.ts`
- Modify: `__tests__/np-package-call.test.ts`

**Interfaces:**
- Consumes: `getAccessToken({ apikey, baseUrl })` → `{ token }` (from `np-agent-command/auth.ts`; check the `ExchangedToken` field name with `grep -n "interface ExchangedToken" -A6 auth.ts`, it is `token`).
- Produces: `dispatch(ctx, cfg, body)` internal; outputs `{ commandId, agentId, response, calls, failed, mode: 'sync' }`.

- [ ] **Step 1: Write the failing sync tests**

Append to the test file:

```ts
describe('np-package-call — sync', () => {
  it('dispatches package-exec and parses the runner JSON from stdOut', async () => {
    fetchMock
      .mockResolvedValueOnce(json(TOKEN_RESPONSE))
      .mockResolvedValueOnce(json({ type: 'completed', executions: [{ commandId: 'c1', agentId: 'a1', status: 'success', results: { stdOut: JSON.stringify({ provider: 'aws', calls: [{ id: 'who', ok: true, result: { Account: '1' } }] }), stdErr: 'progress', exitCode: 0 }}] }));
    const p = new NpPackageCallPlugin();
    p.configure(baseConfig({ mode: 'sync' }));
    const r = await p.execute(phase1Ctx());
    expect(r.status).toBe('success');
    expect(r.wait).toBeUndefined();
    expect(r.outputs).toMatchObject({ commandId: 'c1', agentId: 'a1', failed: [], mode: 'sync' });
    expect((r.outputs?.response as { calls: unknown[] }).calls).toHaveLength(1);

    const [, dispatch] = fetchMock.mock.calls as Array<[string, RequestInit]>;
    expect(dispatch![0]).toBe('https://api.nullplatform.com/controlplane/agent_command');
    const body = JSON.parse(String(dispatch![1].body));
    expect(body.selector).toEqual({ package: 'cloud-query', local: 'gabriel' });
    expect(body.execution_config).toEqual({ retry: { max_attempts: 1 } });
    expect(body.command.type).toBe('package-exec');
    expect(body.command.data.package).toBe('cloud-query');
    expect(JSON.parse(body.command.data.environment.NP_ACTION_CONTEXT)).toEqual(baseConfig().action_context);
  });
  it('fails with CALLS_FAILED when a call is not ok, keeping the response in outputs', async () => {
    fetchMock
      .mockResolvedValueOnce(json(TOKEN_RESPONSE))
      .mockResolvedValueOnce(json({ executions: [{ commandId: 'c1', agentId: 'a1', status: 'success', results: { stdOut: JSON.stringify({ calls: [{ id: 'x', ok: false, errorCode: 'RESULT_TOO_LARGE', error: 'big' }] }), stdErr: '', exitCode: 1 }}] }));
    const p = new NpPackageCallPlugin();
    p.configure(baseConfig({ mode: 'sync' }));
    const r = await p.execute(phase1Ctx());
    expect(r.status).toBe('failure');
    expect(r.error?.code).toBe(NP_PACKAGE_CALL_ERROR_CODES.CALLS_FAILED);
    expect(r.error?.retryable).toBe(false);
    expect(r.outputs).toMatchObject({ failed: ['x'] });
  });
  it('maps a non-JSON stdOut to BAD_RUNNER_OUTPUT and a platform error to DISPATCH_FAILED', async () => {
    fetchMock
      .mockResolvedValueOnce(json(TOKEN_RESPONSE))
      .mockResolvedValueOnce(json({ executions: [{ commandId: 'c1', agentId: 'a1', status: 'success', results: { stdOut: 'not json', stdErr: '', exitCode: 0 }}] }));
    const p = new NpPackageCallPlugin();
    p.configure(baseConfig({ mode: 'sync' }));
    expect((await p.execute(phase1Ctx())).error?.code).toBe(NP_PACKAGE_CALL_ERROR_CODES.BAD_RUNNER_OUTPUT);

    fetchMock
      .mockResolvedValueOnce(json({ type: 'error', executions: [{ commandId: 'unknown', agentId: 'unknown', status: 'error', data: { error: 'No agents found for selector' } }] }, 500));
    const q = new NpPackageCallPlugin();
    q.configure(baseConfig({ mode: 'sync' }));
    const r = await q.execute(phase1Ctx());
    expect(r.error?.code).toBe(NP_PACKAGE_CALL_ERROR_CODES.AGENT_NOT_FOUND);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @nullplatform/workflow-core test -- np-package-call`
Expected: 3 new tests FAIL ("not implemented").

- [ ] **Step 3: Implement the shared dispatch + sync path**

Replace `execute` and add helpers in `plugin.ts`:

```ts
interface AgentExecution {
  commandId?: string;
  agentId?: string;
  status?: string;
  error?: string;
  data?: { error?: string };
  results?: { stdOut?: string; stdErr?: string; exitCode?: number };
}
interface AgentCommandResponse {
  type?: string;
  error?: string;
  executions?: AgentExecution[];
}

export interface RunnerResponse {
  calls?: Array<{ id: string; ok: boolean; [k: string]: unknown }>;
  token?: string;
  [k: string]: unknown;
}

function mergeConfig(cfg: NpPackageCallConfig, inputs: Record<string, unknown>): NpPackageCallConfig {
  // Whitelisted runtime overrides (so YAML can pass action_context/package via inputs).
  const out: NpPackageCallConfig = { ...cfg };
  if (inputs.action_context && typeof inputs.action_context === 'object') out.action_context = inputs.action_context as Record<string, unknown>;
  if (typeof inputs.package === 'string') out.package = inputs.package;
  if (typeof inputs.version === 'string') out.version = inputs.version;
  if (inputs.agent_selector && typeof inputs.agent_selector === 'object') out.agent_selector = inputs.agent_selector as NpPackageCallConfig['agent_selector'];
  if (typeof inputs.mode === 'string') out.mode = inputs.mode as NpPackageCallMode;
  return out;
}

async function resolveApikey(cfg: NpPackageCallConfig, ctx: IStepExecutionContext): Promise<string> {
  if (typeof cfg.apikey === 'string' && cfg.apikey.length > 0) return cfg.apikey;
  const fromSecrets = await ctx.secrets.get('NP_API_KEY');
  if (typeof fromSecrets === 'string' && fromSecrets.length > 0) return fromSecrets;
  throw new Error("apikey not configured: set config.apikey to '${{ secrets.NP_API_KEY }}'");
}

/** Set a dotted path inside a (cloned) object: setPath({a:{}}, 'a.b', 1) → {a:{b:1}}. */
export function setPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
  const parts = path.split('.');
  let cur: Record<string, unknown> = clone;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
  return clone;
}

function classifyPlatformError(message: string): string {
  return /no agents?|agent not found|not connected/i.test(message)
    ? NP_PACKAGE_CALL_ERROR_CODES.AGENT_NOT_FOUND
    : NP_PACKAGE_CALL_ERROR_CODES.DISPATCH_FAILED;
}

async function dispatch(
  ctx: IStepExecutionContext,
  cfg: NpPackageCallConfig,
  actionContext: Record<string, unknown>,
  async: boolean,
): Promise<{ ok: true; exec: AgentExecution } | { ok: false; result: IStepResult }> {
  const baseUrl = (cfg.base_url ?? DEFAULT_NP_API_BASE_URL).replace(/\/+$/, '');
  let token: string;
  try {
    const apikey = await resolveApikey(cfg, ctx);
    token = (await getAccessToken({ apikey, baseUrl })).token;
  } catch (err) {
    const retryable = err instanceof TokenExchangeError ? err.retryable : false;
    return { ok: false, result: failure((err as Error).message, NP_PACKAGE_CALL_ERROR_CODES.TOKEN_EXCHANGE_FAILED, retryable) };
  }
  const body: Record<string, unknown> = {
    selector: cfg.agent_selector?.tags ?? {},
    ...(cfg.agent_selector?.nrn ? { nrn: cfg.agent_selector.nrn } : {}),
    execution_config: { ...(async ? { async: true } : {}), retry: { max_attempts: cfg.retry_max_attempts ?? 1 } },
    command: {
      type: 'package-exec',
      data: {
        package: cfg.package,
        ...(cfg.version ? { version: cfg.version } : {}),
        environment: { NP_ACTION_CONTEXT: JSON.stringify(actionContext) },
      },
    },
  };
  const timeoutMs = (cfg.timeout_seconds ?? (async ? 30 : 120)) * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  let status = 0;
  let text = '';
  try {
    const resp = await fetch(`${baseUrl}/controlplane/agent_command`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    status = resp.status;
    text = await resp.text();
  } catch (err) {
    return { ok: false, result: failure(`agent_command request failed: ${(err as Error).message}`, NP_PACKAGE_CALL_ERROR_CODES.DISPATCH_FAILED, true) };
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onAbort);
  }
  let parsed: AgentCommandResponse;
  try {
    parsed = JSON.parse(text) as AgentCommandResponse;
  } catch {
    return { ok: false, result: failure(`agent_command returned non-JSON (HTTP ${status}): ${text.slice(0, 200)}`, NP_PACKAGE_CALL_ERROR_CODES.DISPATCH_FAILED, status >= 500) };
  }
  const exec = parsed.executions?.[0];
  if (status >= 400 || !exec || exec.status !== 'success') {
    const message = exec?.data?.error ?? exec?.error ?? parsed.error ?? `agent_command HTTP ${status}`;
    return { ok: false, result: failure(message, classifyPlatformError(message), false, { httpStatus: status, commandId: exec?.commandId ?? null }) };
  }
  ctx.log.info('np-package-call.dispatched', { commandId: exec.commandId, agentId: exec.agentId, async });
  return { ok: true, exec };
}

function outputsFrom(exec: { commandId?: string; agentId?: string }, response: RunnerResponse, mode: NpPackageCallMode): { result: IStepResult } {
  const calls = Array.isArray(response.calls) ? response.calls : [];
  const failed = calls.filter((c) => c.ok === false).map((c) => c.id);
  const outputs = { commandId: exec.commandId ?? null, agentId: exec.agentId ?? null, response, calls, failed, mode };
  if (failed.length > 0) {
    return {
      result: {
        status: 'failure',
        outputs,
        error: { message: `calls failed: ${failed.join(', ')}`, code: NP_PACKAGE_CALL_ERROR_CODES.CALLS_FAILED, retryable: false, details: { failed } },
      },
    };
  }
  return { result: { status: 'success', outputs, activePorts: ['default'] } };
}
```

and the `execute` body:

```ts
  async execute(ctx: IStepExecutionContext): Promise<IStepResult> {
    const cfg = mergeConfig(this.#config ?? {}, ctx.inputs ?? {});
    const mode: NpPackageCallMode = cfg.mode ?? 'async';
    if (mode === 'sync') return this.#sync(ctx, cfg);
    return failure('async not implemented', NP_PACKAGE_CALL_ERROR_CODES.NOT_CONFIGURED, false);
  }

  async #sync(ctx: IStepExecutionContext, cfg: NpPackageCallConfig): Promise<IStepResult> {
    const d = await dispatch(ctx, cfg, cfg.action_context ?? {}, false);
    if (!d.ok) return d.result;
    const stdOut = d.exec.results?.stdOut ?? '';
    let response: RunnerResponse;
    try {
      response = JSON.parse(stdOut) as RunnerResponse;
    } catch {
      return failure(`runner stdout is not JSON: ${stdOut.slice(0, 200)}`, NP_PACKAGE_CALL_ERROR_CODES.BAD_RUNNER_OUTPUT, false, { stdErr: (d.exec.results?.stdErr ?? '').slice(0, 2000) });
    }
    return outputsFrom(d.exec, response, 'sync').result;
  }
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @nullplatform/workflow-core test -- np-package-call`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins/built-in/np-package-call
git commit -m "core: np-package-call sync mode (package-exec one-shot, stdout JSON)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `np-package-call` async two-phase mode

**Files:**
- Modify: `packages/core/src/plugins/built-in/np-package-call/plugin.ts`
- Modify: `__tests__/np-package-call.test.ts`

**Interfaces:**
- Consumes: `setPath`, `dispatch`, `outputsFrom` from Task 4.
- Produces: phase 1 returns `wait: { signalName: 'package-call.<stepId>', correlationKey: <executionId>, timeout, onTimeout: 'continue', resumeState: { token, commandId, agentId } }`; phase 2 verifies `payload.token`.

- [ ] **Step 1: Write the failing async tests**

```ts
describe('np-package-call — async phase 1', () => {
  it('injects the callback, dispatches with execution_config.async and returns a wait', async () => {
    fetchMock
      .mockResolvedValueOnce(json(TOKEN_RESPONSE))
      .mockResolvedValueOnce(json({ executions: [{ commandId: 'c1', agentId: 'a1', status: 'success' }] }));
    const p = new NpPackageCallPlugin();
    p.configure(baseConfig({ callback_base_url: 'http://host.docker.internal:3000', timeout: '10m' }));
    const r = await p.execute(phase1Ctx());
    expect(r.status).toBe('success');
    expect(r.wait).toEqual({
      signalName: 'package-call.query',
      correlationKey: 'ex_1',
      timeout: '10m',
      onTimeout: 'continue',
      resumeState: { token: 'tok_1', commandId: 'c1', agentId: 'a1' },
    });
    expect(r.outputs).toMatchObject({ commandId: 'c1', agentId: 'a1', dispatched: true });
    const body = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body));
    expect(body.execution_config).toEqual({ async: true, retry: { max_attempts: 1 } });
    const actionCtx = JSON.parse(body.command.data.environment.NP_ACTION_CONTEXT);
    expect(actionCtx.cloud_query.callback).toEqual({
      url: 'http://host.docker.internal:3000/workflows/webhooks/callback/ex_1/package-call.query',
      token: 'tok_1',
    });
    expect(actionCtx.cloud_query.calls).toHaveLength(1);
  });
  it('fails without waiting when the platform rejects the dispatch', async () => {
    fetchMock
      .mockResolvedValueOnce(json(TOKEN_RESPONSE))
      .mockResolvedValueOnce(json({ type: 'error', executions: [{ commandId: 'unknown', agentId: 'unknown', status: 'error', data: { error: 'Command failed to start after all retry attempts' } }] }, 500));
    const p = new NpPackageCallPlugin();
    p.configure(baseConfig());
    const r = await p.execute(phase1Ctx());
    expect(r.status).toBe('failure');
    expect(r.wait).toBeUndefined();
    expect(r.error?.code).toBe(NP_PACKAGE_CALL_ERROR_CODES.DISPATCH_FAILED);
  });
});

describe('np-package-call — async phase 2', () => {
  const RS = { token: 'tok_1', commandId: 'c1', agentId: 'a1' };
  it('accepts the callback payload with the right token and emits outputs', async () => {
    const p = new NpPackageCallPlugin();
    p.configure(baseConfig());
    const payload = { token: 'tok_1', provider: 'aws', calls: [{ id: 'who', ok: true, result: { Account: '1' } }] };
    const r = await p.execute(phase2Ctx({ signal: { name: 'package-call.query', payload }, resumeState: RS, phase: 2 }));
    expect(r.status).toBe('success');
    expect(r.wait).toBeUndefined();
    expect(r.outputs).toMatchObject({ commandId: 'c1', agentId: 'a1', failed: [], mode: 'async' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects a payload with a wrong or missing token', async () => {
    const p = new NpPackageCallPlugin();
    p.configure(baseConfig());
    const r = await p.execute(phase2Ctx({ signal: { name: 'package-call.query', payload: { token: 'forged', calls: [] } }, resumeState: RS, phase: 2 }));
    expect(r.status).toBe('failure');
    expect(r.error?.code).toBe(NP_PACKAGE_CALL_ERROR_CODES.CALLBACK_TOKEN_MISMATCH);
    expect(r.error?.retryable).toBe(false);
  });
  it('fails with TIMEOUT on the __timeout__ envelope', async () => {
    const p = new NpPackageCallPlugin();
    p.configure(baseConfig());
    const r = await p.execute(phase2Ctx({ signal: { name: '__timeout__' }, resumeState: RS, phase: 2 }));
    expect(r.status).toBe('failure');
    expect(r.error?.code).toBe(NP_PACKAGE_CALL_ERROR_CODES.TIMEOUT);
  });
  it('propagates CALLS_FAILED from the callback payload', async () => {
    const p = new NpPackageCallPlugin();
    p.configure(baseConfig());
    const payload = { token: 'tok_1', calls: [{ id: 'big', ok: false, errorCode: 'RESULT_TOO_LARGE' }] };
    const r = await p.execute(phase2Ctx({ signal: { name: 'package-call.query', payload }, resumeState: RS, phase: 2 }));
    expect(r.error?.code).toBe(NP_PACKAGE_CALL_ERROR_CODES.CALLS_FAILED);
    expect(r.outputs).toMatchObject({ failed: ['big'] });
  });
});
```

Check the `IStepResumeContext` fields with `sed -n 300,330p packages/sdk/src/types/execution.ts`; if `phase` is not a field, drop it from the test objects.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @nullplatform/workflow-core test -- np-package-call`
Expected: 6 new tests FAIL.

- [ ] **Step 3: Implement both phases**

Replace the `execute` method body and add the two phase methods:

```ts
  async execute(ctx: IStepExecutionContext): Promise<IStepResult> {
    const cfg = mergeConfig(this.#config ?? {}, ctx.inputs ?? {});
    const mode: NpPackageCallMode = cfg.mode ?? 'async';
    if (mode === 'sync') return this.#sync(ctx, cfg);
    return ctx.resume === undefined ? this.#phase1(ctx, cfg) : this.#phase2(ctx);
  }

  async #phase1(ctx: IStepExecutionContext, cfg: NpPackageCallConfig): Promise<IStepResult> {
    const signalName = `package-call.${ctx.stepId}`;
    const token = ctx.helpers.uuid();
    const base = (cfg.callback_base_url ?? DEFAULT_CALLBACK_BASE_URL).replace(/\/+$/, '');
    const url = `${base}/workflows/webhooks/callback/${encodeURIComponent(ctx.executionId)}/${signalName}`;
    const actionContext = setPath(cfg.action_context ?? {}, cfg.callback_key ?? DEFAULT_CALLBACK_KEY, { url, token });
    const d = await dispatch(ctx, cfg, actionContext, true);
    if (!d.ok) return d.result;
    return {
      status: 'success',
      outputs: { commandId: d.exec.commandId ?? null, agentId: d.exec.agentId ?? null, dispatched: true, mode: 'async' },
      wait: {
        signalName,
        correlationKey: ctx.executionId,
        timeout: cfg.timeout ?? DEFAULT_WAIT_TIMEOUT,
        onTimeout: 'continue',
        resumeState: { token, commandId: d.exec.commandId ?? null, agentId: d.exec.agentId ?? null },
      },
    };
  }

  async #phase2(ctx: IStepExecutionContext): Promise<IStepResult> {
    const resume = ctx.resume!;
    const rs = (resume.resumeState ?? {}) as { token?: string; commandId?: string | null; agentId?: string | null };
    if (resume.signal.name === '__timeout__') {
      return failure('timed out waiting for the package callback', NP_PACKAGE_CALL_ERROR_CODES.TIMEOUT, false, { commandId: rs.commandId ?? null, agentId: rs.agentId ?? null });
    }
    const payload = resume.signal.payload;
    if (!payload || typeof payload !== 'object') {
      return failure('callback payload is not an object', NP_PACKAGE_CALL_ERROR_CODES.BAD_RUNNER_OUTPUT, false);
    }
    const response = payload as RunnerResponse;
    if (typeof rs.token !== 'string' || response.token !== rs.token) {
      ctx.log.warn('np-package-call.callback-token-mismatch', { commandId: rs.commandId ?? null });
      return failure('callback token mismatch: ignoring payload', NP_PACKAGE_CALL_ERROR_CODES.CALLBACK_TOKEN_MISMATCH, false);
    }
    return outputsFrom({ commandId: rs.commandId ?? undefined, agentId: rs.agentId ?? undefined }, response, 'async').result;
  }
```

`outputsFrom` (Task 4) accepts `commandId?: string`; passing `undefined` for `null` keeps the type happy.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @nullplatform/workflow-core test -- np-package-call`
Expected: 11 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins/built-in/np-package-call
git commit -m "core: np-package-call async mode (two-phase wait, engine callback, per-dispatch token)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Register the plugin, lint, build, full core tests

**Files:**
- Modify: `packages/core/src/plugins/built-in/index.ts` (add `export * from './np-package-call/index.js';` next to the `np-agent-command` line)
- Modify: `packages/core/src/plugins/bootstrap.ts` (import `NpPackageCallPlugin` in the alphabetical import block after `NpAgentCommandPlugin`; add `NpPackageCallPlugin,` to the registration array after `NpAgentCommandPlugin,`)

- [ ] **Step 1: Write the failing registration test**

Append to the test file:

```ts
import { registerBuiltInPlugins } from '../../../bootstrap.js';
import { PluginRegistry } from '../../../registry.js';

describe('np-package-call — registration', () => {
  it('is registered by bootstrap', () => {
    const registry = new PluginRegistry();
    registerBuiltInPlugins(registry);
    expect(registry.get('np-package-call')).toBeDefined();
  });
});
```

Check the actual import paths and API with `grep -n "export function registerBuiltInPlugins" -A6 packages/core/src/plugins/bootstrap.ts` and `grep -rn "class PluginRegistry" packages/core/src/plugins/`; adapt the two imports and the lookup method name (`get`/`getDescriptor`/`has`) to what exists. If bootstrap needs more arguments, mirror an existing bootstrap test under `packages/core/src/plugins/__tests__/`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @nullplatform/workflow-core test -- np-package-call`
Expected: the registration test FAILS (plugin undefined).

- [ ] **Step 3: Register**

Apply the two edits listed under Files.

- [ ] **Step 4: Lint, build, full test**

```bash
pnpm -w run lint
pnpm --filter @nullplatform/workflow-core build
pnpm --filter @nullplatform/workflow-core test
pnpm tsx scripts/check-boundaries.ts
```
Expected: 0 lint errors, build ok, all core tests pass, boundaries ok. Fix Biome formatting with `pnpm -w run format` if lint complains about formatting.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins/built-in/index.ts packages/core/src/plugins/bootstrap.ts packages/core/src/plugins/built-in/np-package-call
git commit -m "core: register np-package-call built-in plugin

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `finops/tool-cloud-query.yaml` + E2E test (workflows repo)

**Files:**
- Create: `finops/tool-cloud-query.yaml`
- Create: `finops/__tests__/tool-cloud-query.e2e.test.ts`
- Create: `finops/README.md`

**Interfaces:**
- Consumes: plugin `np-package-call` (inputs `action_context`, `agent_selector`, `mode`; outputs `response`, `calls`, `failed`).
- Produces: workflow id `finops_cloud_query`; inputs `agent_tags`, `calls`, `region?`, `assume_role_arn?`, `mode?`; outputs `results` (map by call id), `identity`, `failed`.

- [ ] **Step 1: Write the workflow**

```yaml
# finops/tool-cloud-query.yaml
#
# Reusable child: run a list of cloud SDK calls through the `cloud-query`
# package on an agent selected by tags, and return results keyed by call id.
# Async by default (np-package-call two-phase wait + engine callback); sync
# only for small, fast calls (<60 s, <300 KB).
id: finops_cloud_query
name: "FinOps — Cloud Query (tool)"
description: >
  Runs cloud SDK calls (Cost Explorer, CloudWatch, EC2, STS) on a customer
  agent through the cloud-query package and returns the raw responses keyed
  by call id. Called by the FinOps collectors and usable as an agent tool.
path: "/finops"
semantic_version: 0.1.0

inputs:
  agent_tags:
    type: object
    required: true
    description: "Agent selector tags, e.g. {\"package\":\"cloud-query\"}"
  calls:
    type: array
    required: true
    description: "cloud-query calls: [{id, service, operation, params?, paginate?, maxPages?}]"
  region:
    type: string
    required: false
    description: "AWS region for regional services (Cost Explorer is global)"
  assume_role_arn:
    type: string
    required: false
    description: "Optional role the worker assumes before the calls"
  mode:
    type: string
    required: false
    description: "async (default) or sync"

variables:
  # The engine base URL the WORKER must reach to deliver the callback.
  # Locally (docker worker → dev-server on the laptop): http://host.docker.internal:3000
  callback_base_url:
    initialValue: "https://api.nullplatform.com"

steps:
  - id: start
    type: trigger
    plugin_type: manual
    name: "Query"
    config:
      description: "Run cloud SDK calls through the cloud-query package."
      inputs:
        agent_tags: { type: object, required: true, description: "Agent selector tags" }
        calls: { type: array, required: true, description: "cloud-query calls" }
        region: { type: string, required: false, description: "AWS region" }
        assume_role_arn: { type: string, required: false, description: "Role ARN to assume" }
        mode: { type: string, required: false, description: "async | sync" }

  - id: build_request
    type: module
    plugin_type: code-exec
    name: "Build cloud-query request"
    inputs:
      calls: "${{ workflow.inputs.calls }}"
      region: "${{ workflow.inputs.region }}"
      assume_role_arn: "${{ workflow.inputs.assume_role_arn }}"
      mode: "${{ workflow.inputs.mode }}"
    config:
      language: javascript
      code: |
        var calls = Array.isArray(inputs.calls) ? inputs.calls : [];
        if (calls.length === 0) throw new Error("calls must be a non-empty array");
        var cq = { provider: "aws", calls: calls };
        if (inputs.region) cq.region = String(inputs.region);
        if (inputs.assume_role_arn) cq.assumeRole = { roleArn: String(inputs.assume_role_arn), sessionName: "np-finops" };
        return { action_context: { cloud_query: cq }, mode: inputs.mode === "sync" ? "sync" : "async" };

  - id: call_package
    type: module
    plugin_type: np-package-call
    name: "cloud-query (package-exec)"
    inputs:
      action_context: "${{ steps.build_request.outputs.action_context }}"
      agent_selector: "${{ workflow.inputs.agent_tags }}"
      mode: "${{ steps.build_request.outputs.mode }}"
    config:
      apikey: "${{ secrets.NP_API_KEY }}"
      package: cloud-query
      # Placeholder so validateConfig() passes; inputs.agent_selector replaces it at run time.
      agent_selector:
        tags:
          package: cloud-query
      action_context: {}
      callback_base_url: "${{ variables.callback_base_url }}"
      timeout: "30m"
      retry_max_attempts: 1

  - id: shape_results
    type: module
    plugin_type: code-exec
    name: "Results by call id"
    inputs:
      response: "${{ steps.call_package.outputs.response }}"
      failed: "${{ steps.call_package.outputs.failed }}"
    config:
      language: javascript
      code: |
        var r = inputs.response || {};
        var out = {};
        (r.calls || []).forEach(function (c) { out[c.id] = c.ok ? c.result : { error: c.error, errorCode: c.errorCode }; });
        return { results: out, identity: r.identity || null, failed: inputs.failed || [] };

connections:
  - { from: start, to: build_request }
  - { from: build_request, to: call_package }
  - { from: call_package, to: shape_results }

outputs:
  results: "${{ steps.shape_results.outputs.results }}"
  identity: "${{ steps.shape_results.outputs.identity }}"
  failed: "${{ steps.shape_results.outputs.failed }}"
```

Check the `agent_selector` input override in Task 4's `mergeConfig`: the YAML passes `workflow.inputs.agent_tags` (a tags map) as `agent_selector`. Adjust `mergeConfig` so that when `inputs.agent_selector` has no `tags` key it is treated as the tags map: `out.agent_selector = 'tags' in sel ? sel : { tags: sel }`. Add a unit test for that in the engine test file (`it('accepts a bare tags map as agent_selector input')`).

- [ ] **Step 2: Validate**

Run: `cd /Users/geisbruch/workspace/null/workflows/.worktrees/cost-v2 && npx np-workflow validate finops/tool-cloud-query.yaml`
Expected: valid. If `np-workflow` reports `np-package-call` as an unknown plugin, its plugin catalog comes from the published engine; note it and continue (the E2E test in Step 3 runs against the local engine sources).

Check how existing suites resolve plugins in tests: `grep -n "runWorkflowE2E\|pluginMocks\|mockPlugin" cost/__tests__/cost.e2e.test.ts | head` and mirror the mocking API exactly.

- [ ] **Step 3: Write the E2E test**

```ts
// finops/__tests__/tool-cloud-query.e2e.test.ts
import { describe, expect, it } from 'vitest';
import { runWorkflowE2E } from '@nullplatform/workflow-test';

const RESPONSE = {
  provider: 'aws',
  identity: { account: '688720756067' },
  calls: [
    { id: 'who', ok: true, pages: 1, durationMs: 5, result: { Account: '688720756067' } },
    { id: 'cost', ok: true, pages: 1, durationMs: 9, result: { ResultsByTime: [{ Total: { UnblendedCost: { Amount: '1.5' } } }] } },
  ],
};

describe('finops/tool-cloud-query', () => {
  it('returns results keyed by call id', async () => {
    const run = await runWorkflowE2E({
      workflow: 'finops/tool-cloud-query.yaml',
      inputs: { agent_tags: { package: 'cloud-query' }, calls: [{ id: 'who', service: 'sts', operation: 'GetCallerIdentity' }, { id: 'cost', service: 'ce', operation: 'GetCostAndUsage' }] },
      pluginMocks: {
        'np-package-call': async (ctx) => {
          const ac = ctx.inputs.action_context as { cloud_query: { calls: unknown[] } };
          expect(ac.cloud_query.calls).toHaveLength(2);
          expect(ctx.inputs.agent_selector).toEqual({ package: 'cloud-query' });
          return { status: 'success', outputs: { commandId: 'c1', agentId: 'a1', response: RESPONSE, calls: RESPONSE.calls, failed: [], mode: 'async' } };
        },
      },
    });
    expect(run.status).toBe('completed');
    expect(run.outputs.results).toEqual({ who: { Account: '688720756067' }, cost: { ResultsByTime: [{ Total: { UnblendedCost: { Amount: '1.5' } } }] } });
    expect(run.outputs.identity).toEqual({ account: '688720756067' });
    expect(run.outputs.failed).toEqual([]);
  });
  it('fails the run when calls is empty', async () => {
    const run = await runWorkflowE2E({ workflow: 'finops/tool-cloud-query.yaml', inputs: { agent_tags: { package: 'cloud-query' }, calls: [] }, pluginMocks: {} });
    expect(run.status).toBe('failed');
  });
});
```

Adapt `runWorkflowE2E` options to the real signature found in `cost/__tests__/cost.e2e.test.ts` (path base, mocks key, result field names). Keep the assertions.

- [ ] **Step 4: Run the tests**

Run: `npx vitest finops`
Expected: 2 pass. If the harness resolves plugins from the published `@nullplatform/workflow-kit` and `np-package-call` is unknown there, link the local engine per `AUTHORING.md` (search it for "link" / "local engine") and re-run; document the exact command in `finops/README.md`.

- [ ] **Step 5: Write `finops/README.md`**

```markdown
# FinOps suite (phase 0)

Cloud billing through an agent-run package, daily cost facts, allocation to
applications. Design: `docs/superpowers/specs/2026-09-10-finops-cost-allocation-design.md`.

| Piece | What it is |
|---|---|
| `packages/cloud-query/` | The runner package (generic AWS SDK call executor). See its README. |
| `tool-cloud-query.yaml` | Reusable child workflow: agent tags + calls → results by call id (async with callback by default) |
| `__tests__/` | E2E tests on the local executor with `np-package-call` mocked at the plugin level |

Engine dependency: plugin `np-package-call` (workflow-system-demo, branch `feat/np-package-call`).

## Local loop

1. Engine: `cd workflow-system-demo/.worktrees/np-package-call && WORKFLOW_SECRET_GLOBAL_NP_API_KEY=$NP_API_KEY WORKFLOW_INTER_SERVICE_SECRET=<32+ chars> pnpm tsx scripts/dev-server.ts`
2. Agent: `cd finops/packages/cloud-query && mise run run` (see its README for the env vars)
3. Publish the tool to the local engine with `callback_base_url` = `http://host.docker.internal:3000` and execute it (Task 8 of the phase-0 plan has the exact curl).
```

- [ ] **Step 6: Commit**

```bash
git add finops/tool-cloud-query.yaml finops/__tests__ finops/README.md
git commit -m "finops: tool-cloud-query child workflow + E2E test

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Live run against the local dev-server and the local agent

**Files:**
- Modify (if needed): `finops/README.md` with the verified commands.

- [ ] **Step 1: Start the engine from the plugin worktree**

```bash
cd /Users/geisbruch/workspace/null/workflow-system-demo/.worktrees/np-package-call
lsof -i :3000 -t | xargs kill 2>/dev/null
export NP_API_KEY=$(grep -E '^NP_API_KEY=' ../../.env | cut -d= -f2- | tr -d '"')
WORKFLOW_SECRET_GLOBAL_NP_API_KEY="$NP_API_KEY" WORKFLOW_INTER_SERVICE_SECRET=local-dev-inter-service-secret-0123456789 \
  nohup pnpm tsx scripts/dev-server.ts > /tmp/dev-server.log 2>&1 &
timeout 60 tail -f /tmp/dev-server.log | grep -m1 -i "listening"
curl -s http://localhost:3000/workflows/plugins | python3 -c "import json,sys; d=json.load(sys.stdin); print([p['name'] for p in (d.get('data') or d) if 'package' in p['name']])"
```
Expected: `['np-package-call']`. If the plugins route needs auth or a different path, read `packages/core/src/api/routes/` for the plugins route and the local auth mode (`WORKFLOW_ORGANIZATION_MODE`), and record the working call in `finops/README.md`.

- [ ] **Step 2: Start the local agent**

```bash
cd /Users/geisbruch/workspace/null/workflows/.worktrees/cost-v2/finops/packages/cloud-query
export NP_WORKER_AWS_ACCESS_KEY_ID=$(aws configure get aws_access_key_id --profile kwik_admin)
export NP_WORKER_AWS_SECRET_ACCESS_KEY=$(aws configure get aws_secret_access_key --profile kwik_admin)
PATH="$HOME/.local/share/mise/shims:$PATH" mise run run
timeout 40 docker logs -f np-cloud-query-agent 2>&1 | grep -m1 'Successfully connected'
```

- [ ] **Step 3: Publish the tool workflow to the local engine**

```bash
cd /Users/geisbruch/workspace/null/workflows/.worktrees/cost-v2
# Normalize YAML → IWorkflowDefinition with the DSL, then create + alias + activate on the LOCAL engine.
# Use the repo's own publisher pointed at localhost (AUTHORING.md / np-workflow skill: NP_WORKFLOW_URL):
NP_WORKFLOW_URL=http://localhost:3000 npx np-workflow publish finops/tool-cloud-query.yaml --alias live
```
Expected: a `wf_…` id printed. Record it as `$WF`. If the publisher cannot target localhost, fall back to `POST http://localhost:3000/workflows/definitions` with the JSON produced by `normalizeWorkflowDocument` (`packages/dsl/src/yaml`) from the engine worktree: `pnpm tsx -e "..."`; then `POST /workflows/definitions/$WF/aliases {name:'live', revision}` and `POST /workflows/definitions/$WF/aliases/live/activate`.

- [ ] **Step 4: Patch `callback_base_url` for the local worker and execute (async)**

Execute with an override of the variable (the child accepts variables via the execute body; if not, republish with `initialValue: http://host.docker.internal:3000` for the local run):

```bash
curl -s -X POST "http://localhost:3000/workflows/definitions/$WF/execute" -H 'Content-Type: application/json' -d '{
  "inputs": { "agent_tags": {"package":"cloud-query","local":"geisbruch"},
              "calls": [ {"id":"who","service":"sts","operation":"GetCallerIdentity"},
                         {"id":"by_service","service":"ce","operation":"GetCostAndUsage","params":{"TimePeriod":{"Start":"2026-09-08","End":"2026-09-09"},"Granularity":"DAILY","Metrics":["UnblendedCost"],"GroupBy":[{"Type":"DIMENSION","Key":"SERVICE"}]}} ] },
  "variables": { "callback_base_url": "http://host.docker.internal:3000" } }'
```
Then poll `GET /workflows/executions/:id` until terminal (≤ 60 s) and print `outputs.results.by_service.ResultsByTime[0].Groups | length` and `outputs.identity`.
Expected: status `completed`, identity account `688720756067`, ≥ 8 groups. Also verify on the agent: `docker logs np-cloud-query-agent | grep -c 'Starting command'` increments by exactly 1 (no re-delivery), and `docker logs <worker> | tail -3` shows `callback delivered (HTTP 200)`.

- [ ] **Step 5: Sync mode and oversized call**

Run the same execute with `"mode": "sync"` and only the `who` call → expect `completed` within 10 s.
Run async with a call that exceeds the cap (60 days, DAILY, `SERVICE`+`USAGE_TYPE`, `maxPages: 50`) → expect the execution to end `failed` with `NP_PACKAGE_CALL_CALLS_FAILED` and `failed: ["big"]`, delivered via the callback (the worker logs `RESULT_TOO_LARGE`), and `Starting command` on the agent incremented by exactly 1.

- [ ] **Step 6: Record and commit**

Update `finops/README.md` "Local loop" with the exact commands that worked (publish command, execute body, variable override). Commit:

```bash
git add finops/README.md
git commit -m "finops: local loop verified (dev-server + local agent, async callback)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 7: Engine PR readiness**

In the engine worktree: `pnpm -w run lint && pnpm -w run build && pnpm -w run test` all green; `git log --oneline main..` shows the four core commits. Do NOT push or open the PR until Gabriel says so.

---

## Self-review

- Spec coverage: 4.1 callback + token echo (Task 1), local run task (Task 2, spec §9), 4.2 plugin config/sync/async/token/timeout/retry=1 (Tasks 3-6), 4.3 child workflow with inputs/outputs (Task 7), phase 0 acceptance (Task 8: async callback, sync small call, oversized fails with no re-delivery). Registration and boundaries (Task 6). Phases 1-4 of the spec are out of this plan by design.
- Placeholders: none; every code step has the code. Two steps ask the executor to verify a real signature (`runWorkflowE2E` options, `IStepResumeContext.phase`, registry lookup) and give the grep to do it.
- Type consistency: `NpPackageCallConfig` fields match the descriptor schema keys; `dispatch` returns `{ok, exec}`/`{ok:false, result}` in both call sites; `outputsFrom(exec, response, mode)` used by sync and phase 2; `setPath` used by phase 1; runner `callback`/`token` names match between package (`callback.ts`, `runner.ts`, `index.ts`) and plugin (`callback_key` default `cloud_query.callback`, `response.token`).
