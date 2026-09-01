/**
 * Library inventory scanner — barrel.
 *
 * The logic lives in `lib/*.mjs`, one module per concern. That split is not
 * cosmetic: `code-exec` has no include mechanism, so each workflow step inlines
 * only the modules it actually uses (see `scripts/build-workflow.mjs`). Keeping
 * one 600-line file would have put all of it into every step.
 *
 * This barrel is what real ES-module consumers import: the unit tests, the
 * analysis script, and `scanBuild` — the monolithic composition kept so there
 * is exactly one implementation of the logic behind both the pipeline steps and
 * the local tooling.
 *
 * Design doc: docs/design.md
 */

export * from './lib/manifests.mjs';

// One module per technology. Adding an ecosystem is a new `parsers-<x>.mjs`,
// a line in `registry.mjs`, a step beside the others on the canvas — and
// nothing at all inside an existing parser.
export * from './lib/parsers-go.mjs';
export * from './lib/parsers-node.mjs';
export * from './lib/parsers-maven.mjs';
export * from './lib/parsers-python.mjs';
export * from './lib/parsers-dotnet.mjs';
export * from './lib/registry.mjs';
export * from './lib/resolve.mjs';
export * from './lib/payload.mjs';
export * from './lib/blobs.mjs';
export * from './lib/plan.mjs';
export * from './lib/resolveplans.mjs';
export * from './lib/parseeco.mjs';
export * from './lib/buildpay.mjs';
export * from './lib/scan-build.mjs';
export * from './lib/transport.mjs';
