/**
 * Python dependency parsing.
 *
 * Python declares dependencies in at least three unrelated files, so unlike Go
 * or Node this parser dispatches on the FILENAME. All three are handled because
 * a repository routinely has more than one — a `pyproject.toml` for the package
 * and a `requirements.txt` for the deployment.
 *
 * DIRECT DEPENDENCIES ONLY, same reasoning as Node: transitivity lives in a
 * lock file (`poetry.lock`, `requirements.txt` compiled by pip-tools) and those
 * are large enough to reintroduce the payload problem the per-build split
 * exists to solve. A hand-written `requirements.txt` is a direct declaration; a
 * pip-compiled one lists the closure and will over-report as direct. That is
 * visible in the data rather than hidden: such files carry `# via …` comment
 * lines, so `requirements_compiled` is recorded in `manifest_config`.
 */

/** `name[extra1,extra2] >= 1.2 ; marker` → the name and the specifier. */
const REQUIREMENT = /^([A-Za-z0-9._-]+)\s*(\[[^\]]*\])?\s*(.*)$/;

/** Specifiers that mean "code in this repository", not a published package. */
const LOCAL_PREFIX = /^(-e\s|\.|\.\.|\/|file:)/;

/**
 * Parse a `requirements.txt`.
 *
 * Environment markers (`; python_version < "3.9"`) are dropped from the version
 * but the requirement is kept: it IS declared, and which interpreter selects it
 * is a different question from which libraries this asset can pull in.
 */
export function parseRequirementsTxt(text) {
  const deps = [];
  const seen = new Set();
  for (const raw of String(text).split('\n')) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // `-r other.txt` / `-c constraints.txt` point at another file, which the
    // scan will have fetched on its own if it is a recognised manifest.
    if (/^-{1,2}(r|c|requirement|constraint)\b/.test(line)) continue;
    if (/^-{1,2}(i|index-url|extra-index-url|f|find-links|no-|hash)/.test(line)) continue;

    const local = LOCAL_PREFIX.test(line);
    if (line.startsWith('-e ')) line = line.slice(3).trim();
    // Drop an inline comment and any environment marker.
    line = line.split('#')[0].split(';')[0].trim();
    if (!line) continue;

    // A path requirement (`-e ./svc`, `../shared`, `file:...`) has no package
    // name to extract — the path IS the identity. Running it through the
    // name regex yielded a dependency literally called ".".
    if (local) {
      if (seen.has(line.toLowerCase())) continue;
      seen.add(line.toLowerCase());
      deps.push({ name: line, version: '', direct: true, ecosystem: 'python', local: true });
      continue;
    }

    const m = REQUIREMENT.exec(line);
    if (!m) continue;
    const name = m[1];
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    deps.push({
      name,
      version: (m[3] ?? '').trim(),
      direct: true,
      ecosystem: 'python',
      local,
    });
  }
  return deps;
}

/** The body of a `[section]` in a TOML file, up to the next section header. */
function tomlSection(text, header) {
  const re = new RegExp(`^\\[${header.replace(/[.[\]]/g, '\\$&')}\\]\\s*$`, 'm');
  const start = re.exec(text);
  if (!start) return null;
  const rest = text.slice(start.index + start[0].length);
  const next = /^\[[^\]]+\]\s*$/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** Entries of a TOML array-of-strings assigned to `key`. */
