#!/usr/bin/env node
/**
 * Pre-rollout analysis for the library inventory.
 *
 * RUN THIS BEFORE COPYING THE SUITE TO A NEW ORGANIZATION. The workflow's
 * defaults — which ecosystems to parse, what counts as an "internal" library,
 * how much coverage to expect, whether the ladder even resolves assets there —
 * were all derived from measurements on the reference organization, and none of them are portable by
 * assumption. This script re-derives them, read-only, against any org.
 *
 * It answers, with numbers rather than guesses:
 *   1. How big is the backfill?         (apps / builds / assets actually live)
 *   2. Which ecosystems matter here?    (census over every deployed repo)
 *   3. Does the ladder resolve assets?  (L1..L5 on a real sample)
 *   4. What are the internal libraries? (proposes LIB_INTERNAL_PATTERNS)
 *   5. Can the GitHub token see the repos at all?
 *
 * Read-only: no NP writes, no repository clones, no builds. Only the lake and
 * the GitHub API.
 *
 * Usage:
 *   NP_API_KEY=… GITHUB_TOKEN=… node analysis/analyze-org.mjs [--sample 40] [--json out.json]
 *
 * Interpreting the output: see analysis/README.md, which carries the the reference organization
 * baseline to compare against.
 */
import { writeFileSync } from 'node:fs';

import {
  MANIFEST_LANGS,
  SUPPORTED_ECOSYSTEMS,
  compileInternalPatterns,
  indexTree,
  manifestLang,
  parseRepoUrl,
  resolveAsset,
  scanBuild,
} from '../scanner/scanner.mjs';

const API_BASE = process.env.NP_API_BASE ?? 'https://api.nullplatform.com';
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const SAMPLE = Number(argOf('--sample', '40'));
const JSON_OUT = argOf('--json', null);

// ---------------------------------------------------------------- helpers ---

