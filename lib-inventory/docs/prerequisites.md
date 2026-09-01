# What an organization needs for this to work

Every row here was **measured against a real organization**, not assumed. Where
a number appears it is the observed value, and the "without it" column is what
actually happened when the thing was missing — several of these were discovered
by a scan silently returning zero.

Two categories, and the difference matters when you are asking a customer for
something:

- **Required** — the scan cannot run, or runs and reports nothing. Non-negotiable.
- **Wanted** — the scan runs but its answer is incomplete in a way we have to
  disclose. These are the asks that buy depth.

---

## 1. Platform (nullplatform)

| What | Why | Without it |
|---|---|---|
| `repository_url` set on the **application** entity | The only link from a deployed asset back to source | Asset is permanently `repo_missing` — it can never be scanned, and the gap is invisible unless you count it |
| `commit` recorded on the **build** entity | The whole premise is reading source *at the commit that was built* | Falls back to branch HEAD, which is a different codebase than the one running |
| Catalog entity spec `dependency-inventory` created in the org (`setup/01-entity-spec.sh`, needs a USER session bearer) | The write target | `PATCH /catalog/instances/dependency-inventory/:id?upsert=true` → 404, and a parallel `forEach` **absorbs** the failure so the run still looks green |
| The spec's `schema.authorization` block grants the org `create`/`write` on entities | Without it the org API key 403s on every write even with full entity grants (hit live 2026-08-21) | Every scan writes nothing while the run reports success |
| Entity spec accepts every field the parsers emit (`additionalProperties: false` is all-or-nothing) | Schema validation rejects the **entire** document on one unknown property | A missing `scope` field kept every Java asset at zero for hours while the run reported success |
| Config entries: `GITHUB_TOKEN`, `LIB_INTERNAL_PATTERNS`, `LIB_SCAN_NRN_PREFIX` | Credentials and scoping | Secrets in YAML, or a scan that walks the whole org when it should be scoped |
| Egress allowlist: `api.github.com` (+ `api.osv.dev` for the vulnerability layer) | Runtime-owned SSRF policy | `EGRESS_BLOCKED` at the first fetch |

### Asset naming

The scanner maps asset → directory by convention. In the reference organization
that resolved **99.4%** of assets. It is a property of how that organization
lays out repositories, **not a law** — run `analysis/analyze-org.mjs` against a
new org before assuming it holds. Section 3 of that report is the go/no-go.

---

## 2. Source access

| What | Why |
|---|---|
| **A GitHub App**, not a personal PAT | A PAT is one person's access and dies with their account. A fine-grained PAT that lists **zero** repositories fails every scan with `repo_unreachable` and looks exactly like a platform permissions bug |
| Read access to **contents** on every application repository | Manifests are read at a specific commit via the git trees + blobs API |
| Traffic budget | One build ≈ 2 tree calls + N blob calls. Rate limiting is handled (10 min back-off, resume with what is missing), but a cold backfill of a large org is real volume |

---

## 3. Per-ecosystem — this is where the depth is won or lost

The short version: **Go needs nothing. Node needs one file. Python needs one
file. Java needs a decision.**

### Go — complete today

`go.mod` (Go ≥ 1.17) carries the full module build graph, not just direct
dependencies. Measured in the reference org: **4,406 indirect** entries
alongside the direct ones, **93.9%** of versions exact, across **2,399 live
assets** — 91% of the fleet.

Nothing is needed from the organization. Private modules are recorded from
`go.mod` itself, so no registry access is required to see them.

### Node — **wanted: commit the lockfile**

`package.json` gives direct dependencies with **ranges**, not resolved versions
— only **9%** were exact. A range answers "is this affected by CVE-X?" with
*maybe*, which is not an answer a CISO can act on.

The fix costs the organization nothing: **commit `package-lock.json`,
`yarn.lock` or `pnpm-lock.yaml`**. The lockfile has resolved versions *and* the
transitive closure inline, so no registry credentials are needed. Measured:
**12 of 16** repositories already had one.

### Python — **wanted: commit a lock file**

The weakest ecosystem today, and by a wide margin. Measured: **0 of 30**
repositories had `poetry.lock` or `Pipfile.lock`, and **1 of 156** assets had a
pip-compiled `requirements.txt`. So for ~150 live assets we record direct
declarations only, with **0%** exact versions (`>=1.2` is a range).

