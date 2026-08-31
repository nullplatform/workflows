#!/usr/bin/env bash
# Declares the `dependency-inventory` CATALOG ENTITY specification.
#
# One entity per ASSET, upserted by wf-l0 via
# `PATCH /catalog/instances/dependency-inventory/{asset_id}?upsert=true`.
# Everything the platform already knows about the asset's application or
# namespace is deliberately NOT in the schema — the entity's `nrn` encodes the
# hierarchy and the lake joins the rest.
#
# AUTH: creating catalog specifications needs a USER SESSION bearer — an org
# API key can read/write entity INSTANCES (that is what the workflows use) but
# is not allowed to manage specifications. Export `NP_SESSION_TOKEN` with your
# own bearer (same one the FE uses); `NP_API_KEY` alone will 403 here.
#
# The `schema.authorization` block is load-bearing: without it the org API key
# cannot write instances either — every workflow write 403s even though the
# key has full entity grants in the org (hit live on another org, 2026-08-21).
#
# Idempotent: creates the spec, or PATCHes the schema in place if it exists.
# Never touches any instance data.
#
# Usage:
#   NP_SESSION_TOKEN=… ./01-entity-spec.sh --env-file ../../../.env.<org> \
#     [--admin-user <np user id>]     # gets actions:["*"] on spec + entities

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../cost/setup/lib.sh
source "$SCRIPT_DIR/../../cost/setup/lib.sh"

ADMIN_USER=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  [[ "${args[$i]}" == "--admin-user" ]] && ADMIN_USER="${args[$((i + 1))]:-}"
done
parse_common_args "$@"

if [[ -n "${NP_SESSION_TOKEN:-}" ]]; then
  TOKEN="$NP_SESSION_TOKEN"
  echo "using NP_SESSION_TOKEN" >&2
else
  echo "ERROR: export NP_SESSION_TOKEN (a user session bearer)." >&2
  echo "  Catalog specifications cannot be managed with an org API key." >&2
  exit 1
fi

# `--arg admin ""` + the jq `if` keeps the admin grant out entirely when no
# user was named, rather than emitting a principal with an empty id.
SPEC=$(jq -n --arg admin "$ADMIN_USER" '
  def admin_grant: {actions: ["*"], principals: [{type: "user", id: ($admin | tonumber)}]};
  {
    name: "Dependency Inventory",
    # Explicit, because the API derives a slug from the name with UNDERSCORES
    # ("dependency_inventory") and every write path and lake query in this
    # suite says `dependency-inventory`. Hit live on the first rollout.
    slug: "dependency-inventory",
    description: "Libraries in use per asset (lib-inventory suite), read from the application repository at the exact commit of the build. One entity per asset; a missing entity means never scanned.",
    schema: {
      type: "object",
      additionalProperties: false,
      relations: {},
      properties: {
        id:               { type: "string", alias: "asset_id", primaryKey: true, autoGenerate: false },
        nrn:              { type: "string", nrn: true, index: ["filter"] },

        status:           { type: "string", index: ["filter", "facet"],
                            enum: ["ok","no_manifest","unresolved","repo_unreachable","repo_missing","lang_unsupported"] },
        status_detail:    { type: ["string","null"] },
        match_level:      { type: ["string","null"], index: ["filter","facet"] },

        build_id:         { type: "string", index: ["filter"] },
        release_id:       { type: ["string","null"], index: ["filter"] },
        commit:           { type: ["string","null"], index: ["filter"] },
        repository_path:  { type: ["string","null"] },

        primary_language: { type: ["string","null"], index: ["filter","facet"] },
        languages:        { type: "array", items: { type: "string" } },

        manifests:        { type: "array", items: { type: "object", additionalProperties: true } },
        manifest_config:  { type: ["object","null"], additionalProperties: true },

        # `libraries`, NOT `dependencies`: the catalog API silently DROPS a
        # property named `dependencies` on write — a legacy JSON-Schema
        # keyword its schema engine treats specially (hit live 2026-08-31:
        # every probe lost the array while sibling keys survived). Items stay
        # schemaless-open like deployment-analysis arrays, the shape proven in
        # production; each row carries name/version/direct/internal/local/
        # ecosystem plus per-ecosystem extras (dev, optional, peer, scope).
        libraries:        { type: "array", items: { type: "object", additionalProperties: true } },

        total_count:                 { type: "integer" },
        direct_count:                { type: "integer" },
        internal_count:              { type: "integer" },
        local_count:                 { type: "integer" },
        transitive_external_dropped: { type: "integer" },

        scanned_at:       { type: "string", format: "date-time", index: ["sort"] },
        scanner_version:  { type: "string" },
        created_at:       { type: "string", format: "date-time", index: ["sort"] },
        updated_at:       { type: "string", format: "date-time", index: ["sort"] }
      },
      authorization: {
        entities: {
          grants: ([
            { actions: ["read","list","create","write"], principals: [{ type: "*" }] }
          ] + (if $admin == "" then [] else [admin_grant] end))
        },
        specification: {
          grants: ([
            { actions: ["read"], principals: [{ type: "*" }] }
          ] + (if $admin == "" then [] else [admin_grant] end))
        }
      }
    }
  }')

echo "Declaring the dependency-inventory catalog entity specification:"
out=$(api POST "/catalog/specifications" "$SPEC")
st="$(last_status)"
if [[ "$st" =~ ^2 ]]; then
  echo "  created: $(jq -r '.id // "ok"' <<<"$out") (slug: $(jq -r '.slug // "?"' <<<"$out"))"
elif [[ "$st" == "400" || "$st" == "409" ]]; then
  sid=$(api GET "/catalog/specifications?slug=dependency-inventory" \
    | jq -r '(.results // .) | map(select(.slug=="dependency-inventory")) | .[0].id // empty')
  [[ -n "$sid" ]] || { echo "FAILED: exists but could not resolve spec id ($st): $out"; exit 1; }
  patch=$(jq -c '{schema: .schema, description: .description}' <<<"$SPEC")
  out=$(api PATCH "/catalog/specifications/$sid" "$patch")
  [[ "$(last_status)" =~ ^2 ]] && echo "  updated spec $sid" \
    || { echo "FAILED patch ($(last_status)): $out"; exit 1; }
else
  echo "FAILED ($st): $out"; exit 1
fi
