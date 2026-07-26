#!/usr/bin/env node
/**
 * Inlines `scanner/scanner.mjs` + `scanner/driver.mjs` into the `code:` block of
 * the `scan` step in `wf-l1-backfill.yaml`.
 *
 * `code-exec` has no include mechanism — the body is a literal string in the
 * YAML. Keeping the logic in a real module and generating the YAML means the
 * scanner stays unit-testable and the two can never drift.
 *
 * Usage:  node workflows/lib-inventory/scripts/build-workflow.mjs [--check]
 * `--check` exits non-zero if the YAML is stale (for CI / pre-commit).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const YAML_PATH = path.join(ROOT, 'wf-l1-backfill.yaml');
// The markers live INSIDE the YAML block scalar, so they must be valid
// JavaScript comments — a `#` here reaches the sandbox verbatim and dies with
// "Invalid or unexpected token" (hit live, 2026-07-26).
const BEGIN = '// >>> GENERATED: scanner (build-workflow.mjs) — do not edit by hand';
const END = '// <<< END GENERATED';
const INDENT = ' '.repeat(8);

/** Strip ESM syntax the sandbox does not accept; the body is a function body. */
function toSandboxSource(src) {
  return src
    .replace(/^export\s+(const|function|class|async function)\b/gm, '$1')
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
    .replace(/^import\s[^;]*;\s*$/gm, '');
}

const scanner = toSandboxSource(fs.readFileSync(path.join(ROOT, 'scanner/scanner.mjs'), 'utf8'));
const driver = toSandboxSource(fs.readFileSync(path.join(ROOT, 'scanner/driver.mjs'), 'utf8'));

const body = `${scanner}\n// ----------------------------------------------------------- driver ---\n${driver}`;

// Compile the body exactly as the sandbox does before it can reach the YAML.
// The sandbox wraps it in an AsyncFunction, so top-level `await` is legal here
// even though `node --check` would reject the same text as a script.
// Without this gate a syntax error only surfaces as a SANDBOX_RUNTIME failure
// after an upload, an alias repoint and a live run.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
try {
  new AsyncFunction('inputs', 'log', 'console', body);
} catch (err) {
  console.error(`FAILED: generated scanner body does not compile — ${err.message}`);
  process.exit(1);
}
const block = [
  INDENT + BEGIN,
  ...body.split('\n').map((l) => (l.trim().length ? INDENT + l : '')),
  INDENT + END,
].join('\n');

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const yaml = fs.readFileSync(YAML_PATH, 'utf8');
const re = new RegExp(`${esc(INDENT + BEGIN)}[\\s\\S]*?${esc(INDENT + END)}`);
if (!re.test(yaml)) {
  console.error(`FAILED: markers not found in ${YAML_PATH}`);
  console.error(`Expected a line "${INDENT}${BEGIN}" ... "${INDENT}${END}" inside the scan step's code block.`);
  process.exit(1);
}
const next = yaml.replace(re, () => block);

if (process.argv.includes('--check')) {
  if (next !== yaml) {
    console.error('STALE: wf-l1-backfill.yaml does not match scanner/. Run: node workflows/lib-inventory/scripts/build-workflow.mjs');
    process.exit(1);
  }
  console.log('wf-l1-backfill.yaml is in sync with scanner/');
  process.exit(0);
}

fs.writeFileSync(YAML_PATH, next);
console.log(`inlined ${body.split('\n').length} lines of scanner into ${path.relative(process.cwd(), YAML_PATH)}`);