Any one of these closes it, in order of preference:

1. `poetry.lock` / `uv.lock` / `pdm.lock` committed
2. `requirements.txt` compiled by pip-tools — it carries the closure, and its
   `# via …` provenance comments are already detected and recorded as
   `manifest_config.requirements_compiled`
3. `Pipfile.lock` committed

Again: no credentials, just a file in the repository.

### Java / Maven — **the one that needs a decision**

Maven has **no lockfile**. The closure only exists after a resolver walks the
POM graph, and that walk needs the artifact registry.

We tested this on one real multi-module application at its deployed commit:

- Downloading the source at the exact commit: **1.6s** — trivial.
- `mvn dependency:tree`: **failed in 4.5s**, before resolving anything. The
  parent POMs live in the organization's private JFrog Artifactory, and Maven
  fell back to Central. The `<repositories>` declaration that points at the
  private registry is *inside a POM that itself has to be downloaded from it* —
  a bootstrap problem credentials in `settings.xml` solve and a public resolver
  cannot.

So Java transitives are not a toolchain problem. They are an **access**
problem. Two ways out, and they are not equivalent:

**A. The organization publishes a resolved dependency list at build time** *(recommended)*

At build time the toolchain and the credentials are already present, so
resolution is free and exact-to-the-commit:

```bash
mvn -B dependency:list -DoutputFile=deps.txt -DincludeScope=runtime
```

Publish `deps.txt` as build metadata (or commit it). Nothing leaves their
perimeter, no credentials are shared, and the result is commit-exact by
construction. This is the cheapest correct answer and it generalizes — the same
pattern (`pip freeze`, `npm ls --all`) fixes Python and Node without lockfiles.

**B. The organization grants read-only credentials to the artifact registry**

Artifactory / Nexus / CodeArtifact read credentials as a config entry, and we
resolve in an ephemeral sandbox. This works, but it means **we hold their
internal registry credentials and pull their internal artifacts into our
sandbox**. That is a materially different security posture from reading
manifests out of git, and it should be a deliberate decision at their end, not
a checkbox in an onboarding form.

> If the organization already runs Snyk (or similar), they have **already paid
> this integration cost** — private registry access is wired up for the scanner
> they own. That is the strongest argument for consuming their tool as a
> *resolver* rather than rebuilding one. See the caveat about branch-vs-commit
> drift below.

---

## 4. For the vulnerability layer

| What | Why | Note |
|---|---|---|
| Egress to `api.osv.dev` | The advisory source | Free, no API key, covers Go / Maven / npm / PyPI |
| A decision on **what leaves the perimeter** | An OSV query carries package names and versions | Internal module names (`github.com/<org>/…`) are identifying and must be filtered, or mirror the OSV database locally. "We send your dependency list to a third party" is a conversation with a CISO, not a footnote |

Volume is not a concern: the reference organization's entire inventory was
**1,106 unique `package@version`** pairs → **3 batch calls, ~40s**. Refreshing
nightly is effectively free.

### Two traps that make a vulnerability report lie

Both fail toward "no problem found", which is the one direction a security
report must never fail in:

- **Go module versions carry a `v` prefix.** Normalize only one side of the
  join and Go silently contributes **zero** findings. The measured count went
  from 43 affected assets to **258** when this was fixed.
- **OSV `GO-…` advisories carry no severity.** It lives on the aliased
  `GHSA-…` record. Without following the alias, 62 of 135 advisories fell into
  `UNKNOWN` and dropped out of the report.

### If a third-party scanner is used as the resolver

Its projects are keyed to **repo + branch**, not commit. Joining a `main`
snapshot against an asset built three weeks ago reports on code that is not
running — which is precisely the failure mode this system exists to avoid. If
that data is ingested, **record its provenance and render it differently** from
commit-exact data. Blurring the two degrades the only property that makes this
better than the scanner alone.

---

## 5. The ask, ranked by what it costs the customer

1. **Free, high value** — `repository_url` and `commit` populated in the
   platform; a GitHub App instead of a personal PAT.
2. **Free, closes Node and Python** — commit the lockfile. One file per
   repository, no credentials, no build changes.
3. **Cheap, closes Java** — emit `mvn dependency:list` at build time and
   publish it as build metadata.
4. **Expensive, avoid if 3 is possible** — hand over artifact registry
   credentials.

Everything above item 2 is already working today for 91% of a real fleet.
