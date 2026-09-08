#!/usr/bin/env node
/**
 * quality-metrics.mjs — normalize Trivy JSON reports into the nullplatform
 * build metadata `quality_metrics` (metadata specification "Quality Metrics").
 *
 *   node .github/scripts/quality-metrics.mjs \
 *     --fs=trivy-fs.json --image=trivy-image.json --image-ref=main \
 *     --dockerfile=Dockerfile --out=quality_metrics.json
 *
 * Writes:
 *   quality_metrics.json          the metadata VALUE (for inspection)
 *   quality_metrics.payload.json  { "quality_metrics": <value> } — what
 *                                 `np metadata create --entity build --data` takes
 *
 * Design:
 *   - One normalized finding per Trivy vulnerability / misconfiguration /
 *     secret, with a STABLE id (tool + rule + target) so the same finding is
 *     the same item across builds.
 *   - `package.fixed_version` is the HIGHEST fixed version among all of that
 *     package's vulnerabilities: one upgrade clears them all, and the autofix
 *     workflow groups those findings into ONE pull request.
 *   - Only fields declared by the specification are emitted
 *     (`additionalProperties: false` everywhere); strings are clipped to the
 *     declared maxLength; URIs/CWEs/SHAs are validated before use.
 *   - Findings are sorted by severity and capped at 200 (spec maxItems);
 *     `findings_summary.truncated` says so honestly.
 *
 * No dependencies — runs on the Node that ships with ubuntu-latest.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  }),
);
const env = process.env;

const MAX_FINDINGS = 200;
const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3, negligible: 4, unknown: 5 };
const SEVERITIES = Object.keys(SEV_RANK);

const load = (p) => (p && existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const clip = (s, n) => (s === undefined || s === null ? undefined : String(s).slice(0, n));
const uri = (u) => (typeof u === 'string' && /^https?:\/\/\S+$/.test(u) ? u : undefined);
const sev = (s) => {
  const v = String(s || 'unknown').toLowerCase();
  return SEVERITIES.includes(v) ? v : 'unknown';
};
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

const fsReport = load(args.fs ?? 'trivy-fs.json');
const imageReport = load(args.image ?? 'trivy-image.json');
const outPath = args.out ?? 'quality_metrics.json';
const dockerfile = args.dockerfile ?? 'Dockerfile';
const imageRef = args['image-ref'] ?? env.IMAGE_REF ?? '';
const repository = args.repository ?? env.GITHUB_REPOSITORY ?? '';
const serverUrl = env.GITHUB_SERVER_URL ?? 'https://github.com';
const branch = args.branch ?? env.GITHUB_REF_NAME ?? '';
const commitSha = args.commit ?? env.GITHUB_SHA ?? '';
const runUrl = env.GITHUB_RUN_ID && repository ? `${serverUrl}/${repository}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;

if (!fsReport && !imageReport) {
  console.error('quality-metrics: no Trivy report found (expected --fs and/or --image)');
  process.exit(2);
}

// ── Repository files, for locations and directness ──────────────────────────
const goModLines = existsSync('go.mod') ? readFileSync('go.mod', 'utf8').split('\n') : [];
/** module path → { line, direct } from go.mod */
const goModIndex = new Map();
goModLines.forEach((raw, i) => {
  const m = raw.match(/^\s*(?:require\s+)?([A-Za-z0-9._~\-\/]+)\s+v[0-9][^\s]*(\s*\/\/\s*indirect)?/);
  if (m && m[1].includes('.')) goModIndex.set(m[1], { line: i + 1, direct: !m[2], snippet: raw.trim() });
});
const dockerfileLines = existsSync(dockerfile) ? readFileSync(dockerfile, 'utf8').split('\n') : [];
let lastFromLine;
dockerfileLines.forEach((raw, i) => {
  if (/^\s*FROM\s+/i.test(raw)) lastFromLine = { line: i + 1, snippet: raw.trim() };
});

// ── Version comparison (semver-ish, tolerant of distro versions) ────────────
function cmpVersion(a, b) {
  const norm = (v) => String(v).replace(/^v/, '').split(/[.\-+~:]/).map((t) => (/^\d+$/.test(t) ? Number(t) : t));
  const x = norm(a), y = norm(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i], q = y[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (typeof p === 'number' && typeof q === 'number') { if (p !== q) return p - q; continue; }
    const s = String(p).localeCompare(String(q));
    if (s !== 0) return s;
  }
  return 0;
}
const highest = (versions) => versions.filter(Boolean).sort(cmpVersion).pop();

