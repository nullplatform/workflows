/**
 * Ecosystem -> parser / self-declaration reader.
 *
 * SEPARATE MODULE on purpose. It is the only thing that needs every parser at
 * once, and it is used by exactly one consumer: the monolithic `scanBuild`
 * that the tests and the analysis script run. The workflow's parse steps each
 * receive their own parser instead.
 *
 * Living inside a parser module was a latent runtime failure, not just bloat:
 * the inliner strips `import` lines, so a step that inlined one parser without
 * every OTHER parser built this object out of names absent from its bundle. It
 * compiles, and throws ReferenceError on first execution. The build gate now
 * runs each body to catch that; keeping the registry alone here is what stops
 * it happening again.
 */
import { goModConfig, parseGoMod } from './parsers-go.mjs';
import { parsePomXml, pomConfig } from './parsers-maven.mjs';
import { packageJsonConfig, parsePackageJson } from './parsers-node.mjs';
import { parsePython, pythonConfig } from './parsers-python.mjs';

export const PARSERS = {
  go: parseGoMod,
  node: parsePackageJson,
  'java-maven': parsePomXml,
  python: parsePython,
};

export const CONFIG_READERS = {
  go: goModConfig,
  node: packageJsonConfig,
  'java-maven': pomConfig,
  python: pythonConfig,
};