function tomlStringArray(section, key) {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm');
  const m = re.exec(section);
  if (!m) return [];
  return (m[1].match(/(['"])((?:\\.|(?!\1).)*)\1/g) ?? []).map((q) => q.slice(1, -1));
}

/**
 * Parse a `pyproject.toml`.
 *
 * Covers the two shapes in the wild: PEP 621 (`[project] dependencies = [...]`)
 * and Poetry (`[tool.poetry.dependencies]` as key/value). Poetry's `python`
 * entry is the INTERPRETER, not a library — it is excluded here and surfaces
 * through `manifest_config` instead, where the runtime question belongs.
 */
export function parsePyProjectToml(text) {
  const src = String(text);
  const deps = [];
  const seen = new Set();
  const push = (name, version, extra = {}) => {
    const key = name.toLowerCase();
    if (!name || seen.has(key)) return;
    seen.add(key);
    deps.push({ name, version, direct: true, ecosystem: 'python', local: false, ...extra });
  };

  // PEP 621
  const project = tomlSection(src, 'project');
  if (project) {
    for (const entry of tomlStringArray(project, 'dependencies')) {
      const m = REQUIREMENT.exec(entry.split(';')[0].trim());
      if (m) push(m[1], (m[3] ?? '').trim());
    }
  }
  // PEP 621 optional groups: `[project.optional-dependencies]`
  const optional = tomlSection(src, 'project.optional-dependencies');
  if (optional) {
    const arrays = optional.match(/^\s*[A-Za-z0-9_-]+\s*=\s*\[[\s\S]*?\]/gm) ?? [];
    for (const arr of arrays) {
      for (const entry of tomlStringArray(arr, '[A-Za-z0-9_-]+')) {
        const m = REQUIREMENT.exec(entry.split(';')[0].trim());
        if (m) push(m[1], (m[3] ?? '').trim(), { optional: true });
      }
    }
  }

  // Poetry
  for (const [header, flags] of [
    ['tool.poetry.dependencies', {}],
    ['tool.poetry.dev-dependencies', { dev: true }],
    ['tool.poetry.group.dev.dependencies', { dev: true }],
  ]) {
    const section = tomlSection(src, header);
    if (!section) continue;
    const entry = /^\s*([A-Za-z0-9._-]+)\s*=\s*(.+)$/gm;
    let m = entry.exec(section);
    while (m !== null) {
      const name = m[1];
      const rawValue = m[2].trim();
      if (name.toLowerCase() !== 'python') {
        const quoted = /^(['"])((?:\\.|(?!\1).)*)\1/.exec(rawValue);
        // An inline table (`{ path = "../shared" }`) is in-repo code; a
        // `{ version = "^1.2" }` table still carries a version.
        const version = quoted
          ? quoted[2]
          : (/version\s*=\s*['"]([^'"]+)['"]/.exec(rawValue)?.[1] ?? '');
        push(name, version, {
          ...flags,
          ...(/(path|url)\s*=/.test(rawValue) ? { local: true } : {}),
        });
      }
      m = entry.exec(section);
    }
  }

  return deps;
}

/** `Pipfile` — `[packages]` / `[dev-packages]`, TOML like Poetry's. */
export function parsePipfile(text) {
  const src = String(text);
  const deps = [];
  const seen = new Set();
  for (const [header, flags] of [
    ['packages', {}],
    ['dev-packages', { dev: true }],
  ]) {
    const section = tomlSection(src, header);
    if (!section) continue;
    const entry = /^\s*"?([A-Za-z0-9._-]+)"?\s*=\s*(.+)$/gm;
    let m = entry.exec(section);
    while (m !== null) {
      const name = m[1];
      const key = name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        const rawValue = m[2].trim();
        const quoted = /^(['"])((?:\\.|(?!\1).)*)\1/.exec(rawValue);
        const version = quoted
          ? quoted[2]
          : (/version\s*=\s*['"]([^'"]+)['"]/.exec(rawValue)?.[1] ?? '');
        deps.push({
          name,
          version: version === '*' ? '' : version,
          direct: true,
          ecosystem: 'python',
          local: /(path|file)\s*=/.test(rawValue),
          ...flags,
        });
      }
      m = entry.exec(section);
    }
  }
  return deps;
}

/** Dispatch on the manifest filename — Python has three, unrelated in shape. */
export function parsePython(text, path = '') {
  const file = path.slice(path.lastIndexOf('/') + 1);
  if (file === 'pyproject.toml') return parsePyProjectToml(text);
  if (file === 'Pipfile') return parsePipfile(text);
  return parseRequirementsTxt(text);
}

/**
 * What a Python manifest declares about ITSELF — chiefly the interpreter it
 * targets, which is the runtime-deprecation question and is invisible in a
 * dependency list.
 */
export function pythonConfig(text, path = '') {
  const file = path.slice(path.lastIndexOf('/') + 1);
  const src = String(text);
  const cfg = {};

  if (file === 'pyproject.toml') {
    const project = tomlSection(src, 'project');
    const requires = /^\s*requires-python\s*=\s*['"]([^'"]+)['"]/m.exec(project ?? src);
    if (requires) cfg['requires-python'] = requires[1];
    const name = /^\s*name\s*=\s*['"]([^'"]+)['"]/m.exec(project ?? '');
    if (name) cfg.name = name[1];
    const poetry = tomlSection(src, 'tool.poetry.dependencies');
    const poetryPython = poetry ? /^\s*python\s*=\s*['"]([^'"]+)['"]/m.exec(poetry) : null;
    if (poetryPython) cfg['requires-python'] = cfg['requires-python'] ?? poetryPython[1];
    return cfg;
  }

  if (file === 'requirements.txt') {
    // A pip-compiled file lists the whole closure, so its "direct" flags
    // over-report. It is recognisable by the `# via …` provenance comments
    // pip-tools writes, and saying so beats silently mixing the two.
    if (/^\s*#\s+via\s/m.test(src)) cfg.requirements_compiled = 'true';
  }
  return cfg;
}
