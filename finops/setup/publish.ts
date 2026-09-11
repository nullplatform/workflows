/**
 * Publish the finops workflows to an engine (local dev-server OR the platform)
 * in dependency order, patching the sub-workflow placeholders with the ids the
 * engine assigns. Needed because `npx np-workflow publish` validates against a
 * plugin catalog that may not know `np-package-call` yet.
 *
 * Run from the ENGINE worktree so the DSL parser resolves:
 *   cd ~/workspace/null/workflow-system-demo
 *   NP_TOKEN=<session bearer> pnpm tsx ~/workspace/null/workflows/finops/setup/publish.ts \
 *     ~/workspace/null/workflows/finops \
 *     --base https://api.nullplatform.com \
 *     --vars ~/workspace/null/workflows/finops/setup/vars.nullplatform.json \
 *     [--alias live] [--no-activate] [--update <file>=<wf_id>,...]
 *
 * --vars   JSON {"<workflow id>": {"<variable>": <initialValue>, …}} — per-org
 *          values (agent tags/NRN, org NRN, expected account, dispatcher
 *          targets). Definitions in git keep neutral defaults.
 * --update re-publish as a NEW REVISION of an existing definition (PUT) instead
 *          of creating one; the alias is re-pointed to the new revision.
 * --no-activate  create the alias but do not activate it (crons stay off).
 * Prints one line per workflow: <file> <id> <revision>.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const dir = args[0];
if (!dir || dir.startsWith('--')) throw new Error('usage: publish.ts <finops dir> [--base url] [--alias name] [--vars file] [--no-activate] [--update file=id,...]');
function opt(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const base = opt('--base') ?? 'http://127.0.0.1:3210';
const alias = opt('--alias') ?? 'live';
const activate = !args.includes('--no-activate');
const varsFile = opt('--vars');
const vars: Record<string, Record<string, unknown>> = varsFile ? (JSON.parse(readFileSync(resolve(varsFile), 'utf8')) as Record<string, Record<string, unknown>>) : {};
const updates: Record<string, string> = {};
for (const pair of (opt('--update') ?? '').split(',').filter(Boolean)) {
  const [file, id] = pair.split('=');
  if (file && id) updates[file] = id;
}
const token = process.env.NP_TOKEN;

// The engine's DSL parser, resolved from the CURRENT directory (the engine worktree).
const dsl = (await import(pathToFileURL(resolve(process.cwd(), 'packages/dsl/src/yaml/parser.ts')).href)) as {
  parseYamlWorkflow: (input: string) => unknown;
};
const { parseYamlWorkflow } = dsl;

// file → placeholder its id fills in dependents
const ORDER: Array<{ file: string; placeholder?: string }> = [
  { file: 'tool-cloud-query.yaml', placeholder: 'FINOPS_CLOUD_QUERY_ID' },
  { file: 'wf-cost-fact-upsert.yaml', placeholder: 'FINOPS_COST_FACT_UPSERT_ID' },
  { file: 'wf1-aws-billing-daily.yaml', placeholder: 'FINOPS_AWS_BILLING_DAILY_ID' },
  { file: 'wf-suggest-mappings.yaml', placeholder: 'FINOPS_SUGGEST_MAPPINGS_ID' },
  { file: 'wf3-k8s-consumption-daily.yaml', placeholder: 'FINOPS_K8S_CONSUMPTION_ID' },
  { file: 'wf2-allocate-daily.yaml', placeholder: 'FINOPS_ALLOCATE_DAILY_ID' },
  { file: 'wf0-aws-billing-dispatch.yaml' },
];

async function api(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${text.slice(0, 600)}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/** Apply per-org variable values: definition.variables[name].initialValue. */
function applyVars(def: Record<string, unknown>): void {
  const overrides = vars[String(def.id)] ?? vars[String(def.clientKey ?? '')];
  if (!overrides) return;
  const variables = (def.variables ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, value] of Object.entries(overrides)) {
    if (!variables[name]) throw new Error(`${def.id}: --vars sets unknown variable "${name}"`);
    variables[name] = { ...variables[name], initialValue: value };
  }
  def.variables = variables;
}

const ids: Record<string, string> = {};
for (const { file, placeholder } of ORDER) {
  let yaml = readFileSync(resolve(dir, file), 'utf8');
  for (const [ph, id] of Object.entries(ids)) yaml = yaml.split(ph).join(id);
  const parsed = parseYamlWorkflow(yaml) as Record<string, unknown>;
  if (Array.isArray(parsed.errors) && parsed.errors.length) throw new Error(`${file}: ${JSON.stringify(parsed.errors).slice(0, 600)}`);
  const def = (parsed.definition ?? parsed.workflow ?? parsed.value ?? parsed) as Record<string, unknown>;
  applyVars(def);
  const existing = updates[file];
  const created = existing ? await api('PUT', `/workflows/definitions/${existing}`, def) : await api('POST', '/workflows/definitions', def);
  const wf = (created.workflow ?? created) as Record<string, unknown>;
  const revObj = created.revision as Record<string, unknown> | number | undefined;
  const id = String(existing ?? wf.id);
  const revision = typeof revObj === 'number' ? revObj : Number((revObj as Record<string, unknown> | undefined)?.revision ?? wf.revision ?? 1);
  if (existing) {
    // Re-point the alias to the new revision (PUT /aliases/:alias); create it if the definition had none.
    try {
      await api('PUT', `/workflows/definitions/${id}/aliases/${alias}`, { revision });
    } catch (err) {
      if (!/404/.test(String(err))) throw err;
      await api('POST', `/workflows/definitions/${id}/aliases`, { name: alias, revision });
    }
  } else {
    await api('POST', `/workflows/definitions/${id}/aliases`, { name: alias, revision });
  }
  if (activate) await api('POST', `/workflows/definitions/${id}/aliases/${alias}/activate`, {});
  if (placeholder) ids[placeholder] = id;
  console.log(`${file} ${id} ${revision}`);
}