async function mintToken(apiKey) {
  const res = await fetch(`${API_BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ api_key: apiKey }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const data = await res.json();
  return { token: data.access_token, orgId: String(data.organization_id ?? '') };
}

async function lake(token, sql) {
  const res = await fetch(`${API_BASE}/data/lake/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: `${sql} FORMAT JSONEachRow` }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`lake query failed (${res.status}): ${text.slice(0, 300)}`);
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function gh(token) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'np-lib-inventory-analysis',
  };
  return {
    headers,
    async tree(owner, repo, ref) {
      for (const r of [ref, 'main', 'master'].filter(Boolean)) {
        const res = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/git/trees/${r}?recursive=1`,
          { headers },
        );
        if (res.status === 200) {
          const body = await res.json();
          return {
            paths: body.tree.filter((n) => n.type === 'blob').map((n) => n.path),
            truncated: body.truncated === true,
          };
        }
        if (res.status === 401 || res.status === 403) throw new Error(`HTTP ${res.status}`);
      }
      throw new Error('not found on commit/main/master');
    },
  };
}

/** Bounded parallel map — keeps us well inside GitHub's rate limit. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const idx = i++;
        if (idx >= items.length) return;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

const pct = (n, d) => (d === 0 ? '—' : `${((100 * n) / d).toFixed(1)}%`);
const bar = (title) => console.log(`\n${'━'.repeat(72)}\n${title}\n${'━'.repeat(72)}`);

// ------------------------------------------------------------------ main ---

const apiKey = process.env.NP_API_KEY;
const ghToken = process.env.GITHUB_TOKEN;
if (!apiKey) throw new Error('export NP_API_KEY');
if (!ghToken) throw new Error('export GITHUB_TOKEN');

const { token, orgId } = await mintToken(apiKey);
const G = gh(ghToken);
const report = { organization: orgId };
console.log(`organization: ${orgId}`);

// ── 0. Can the GitHub token see anything? ──────────────────────────────────
bar('0. GitHub token');
{
  const who = await fetch('https://api.github.com/user', { headers: G.headers });
  if (!who.ok) {
    console.log(`  UNUSABLE: GitHub returned ${who.status}. Everything below will fail.`);
    process.exit(1);
  }
  const login = (await who.json()).login;
  const repos = await (
    await fetch('https://api.github.com/user/repos?per_page=1', { headers: G.headers })
  ).json();
  const visible = Array.isArray(repos) ? repos.length : 0;
  report.github = { login, listsRepositories: visible > 0 };
  console.log(`  user: ${login}`);
  if (visible === 0) {
    console.log('  WARNING: this token lists ZERO repositories.');
    console.log('  A fine-grained PAT must grant Contents:read on each repo in scope.');
    console.log('  Every scan would report repo_unreachable — fix this before rollout.');
  } else {
    console.log('  lists repositories: yes');
  }
}

// ── 1. Backfill universe ───────────────────────────────────────────────────
bar('1. Backfill universe (what is actually deployed)');
// A DELETED scope is not deployed, but its deployments keep
// `status_in_scope = 'active'` in the lake — counting them overstates the
// backfill and, worse, fills the inventory with builds nothing runs. Measured
// on one org: 37% of the "live" assets. `!= 'deleted'` rather than
// `= 'active'` so a status added later keeps flowing in.
const LIVE_BUILDS = `
  WITH live_builds AS (
    SELECT DISTINCT r.build_id AS build_id
    FROM core_entities_deployment AS d FINAL
    INNER JOIN core_entities_release AS r FINAL ON r.id = d.release_id
    INNER JOIN core_entities_scope   AS s FINAL ON s.id = d.scope_id
    WHERE d.status_in_scope = 'active' AND s.status != 'deleted'
  )`;

const universe = (
  await lake(
    token,
    `${LIVE_BUILDS}
     SELECT count() AS assets, uniqExact(b.id) AS builds, uniqExact(a.app_id) AS apps,
            countIf(a.repository_url = '' OR a.repository_url IS NULL) AS assets_without_repo
     FROM live_builds AS lb
     INNER JOIN core_entities_build       AS b FINAL ON b.id = lb.build_id
     INNER JOIN core_entities_application AS a FINAL ON a.app_id = b.app_id
     INNER JOIN core_entities_asset       AS x FINAL ON x.build_id = b.id`,
  )
)[0];
report.universe = universe;
console.log(`  apps: ${universe.apps}   builds: ${universe.builds}   assets: ${universe.assets}`);
console.log(
  `  assets whose application has NO repository_url: ${universe.assets_without_repo} ` +
    `(${pct(universe.assets_without_repo, universe.assets)}) → these can only ever be repo_missing`,
);
console.log(`  → LIB_MAX_BUILDS must cover ${universe.builds} builds, in batches.`);

// ── 2. Sample the fleet ────────────────────────────────────────────────────
const rows = await lake(
  token,
  `${LIVE_BUILDS}
   SELECT toString(a.app_id) AS app_id, a.app_name AS app_name,
          a.repository_url AS repository_url, toString(b.id) AS build_id, b.commit AS commit,
          toJSONString(groupUniqArray((x.id, x.name, x.type))) AS assets_json
   FROM live_builds AS lb
   INNER JOIN core_entities_build       AS b FINAL ON b.id = lb.build_id
   INNER JOIN core_entities_application AS a FINAL ON a.app_id = b.app_id
   INNER JOIN core_entities_asset       AS x FINAL ON x.build_id = b.id
   WHERE a.repository_url != ''
   GROUP BY a.app_id, a.app_name, a.repository_url, b.id, b.commit`,
);

// One build per app — the most asset-rich one, since multi-asset repos are
// where the mapping is actually hard.
const byApp = new Map();
for (const r of rows) {
  const assets = JSON.parse(r.assets_json).map((a) => ({ id: a[0], name: a[1], type: a[2] }));
  const prev = byApp.get(r.app_id);
  if (!prev || assets.length > prev.assets.length) byApp.set(r.app_id, { ...r, assets });
}
const apps = [...byApp.values()].sort((a, b) => b.assets.length - a.assets.length);
const sample = apps.slice(0, Math.min(SAMPLE, apps.length));

bar(`2. Language census (${sample.length} of ${apps.length} deployed apps, asset-richest first)`);
const trees = await mapLimit(sample, 8, async (app) => {
  const repo = parseRepoUrl(app.repository_url);
  if (!repo) return { app, error: 'not a GitHub url' };
  try {
    const { paths, truncated } = await G.tree(repo.owner, repo.repo, app.commit);
    return { app, paths, truncated };
  } catch (err) {
    return { app, error: err.message };
  }
});

const repoLangs = new Map();
const unreachable = [];
let truncatedCount = 0;
for (const t of trees) {
  if (t.error) {
    unreachable.push(`${t.app.app_name} (${t.app.repository_url}): ${t.error}`);
    continue;
  }
  if (t.truncated) truncatedCount += 1;
  const langs = new Set();
  for (const p of t.paths) {
    const l = manifestLang(p.slice(p.lastIndexOf('/') + 1));
    if (l) langs.add(l);
  }
  repoLangs.set(t.app.app_id, langs);
}

const langRepos = new Map();
const langAssets = new Map();
for (const t of trees) {
  const langs = repoLangs.get(t.app?.app_id);
  if (!langs) continue;
  for (const l of langs) {
    langRepos.set(l, (langRepos.get(l) ?? 0) + 1);
    langAssets.set(l, (langAssets.get(l) ?? 0) + t.app.assets.length);
  }
}
report.languages = Object.fromEntries(
  [...langRepos].map(([l, repos]) => [
    l,
    { repos, assets: langAssets.get(l) ?? 0, parsed: SUPPORTED_ECOSYSTEMS.has(l) },
  ]),
);
console.log(`  ${'ecosystem'.padEnd(14)}${'repos'.padStart(7)}${'assets'.padStart(9)}   parser?`);
for (const [l, n] of [...langRepos].sort((a, b) => b[1] - a[1])) {
  console.log(
    `  ${l.padEnd(14)}${String(n).padStart(7)}${String(langAssets.get(l) ?? 0).padStart(9)}   ` +
      (SUPPORTED_ECOSYSTEMS.has(l) ? 'yes' : 'NO → lang_unsupported'),
  );
}
const noManifest = trees.filter((t) => !t.error && (repoLangs.get(t.app.app_id)?.size ?? 0) === 0);
console.log(`  repos with no recognised manifest: ${noManifest.length} (third-party images, etc.)`);
if (truncatedCount)
  console.log(
    `  WARNING: ${truncatedCount} repo tree(s) TRUNCATED — those need a different strategy.`,
  );
if (unreachable.length) {
  console.log(`  UNREACHABLE repos: ${unreachable.length}`);
  for (const u of unreachable.slice(0, 10)) console.log(`    - ${u}`);
}
report.unreachable = unreachable;

// ── 3. Does the ladder resolve assets here? ────────────────────────────────
bar('3. Asset → repository-subtree resolution (the ladder)');
const ladder = { L1: 0, L2: 0, L3: 0, L4: 0, L5: 0 };
const unresolvedExamples = [];
for (const t of trees) {
  if (t.error) continue;
  const idx = indexTree(t.paths);
  for (const asset of t.app.assets) {
    // L2 needs manifest contents; the analysis stays cheap and reports the
    // rung reachable without them. A real scan can only do BETTER than this.
    const hit = resolveAsset(asset.name, idx, null);
    if (!hit) {
      ladder.L5 += 1;
      if (unresolvedExamples.length < 10) {
        unresolvedExamples.push(`${t.app.app_name} / ${asset.name}`);
      }
    } else {
      ladder[hit.level] += 1;
    }
  }
}
const totalAssets = Object.values(ladder).reduce((a, b) => a + b, 0);
report.ladder = { ...ladder, total: totalAssets };
for (const [k, v] of Object.entries(ladder)) {
  console.log(`  ${k}: ${String(v).padStart(5)}  ${pct(v, totalAssets)}`);
}
if (ladder.L5 > 0) {
  console.log(`  ⚠ ${ladder.L5} asset(s) unresolved — this org needs work the the reference organization rules did not:`);
  for (const e of unresolvedExamples) console.log(`    - ${e}`);
  console.log('    Look at how those repos are laid out before trusting the defaults.');
} else {
  console.log('  ✓ every sampled asset resolved deterministically — no AI fallback needed.');
}

// ── 4. Which libraries look internal? ──────────────────────────────────────
bar('4. Proposed LIB_INTERNAL_PATTERNS');
// Scan with NO internal patterns so nothing is filtered, then look at which
// module-path prefixes dominate. An internal library is one that lots of this
// org's own assets depend on and that nobody outside would publish.
const scanned = await mapLimit(
  trees.filter((t) => !t.error).slice(0, Math.min(20, trees.length)),
  4,
  async (t) =>
    scanBuild(
      { ...t.app, assets: t.app.assets },
      {
        tree: async () => t.paths,
        blobs: async (owner, repo, ref, paths) => {
          const out = {};
          for (let i = 0; i < paths.length; i += 60) {
            const chunk = paths.slice(i, i + 60);
            const aliases = chunk
              .map(
                (p, j) =>
                  `f${j}: object(expression: ${JSON.stringify(`${ref}:${p}`)}) { ... on Blob { text } }`,
              )
              .join('\n');
            const res = await fetch('https://api.github.com/graphql', {
              method: 'POST',
              headers: { ...G.headers, 'content-type': 'application/json' },
              body: JSON.stringify({
                query: `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {\n${aliases}\n} }`,
              }),
            });
            const body = await res.json();
            const node = body.data?.repository;
            if (node) {
              chunk.forEach((p, j) => {
                if (typeof node[`f${j}`]?.text === 'string') out[p] = node[`f${j}`].text;
              });
            }
          }
          return out;
        },
      },
      {
        internalPatterns: compileInternalPatterns([]),
        now: new Date().toISOString(),
        keepTransitiveExternal: true,
      },
    ),
);

const prefixCount = new Map();
for (const rowsForBuild of scanned) {
  for (const row of rowsForBuild ?? []) {
    for (const dep of row.data.dependencies) {
      if (dep.local) continue;
      // First two path segments: `github.com/acme`, `com.the reference organization`, `@scope`.
      const m = /^(@[^/]+|[^/]+\/[^/]+|[^.]+\.[^.]+)/.exec(dep.name);
      if (m) prefixCount.set(m[1], (prefixCount.get(m[1]) ?? 0) + 1);
    }
  }
}
// Frequency alone is a bad signal — `github.com/aws` is always at the top and
// is nobody's internal library. The reliable signal is already in NP: the
// GitHub owners of the organization's OWN application repositories. A module
// published under one of those owners is, by construction, internal.
const owners = new Map();
for (const app of apps) {
  const repo = parseRepoUrl(app.repository_url);
  if (repo) owners.set(repo.owner, (owners.get(repo.owner) ?? 0) + 1);
}
const ownerList = [...owners].sort((a, b) => b[1] - a[1]);
const suggested = ownerList.map(([o]) => `^github\\.com/${o}/`);
report.repositoryOwners = Object.fromEntries(ownerList);
report.suggestedInternalPatterns = suggested;

console.log("  repository owners of this org's own applications (the reliable signal):");
for (const [o, n] of ownerList) console.log(`  ${String(n).padStart(6)} apps   github.com/${o}`);

const top = [...prefixCount].sort((a, b) => b[1] - a[1]).slice(0, 15);
report.dependencyPrefixes = Object.fromEntries(top);
console.log('\n  most common dependency prefixes, marked against those owners:');
for (const [p, n] of top) {
  const mine = ownerList.some(([o]) => p.toLowerCase() === `github.com/${o}`.toLowerCase());
  console.log(`  ${String(n).padStart(6)}  ${mine ? '← YOURS  ' : '         '}${p}`);
}

console.log('\n  Suggested:');
console.log(`    --internal-patterns '${JSON.stringify(suggested)}'`);
console.log('  Review it. Frequency is NOT the signal — the top prefix is almost');
console.log('  always a public SDK. Add any private module host this misses');
console.log('  (a self-hosted GitLab, an internal Maven groupId like `com.acme`,');
console.log('  an npm scope like `@acme/`), since those never appear as a GitHub owner.');

// ── 5. Expected status distribution ────────────────────────────────────────
bar('5. Expected outcome of a real run (with only the enabled parsers)');
const statuses = {};
for (const rowsForBuild of scanned) {
  for (const row of rowsForBuild ?? []) {
    statuses[row.data.status] = (statuses[row.data.status] ?? 0) + 1;
  }
}
report.expectedStatuses = statuses;
const totalScanned = Object.values(statuses).reduce((a, b) => a + b, 0);
for (const [s, n] of Object.entries(statuses).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${s.padEnd(20)} ${String(n).padStart(5)}  ${pct(n, totalScanned)}`);
}
const okPct = (100 * (statuses.ok ?? 0)) / (totalScanned || 1);
console.log(
  `\n  → set LIB_MIN_COVERAGE_PCT below the WRITE success rate, not below ${okPct.toFixed(0)}%:`,
);
console.log('    coverage counts records WRITTEN, and a lang_unsupported record is still written.');

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
  console.log(`\nreport written to ${JSON_OUT}`);
}

bar('Summary — decide these before rolling out');
console.log(`  LIB_SCAN_NRN_PREFIX    start narrow: one application, then namespace, then org`);
console.log(`  LIB_INTERNAL_PATTERNS  from section 4 — no default is correct for a new org`);
console.log(`  LIB_MAX_BUILDS         ${universe.builds} builds total; batch accordingly`);
console.log(
  `  parsers to add         ${[...langRepos.keys()].filter((l) => !SUPPORTED_ECOSYSTEMS.has(l)).join(', ') || 'none'}`,
);
console.log(
  `  ladder health          ${ladder.L5 === 0 ? 'OK' : `${ladder.L5} unresolved — investigate first`}`,
);
void MANIFEST_LANGS;
