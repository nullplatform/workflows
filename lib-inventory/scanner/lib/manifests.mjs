export const SCANNER_VERSION = 'lib-inventory/1.0.0';

/** Manifest filename -> ecosystem. */
export const MANIFEST_LANGS = {
  'go.mod': 'go',
  'package.json': 'node',
  'pom.xml': 'java-maven',
  'build.gradle': 'java-gradle',
  'build.gradle.kts': 'java-gradle',
  'requirements.txt': 'python',
  'pyproject.toml': 'python',
  Pipfile: 'python',
  Gemfile: 'ruby',
  'Cargo.toml': 'rust',
  'composer.json': 'php',
  'pubspec.yaml': 'dart',
};

/**
 * Asset-name suffixes that describe the deployment shape rather than the code,
 * stripped before the L3 normalized comparison.
 */
const NAME_SUFFIXES = [
  '-aws-lambda',
  '-aws-uks',
  '-lambda',
  '-service',
  '-local',
  '-docker-image',
  '-image',
  '-asset',
  '-app',
  '-api',
];

/** Ecosystems we can currently parse. Everything else is reported, not parsed. */
export const SUPPORTED_ECOSYSTEMS = new Set(['go', 'node', 'java-maven', 'python', 'dotnet']);

export function manifestLang(basename) {
  if (MANIFEST_LANGS[basename]) return MANIFEST_LANGS[basename];
  if (basename.endsWith('.csproj')) return 'dotnet';
  return null;
}

export function normalizeName(name) {
  // Dots fold into dashes: .NET monorepos name modules `Conto.Api` while the
  // NP application is `conto-api` (110 unresolved assets in one live repo).
  let s = String(name).toLowerCase().replaceAll('.', '-');
  for (let changed = true; changed; ) {
    changed = false;
    for (const suf of NAME_SUFFIXES) {
      if (s.endsWith(suf)) {
        s = s.slice(0, -suf.length);
        changed = true;
      }
    }
  }
  return s.replace(/[^a-z0-9]/g, '');
}

/** `https://github.com/acme/x(.git)` -> `{owner, repo}`; null when not GitHub. */
export function parseRepoUrl(url) {
  const m = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(url || ''));
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * Compile the configured internal-library patterns once.
 * Accepts an array or the JSON string a config entry delivers (entries are
 * always strings, so `LIB_INTERNAL_PATTERNS` arrives as `'["^github\\.com/Acme/"]'`).
 */
export function compileInternalPatterns(patterns) {
  let list = patterns;
  if (typeof list === 'string') {
    const raw = list.trim();
    if (!raw) return [];
    try {
      list = JSON.parse(raw);
    } catch {
      // Tolerate a bare comma-separated list so a mis-typed entry still works.
      list = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  if (!Array.isArray(list)) return [];
  return list.map((p) => new RegExp(p));
}
