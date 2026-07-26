#!/usr/bin/env node
/**
 * Inlines the scanner into the `code-exec` steps of `wf-l0-scan-build.yaml`.
 *
 * `code-exec` has no include mechanism — a step's body is a literal string in
 * the YAML. Keeping the logic in real modules and GENERATING the YAML means the
 * scanner stays unit-testable and the two can never drift.
 *
 * Each step gets ONLY the `lib/` modules it uses. That is the whole reason the
 * scanner is split into small modules: inlining one 600-line file into all five
 * steps would have made the YAML worse than the monolith it replaced.
 *
 * Usage:  node workflows/lib-inventory/scripts/build-workflow.mjs [--check]
 * `--check` exits non-zero if the YAML is stale (CI / pre-commit).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const YAML_PATH = path.join(ROOT, 'wf-l0-scan-build.yaml');
const INDENT = ' '.repeat(8);

/**
 * step id -> [lib modules…, step body]. Order matters: a module must appear
 * before the one that uses it, since the inlined text has no imports.
 */
const STEPS = {
  plan_tree_fetches: ['manifests', 'blobs', 'plan', 'steps/plan-tree-fetches'],
  plan_manifest_fetches: ['manifests', 'blobs', 'plan', 'steps/plan-manifest-fetches'],
  resolve_assets: ['manifests', 'resolve', 'blobs', 'resolveplans', 'steps/resolve-assets'],
  parse_go: ['manifests', 'parsers', 'parseeco', 'steps/parse-go'],
  parse_node: ['manifests', 'parsers', 'parseeco', 'steps/parse-node'],
  build_payloads: ['manifests', 'payload', 'buildpay', 'steps/build-payloads'],
};

/** Strip ESM syntax the sandbox does not accept; a body is a function body. */
function toSandboxSource(src) {
  return src
    .replace(/^export\s+(const|function|class|async function)\b/gm, '$1')
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
    .replace(/^export\s+\*\s+from\s[^;]*;\s*$/gm, '')
    .replace(/^import\s[^;]*;\s*$/gm, '');
}

function read(name) {
  const file = name.startsWith('steps/')
    ? path.join(ROOT, 'scanner', `${name}.mjs`)
    : path.join(ROOT, 'scanner', 'lib', `${name}.mjs`);
  return toSandboxSource(fs.readFileSync(file, 'utf8'))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

let yaml = fs.readFileSync(YAML_PATH, 'utf8');
const report = [];

for (const [stepId, modules] of Object.entries(STEPS)) {
  const BEGIN = `// >>> GENERATED ${stepId} — do not edit by hand (build-workflow.mjs)`;
  const END = `// <<< END ${stepId}`;
  const body = modules.map(read).join('\n\n');

  // Compile exactly as the sandbox does before this can reach the YAML. The
  // sandbox wraps the text in an AsyncFunction, so top-level `await` is legal
  // here even though `node --check` would reject it as a script. Without this
  // gate a syntax error only surfaces as SANDBOX_RUNTIME after an upload, an
  // alias repoint and a live run.
  try {
    new AsyncFunction('inputs', 'log', 'console', body);
  } catch (err) {
    console.error(`FAILED: ${stepId} body does not compile — ${err.message}`);
    process.exit(1);
  }

  const block = [
    INDENT + BEGIN,
    ...body.split('\n').map((l) => (l.trim().length ? INDENT + l : '')),
    INDENT + END,
  ].join('\n');

  const re = new RegExp(`${esc(INDENT + BEGIN)}[\\s\\S]*?${esc(INDENT + END)}`);
  if (!re.test(yaml)) {
    console.error(`FAILED: markers for "${stepId}" not found in ${YAML_PATH}`);
    console.error(`Expected "${INDENT}${BEGIN}" … "${INDENT}${END}" inside its code block.`);
    process.exit(1);
  }
  yaml = yaml.replace(re, () => block);
  report.push(`${stepId}: ${body.split('\n').length} lines (${modules.join(' + ')})`);
}

const current = fs.readFileSync(YAML_PATH, 'utf8');
if (process.argv.includes('--check')) {
  if (yaml !== current) {
    console.error('STALE: wf-l0-scan-build.yaml does not match scanner/. Run build-workflow.mjs');
    process.exit(1);
  }
  console.log('wf-l0-scan-build.yaml is in sync with scanner/');
  process.exit(0);
}

fs.writeFileSync(YAML_PATH, yaml);
for (const line of report) console.log(`  ${line}`);
