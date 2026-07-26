/**
 * Maven (`pom.xml`) dependency parsing.
 *
 * WITHOUT RESOLVING THE REACTOR, and that limit is the whole design. A real
 * Maven resolution walks parent POMs, imported BOMs and the local repository;
 * doing that means either running Maven (we never build) or fetching and
 * chasing artifacts across the network from a sandbox. What a single `pom.xml`
 * states about itself is available for free and answers the question this
 * inventory is asked: which libraries did somebody declare, at which version.
 *
 * Three things it does resolve, because they live in the same file and skipping
 * them would silently mislabel most versions:
 *   - `${property}` from that pom's own `<properties>`
 *   - `${project.version}` / `${revision}`-style self references
 *   - a version omitted from `<dependencies>` but pinned in
 *     `<dependencyManagement>`
 *
 * A version that still cannot be resolved (it came from a parent POM) is kept
 * VERBATIM — `${spring.version}` reaches the record as written. That reads as
 * obviously unresolved, which is the honest outcome; substituting a guess would
 * not be.
 */

/** Strip comments so a commented-out `<dependency>` is not inventoried. */
function stripXmlComments(xml) {
  return String(xml).replace(/<!--[\s\S]*?-->/g, '');
}

function tagValue(block, tag) {
  const m = new RegExp(`<${tag}\\s*>([\\s\\S]*?)</${tag}\\s*>`).exec(block);
  return m ? m[1].trim() : null;
}

/** Every `<dependency>…</dependency>` block inside `xml`. */
function dependencyBlocks(xml) {
  return xml.match(/<dependency\s*>[\s\S]*?<\/dependency\s*>/g) ?? [];
}

/** The `<dependencyManagement>` section, which pins versions but declares nothing. */
function managementSection(xml) {
  const m = /<dependencyManagement\s*>[\s\S]*?<\/dependencyManagement\s*>/.exec(xml);
  return m ? m[0] : '';
}

/**
 * `<properties>` as a flat map, plus the self-referential values Maven exposes
 * on every project (`project.version` and friends).
 */
function pomProperties(xml) {
  const props = {};
  const section = /<properties\s*>([\s\S]*?)<\/properties\s*>/.exec(xml);
  if (section) {
    const entry = /<([A-Za-z0-9_.\-]+)\s*>([\s\S]*?)<\/\1\s*>/g;
    let m = entry.exec(section[1]);
    while (m !== null) {
      props[m[1]] = m[2].trim();
      m = entry.exec(section[1]);
    }
  }
  // The project's own coordinates, minus anything inside <dependency> or
  // <parent>: `<version>` appears in all three and the first match wins.
  const head = xml.split(/<dependencies\s*>/)[0] ?? xml;
  const own = head.replace(/<parent\s*>[\s\S]*?<\/parent\s*>/g, '');
  const version = tagValue(own, 'version');
  if (version) {
    props['project.version'] = version;
    props.version = props.version ?? version;
  }
  const groupId = tagValue(own, 'groupId');
  if (groupId) props['project.groupId'] = groupId;
  return props;
}

/** Expand `${…}` against `props`, leaving anything unknown verbatim. */
function expand(value, props, depth = 0) {
  if (value === null || depth > 5) return value;
  return value.replace(/\$\{([^}]+)\}/g, (whole, key) => {
    const found = props[key];
    return found === undefined ? whole : expand(found, props, depth + 1);
  });
}

/**
 * Parse a `pom.xml`.
 *
 * The dependency NAME is `groupId:artifactId` — Maven's own coordinate, and the
 * only form in which "is this internal" is answerable, since an artifactId
 * alone (`common`, `core`, `model`) collides across organizations.
 *
 * `<scope>test</scope>` maps to `dev: true` and `provided`/`runtime` are kept
 * verbatim in `scope`: a test-only dependency is a real declaration but not
 * something the deployed artifact ships, and conflating the two makes any
 * "who is exposed" question unanswerable.
 */
export function parsePomXml(text) {
  const xml = stripXmlComments(text);
  const props = pomProperties(xml);

  // Versions pinned in <dependencyManagement> fill in for dependencies that
  // omit one. The management blocks themselves are NOT dependencies.
  const management = managementSection(xml);
  const managed = {};
  for (const block of dependencyBlocks(management)) {
    const groupId = expand(tagValue(block, 'groupId'), props);
    const artifactId = expand(tagValue(block, 'artifactId'), props);
    const version = expand(tagValue(block, 'version'), props);
    if (groupId && artifactId && version) managed[`${groupId}:${artifactId}`] = version;
  }

  const declared = xml.replace(management, '');
  const deps = [];
  const seen = new Set();
  for (const block of dependencyBlocks(declared)) {
    const groupId = expand(tagValue(block, 'groupId'), props);
    const artifactId = expand(tagValue(block, 'artifactId'), props);
    if (!groupId || !artifactId) continue;
    const name = `${groupId}:${artifactId}`;
    if (seen.has(name)) continue;
    seen.add(name);

    const scope = (tagValue(block, 'scope') ?? 'compile').toLowerCase();
    const version = expand(tagValue(block, 'version'), props) ?? managed[name] ?? '';
    deps.push({
      name,
      version,
      direct: true,
      ecosystem: 'java-maven',
      // `<systemPath>` dependencies point at a file on the build machine —
      // in-repo code, not a consumed library, same as Go's `replace` to a path.
      local: /<systemPath\s*>/.test(block),
      dev: scope === 'test',
      optional: tagValue(block, 'optional') === 'true',
      scope,
    });
  }
  return deps;
}

/**
 * What a `pom.xml` declares about ITSELF: its coordinates, its parent, and the
 * Java it targets. `maven.compiler.release` / `java.version` is the JVM
 * equivalent of `engines.node` — the runtime-deprecation question, which no
 * dependency list answers.
 */
export function pomConfig(text) {
  const xml = stripXmlComments(text);
  const props = pomProperties(xml);
  const cfg = {};
  const head = xml.split(/<dependencies\s*>/)[0] ?? xml;
  const parent = /<parent\s*>[\s\S]*?<\/parent\s*>/.exec(head);
  const own = head.replace(/<parent\s*>[\s\S]*?<\/parent\s*>/g, '');

  const artifactId = tagValue(own, 'artifactId');
  if (artifactId) cfg.artifactId = artifactId;
  const groupId = tagValue(own, 'groupId') ?? (parent ? tagValue(parent[0], 'groupId') : null);
  if (groupId) cfg.groupId = groupId;
  const version = tagValue(own, 'version');
  if (version) cfg.version = expand(version, props);
  if (parent) {
    const pg = tagValue(parent[0], 'groupId');
    const pa = tagValue(parent[0], 'artifactId');
    const pv = tagValue(parent[0], 'version');
    if (pg && pa) cfg.parent = `${pg}:${pa}${pv ? `:${pv}` : ''}`;
  }
  for (const key of [
    'java.version',
    'maven.compiler.release',
    'maven.compiler.source',
    'maven.compiler.target',
    'kotlin.version',
    'spring-boot.version',
  ]) {
    if (props[key] !== undefined) cfg[key] = expand(props[key], props);
  }
  return cfg;
}
