# Building, testing and shipping workflows

This repo is **executable documentation**: every suite here runs on your
machine with the same engine code and the same test harness the platform
team uses. This guide is the full loop — author → validate → test → publish.

## Setup (once)

```bash
git clone https://github.com/nullplatform/workflows && cd workflows
npm install        # pulls @nullplatform/workflow-kit + vitest
```

`@nullplatform/workflow-kit` is served from GitHub Packages during the
pilot, so `npm install` needs a GitHub token with `read:packages` once:

```bash
npm config set //npm.pkg.github.com/:_authToken YOUR_GITHUB_TOKEN
# or, with the gh CLI: npm config set //npm.pkg.github.com/:_authToken $(gh auth token)
```

Auth for anything that talks to the platform (publish/run): set `NP_API_KEY`
(an org API key — exchanged automatically) or `NP_TOKEN` in your environment.

## Run the suites' own tests

```bash
npx vitest                 # every suite's E2E tests, on the local executor
npx vitest cost            # one suite
npx vitest -t "prices the day"   # one test
```

No cluster, no credentials, no network: the tests stub the integration
plugins at the PLUGIN level (`np-api-call`, `np-agent-command`, the AI
agent…) and run the real engine underneath — graph routing, joins, loops,
expressions, fan-out are all the production code paths.

## Author a workflow

1. Start from the nearest suite — copy its YAML and its test file. The
   suites encode the house patterns: streaming pagination
   (`paginated-fetch` → per-item work → accumulator → summary), catalog
   metadata as durable state, action items with idempotency keys, deciders
   and joins, error routing via `error_handling.fallback_step`.
2. Credentials NEVER go in YAML. Reference config entries:
   `${{ secrets.NAME }}` (write-only) and `${{ vars.NAME }}`.
3. Validate as you go:

```bash
npx np-workflow validate my-suite/wf1-my-workflow.yaml
```

`validate` runs the same pipeline publishing runs (parse → normalize →
schema) plus TWO graph passes: create-time knowledge and the hosted
runtime's knowledge — anything flagged `runtime-parity` would have passed
submit and failed in production.

## Test your workflow

Write a vitest file next to your YAML (`my-suite/__tests__/`). The harness
takes YAML in, returns the execution result:

```ts
import { runWorkflowE2E } from '@nullplatform/workflow-kit/test';

const result = await runWorkflowE2E({
  yamlPath: new URL('../wf1-my-workflow.yaml', import.meta.url).pathname,
  inputs: { scope_id: '123' },
  stubs: {
    'np-api-call': async (step, ctx) => {
      if (step.id === 'fetch_scope') return { outputs: { scope: { id: '123' } } };
      throw new Error(`unexpected np-api-call step: ${step.id}`);
    },
  },
});
expect(result.status).toBe('completed');
```

Stub at the plugin level, assert on outputs/steps/variables. Every test in
this repo is an example of the pattern — `cost/__tests__/cost.e2e.test.ts`
is the most complete (fan-out, deciders, portfolio aggregation, per-pod
math).

## Publish and run on the platform

```bash
npx np-workflow publish my-suite/wf1-my-workflow.yaml --alias live   # new revision + alias + activate
npx np-workflow run wf1_my_workflow --inputs '{"scope_id":"123"}'    # execute + poll
```

Publishing validates first and surfaces `CONFIG_ENTRY_UNRESOLVED` warnings
when a referenced secret/var has no value yet — set the config entry and
re-run (no republish needed). Suites with setup scripts (`cost/setup/`,
`runtime-lifecycle/setup/`) document their own bring-up order in their
READMEs (catalog specs, config entries, categories, upload order).

## Suite anatomy (what "done" looks like)

```
my-suite/
  README.md          what it does, config entries it needs, bring-up order
  wf1-*.yaml         the workflows (credentials only as ${{ secrets.* }})
  __tests__/         vitest E2E — every workflow that GENERATES something has one
  setup/             idempotent bring-up scripts (optional)
  docs/              architecture / decisions when the suite warrants it
```