const ECOSYSTEM = {
  gomod: 'go', gobinary: 'go', npm: 'npm', yarn: 'npm', pnpm: 'npm', 'node-pkg': 'npm', pip: 'pip', pipenv: 'pip', poetry: 'pip',
  'python-pkg': 'pip', pom: 'maven', gradle: 'maven', jar: 'maven', nuget: 'nuget', 'dotnet-core': 'nuget', bundler: 'rubygems',
  gemspec: 'rubygems', cargo: 'cargo', composer: 'composer', debian: 'debian', ubuntu: 'debian', alpine: 'alpine', redhat: 'rpm',
  'amazon': 'rpm', rocky: 'rpm', 'oracle': 'rpm',
};
const upgradeCommand = (eco, name, fixed) => {
  switch (eco) {
    case 'go': return `go get ${name}@v${String(fixed).replace(/^v/, '')} && go mod tidy`;
    case 'npm': return `npm install ${name}@${fixed}`;
    case 'pip': return `pip install ${name}==${fixed}`;
    case 'cargo': return `cargo update -p ${name} --precise ${fixed}`;
    case 'rubygems': return `bundle update ${name}`;
    default: return undefined;
  }
};

// ── Collect Trivy results ───────────────────────────────────────────────────
const results = [
  ...((fsReport?.Results ?? []).map((r) => ({ ...r, __scan: 'fs' }))),
  ...((imageReport?.Results ?? []).map((r) => ({ ...r, __scan: 'image' }))),
];

const findings = [];
const seen = new Set();
const counts = { fs: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0, fixable: 0 }, image: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0, fixable: 0 }, misconfig: {}, secret: {} };
const manifests = new Set();

// Pass 1 — per-package highest fixed version (one upgrade clears the package).
const pkgFixed = new Map();
for (const r of results) {
  for (const v of r.Vulnerabilities ?? []) {
    const key = `${r.Type}|${v.PkgName}|${v.InstalledVersion}`;
    const list = pkgFixed.get(key) ?? [];
    for (const f of String(v.FixedVersion ?? '').split(',').map((s) => s.trim()).filter(Boolean)) list.push(f);
    pkgFixed.set(key, list);
  }
}

