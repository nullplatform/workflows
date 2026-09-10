/**
 * Publish the finops workflows to a LOCAL engine (dev-server) in dependency
 * order, patching the sub-workflow placeholders with the ids the engine
 * assigns. Needed because `npx np-workflow publish` validates against the
 * published engine's plugin catalog (no `np-package-call` there yet).
 *
 * Run from the ENGINE worktree so the DSL parser resolves:
 *   cd ~/workspace/null/workflow-system-demo/.worktrees/np-package-call
 *   pnpm tsx ~/workspace/null/workflows/.worktrees/cost-v2/finops/setup/publish-local.ts \
 *     ~/workspace/null/workflows/.worktrees/cost-v2/finops http://127.0.0.1:3210
 * Prints one line per workflow: <file> <id>. Alias `live` is created + activated.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dir, base = 'http://127.0.0.1:3210', alias = 'live'] = process.argv.slice(2);
if (!dir) throw new Error('usage: publish-local.ts <finops dir> [engine base url] [alias]');

// The engine's DSL parser, resolved from the CURRENT directory (the engine worktree).
const dsl = (await import(pathToFileURL(resolve(process.cwd(), 'packages/dsl/src/yaml/parser.ts')).href)) as {
  parseYamlWorkflow: (input: string) => unknown;
};
const { parseYamlWorkflow } = dsl;

// file → placeholder its id fills in dependents
const ORDER: Array<{ file: string; placeholder?: string }> = [
  { file: 'tool-cloud-query.yaml', placeholder: 'FINOPS_CLOUD_QUERY_ID' },
  { file: 'wf-cost-fact-upsert.yaml', placeholder: 'FINOPS_COST_FACT_UPSERT_ID' },
  { file: 'wf1-aws-billing-daily.yaml' },
];

async function api(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${text.slice(0, 600)}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

const ids: Record<string, string> = {};
for (const { file, placeholder } of ORDER) {
  let yaml = readFileSync(resolve(dir, file), 'utf8');
  for (const [ph, id] of Object.entries(ids)) yaml = yaml.split(ph).join(id);
  const parsed = parseYamlWorkflow(yaml) as Record<string, unknown>;
  if (Array.isArray(parsed.errors) && parsed.errors.length) throw new Error(`${file}: ${JSON.stringify(parsed.errors).slice(0, 600)}`);
  const def = (parsed.definition ?? parsed.workflow ?? parsed.value ?? parsed) as Record<string, unknown>;
  const created = await api('POST', '/workflows/definitions', def);
  const wf = (created.workflow ?? created) as Record<string, unknown>;
  const revObj = created.revision as Record<string, unknown> | number | undefined;
  const id = String(wf.id);
  const revision = typeof revObj === 'number' ? revObj : Number((revObj as Record<string, unknown> | undefined)?.revision ?? 1);
  await api('POST', `/workflows/definitions/${id}/aliases`, { name: alias, revision });
  await api('POST', `/workflows/definitions/${id}/aliases/${alias}/activate`, {});
  if (placeholder) ids[placeholder] = id;
  console.log(`${file} ${id}`);
}