for (const r of results) {
  const isLang = r.Class === 'lang-pkgs';
  const isOs = r.Class === 'os-pkgs';
  if (isLang && r.__scan === 'fs') manifests.add(r.Target);
  const eco = ECOSYSTEM[String(r.Type).toLowerCase()] ?? String(r.Type ?? '').toLowerCase();

  for (const v of r.Vulnerabilities ?? []) {
    const id = `trivy:${v.VulnerabilityID}:${v.PkgName}@${v.InstalledVersion}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const severity = sev(v.Severity);
    const fixed = highest(pkgFixed.get(`${r.Type}|${v.PkgName}|${v.InstalledVersion}`) ?? []);
    const bucket = r.__scan === 'image' ? counts.image : counts.fs;
    bucket[severity in bucket ? severity : 'unknown']++;
    if (fixed) bucket.fixable++;

    const goInfo = eco === 'go' ? goModIndex.get(v.PkgName) : undefined;
    let location;
    if (isOs) location = compact({ type: 'image_layer', path: dockerfileLines.length ? dockerfile : undefined, line: lastFromLine?.line, snippet: clip(lastFromLine?.snippet, 500) });
    else if (goInfo) location = compact({ type: 'manifest', path: 'go.mod', line: goInfo.line, snippet: clip(goInfo.snippet, 500) });
    else if (v.PkgName === 'stdlib') location = compact({ type: 'manifest', path: 'go.mod', line: goModLines.findIndex((l) => /^\s*go\s+\d/.test(l)) + 1 || undefined });
    else location = compact({ type: isLang ? 'manifest' : 'package', path: r.__scan === 'fs' ? r.Target : undefined });

    const fixType = isOs || v.PkgName === 'stdlib' ? 'base_image_update' : 'upgrade_package';
    const fix = fixed
      ? compact({
          available: true,
          auto_fixable: true,
          type: fixType,
          recommendation: clip(
            fixType === 'base_image_update'
              ? `Upgrade ${v.PkgName} to ${fixed} by moving to a base image / toolchain that ships it (update the FROM line in ${dockerfile})`
              : `Upgrade ${v.PkgName} from ${v.InstalledVersion} to ${fixed}`,
            1000,
          ),
          command: fixType === 'upgrade_package' ? clip(upgradeCommand(eco, v.PkgName, fixed), 500) : undefined,
        })
      : compact({
          available: false,
          auto_fixable: false,
          // Keep the PLAYBOOK even without a fix: an OS package is remedied by
          // a newer base image when the distro ships one, so every OS finding
          // of a Dockerfile groups into that one change downstream.
          type: fixType === 'base_image_update' ? 'base_image_update' : 'manual',
          recommendation: fixType === 'base_image_update'
            ? `No fixed ${v.PkgName} in the distro yet; move to a newer base image tag in ${dockerfile} when one ships it`
            : `No fixed version of ${v.PkgName} is published yet; mitigate or replace the package`,
        });

    const cvss = v.CVSS?.nvd ?? v.CVSS?.ghsa ?? v.CVSS?.redhat ?? Object.values(v.CVSS ?? {})[0];
    const cwe = (v.CweIDs ?? []).find((c) => /^CWE-[0-9]+$/.test(c));
    findings.push(compact({
      id: clip(id, 300),
      tool: 'trivy',
      category: 'vulnerability',
      severity,
      status: 'open',
      title: clip(`${v.VulnerabilityID}: ${v.Title || v.Description || v.PkgName}`, 300),
      description: clip(v.Description, 1000),
      rule: compact({ id: v.VulnerabilityID, cwe, url: uri(v.PrimaryURL) }),
      package: compact({ name: v.PkgName, ecosystem: eco, version: v.InstalledVersion, fixed_version: fixed ?? '', direct: goInfo ? goInfo.direct : undefined }),
      location,
      fix,
      risk: compact({
        cvss_score: typeof cvss?.V3Score === 'number' ? cvss.V3Score : typeof cvss?.V2Score === 'number' ? cvss.V2Score : undefined,
        cvss_vector: cvss?.V3Vector ?? cvss?.V2Vector,
      }),
      url: uri(v.PrimaryURL),
      first_seen: v.PublishedDate,
    }));
  }

  for (const m of r.Misconfigurations ?? []) {
    const id = `trivy:${m.ID}:${r.Target}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const severity = sev(m.Severity);
    counts.misconfig[severity] = (counts.misconfig[severity] ?? 0) + 1;
    const start = m.CauseMetadata?.StartLine;
    const code = m.CauseMetadata?.Code?.Lines?.find((l) => l.Content)?.Content;
    findings.push(compact({
      id: clip(id, 300),
      tool: 'trivy',
      category: 'misconfiguration',
      severity,
      status: 'open',
      title: clip(`${m.ID}: ${m.Title}`, 300),
      description: clip(m.Description, 1000),
      message: clip(m.Message, 2000),
      rule: compact({ id: m.ID, name: m.Title, url: uri(m.PrimaryURL) }),
      location: compact({ type: 'file', path: r.Target, line: start >= 1 ? start : undefined, end_line: m.CauseMetadata?.EndLine >= 1 ? m.CauseMetadata.EndLine : undefined, snippet: clip(code, 500) }),
      fix: compact({ available: true, auto_fixable: true, type: 'config_change', recommendation: clip(m.Resolution || m.Message, 1000) }),
      url: uri(m.PrimaryURL),
    }));
  }

  for (const s of r.Secrets ?? []) {
    const id = `trivy:secret:${s.RuleID}:${r.Target}:${s.StartLine ?? 0}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const severity = sev(s.Severity);
    counts.secret[severity] = (counts.secret[severity] ?? 0) + 1;
    findings.push(compact({
      id: clip(id, 300),
      tool: 'trivy',
      category: 'secret',
      severity,
      status: 'open',
      title: clip(`${s.Title} committed in ${r.Target}`, 300),
      description: clip(`Trivy secret rule ${s.RuleID} (${s.Category}) matched in ${r.Target}`, 1000),
      rule: compact({ id: s.RuleID, name: s.Title }),
      location: compact({ type: 'file', path: r.Target, line: s.StartLine >= 1 ? s.StartLine : undefined, end_line: s.EndLine >= 1 ? s.EndLine : undefined }),
      fix: {
        available: true,
        auto_fixable: true,
        type: 'code_change',
        recommendation: 'Remove the secret from the repository, add the path to .gitignore, rotate the credential and load it from a secret store or environment variable instead',
      },
    }));
  }
}

// ── Sort, cap, summarize ────────────────────────────────────────────────────
findings.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.id.localeCompare(b.id));
const total = findings.length;
const kept = findings.slice(0, MAX_FINDINGS);
const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length]));
const byCategory = {};
for (const f of findings) byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;

const sum = (o, keys) => keys.reduce((n, k) => n + (o[k] ?? 0), 0);
const gateResult = (o) => (sum(o, ['critical', 'high']) > 0 ? 'failed' : sum(o, ['medium', 'low', 'unknown']) > 0 ? 'warning' : 'passed');
const gates = [];
if (fsReport) {
  gates.push(compact({ name: 'sca', tool: 'trivy', result: gateResult(counts.fs), target: [...manifests].join(', ') || '.', report_url: runUrl, counts: counts.fs }));
  gates.push(compact({ name: 'misconfig', tool: 'trivy', result: gateResult(counts.misconfig), target: dockerfile, report_url: runUrl, counts: counts.misconfig }));
  gates.push(compact({ name: 'secrets', tool: 'trivy', result: Object.keys(counts.secret).length ? 'failed' : 'passed', target: '.', report_url: runUrl, counts: counts.secret }));
}
gates.push(
  imageReport
    ? compact({ name: 'container_scan', tool: 'trivy', result: gateResult(counts.image), target: imageRef || imageReport.ArtifactName, report_url: runUrl, counts: counts.image })
    : { name: 'container_scan', tool: 'trivy', result: 'skipped' },
);
const securityFailed = gates.some((g) => g.result === 'failed');
const vulnCounts = (s) => findings.filter((f) => f.category === 'vulnerability' && f.severity === s).length;

const value = compact({
  overall_result: securityFailed ? 'failed' : 'passed',
  unit_test_result: 'skipped',
  lint_result: 'skipped',
  sonarqube_quality_gate_result: 'skipped',
  security_scan_result: securityFailed ? 'failed' : gates.some((g) => g.result === 'warning') ? 'warning' : 'passed',
  security_vulnerabilities_critical: vulnCounts('critical'),
  security_vulnerabilities_high: vulnCounts('high'),
  security_vulnerabilities_medium: vulnCounts('medium'),
  security_vulnerabilities_low: vulnCounts('low'),
  security_vulnerabilities_fixable: findings.filter((f) => f.category === 'vulnerability' && f.fix?.available).length,
  source: compact({
    repository: repository || undefined,
    repository_url: repository ? `${serverUrl}/${repository}` : undefined,
    branch: branch || undefined,
    commit_sha: /^[0-9a-f]{7,64}$/.test(commitSha) ? commitSha : undefined,
    dockerfile: dockerfileLines.length ? dockerfile : undefined,
    manifests: [...manifests].slice(0, 20),
  }),
  gates: gates.slice(0, 20),
  findings_summary: {
    total,
    returned: kept.length,
    truncated: kept.length < total,
    by_severity: bySeverity,
    by_category: byCategory,
    auto_fixable: findings.filter((f) => f.fix?.auto_fixable).length,
  },
  findings: kept,
});

writeFileSync(outPath, JSON.stringify(value, null, 2));
writeFileSync(outPath.replace(/\.json$/, '') + '.payload.json', JSON.stringify({ quality_metrics: value }));
console.log(
  `quality_metrics: ${value.overall_result} — ${total} findings (${kept.length} kept${kept.length < total ? ', TRUNCATED' : ''}); ` +
    `by severity ${JSON.stringify(bySeverity)}; by category ${JSON.stringify(byCategory)}; auto_fixable ${value.findings_summary.auto_fixable}`,
);
for (const g of gates) console.log(`  gate ${g.name.padEnd(15)} ${g.result.padEnd(8)} ${g.target ?? ''} ${g.counts ? JSON.stringify(g.counts) : ''}`);
