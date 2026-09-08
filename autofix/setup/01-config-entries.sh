#!/usr/bin/env bash
# Upserts the config entries the autofix workflows read, at engine path
# /autofix. Re-running rotates values in place (POST /workflows/config is an
# upsert by name+path).
#
# GITHUB_TOKEN is a SECRET and needs, on every repository in scope:
#   contents: write        (push the autofix/* branches)
#   pull_requests: write   (open the PR)
#   metadata: read
# A fine-grained PAT must list the repositories explicitly; a GitHub App
# installation token works too (mind its 1h expiry — rotate via this script).
# Pass --check-repo owner/repo to verify push permission on one repo up front:
# a token that cannot push fails every fix with a clone/push error that looks
# exactly like an agent bug.
#
# NP_API_KEY is written ONCE at root path "/" and NEVER overwritten by a re-run —
# GET is checked first so this can't clobber a live secret.
#
# Usage:
#   ./01-config-entries.sh --env-file ../../../.env.myorg \
#     [--branches "main,master,release/*"] \
#     [--category-slug security] [--fix-all true|false] \
#     [--github-token ghp_…] [--check-repo owner/repo]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../cost/setup/lib.sh
source "$SCRIPT_DIR/../../cost/setup/lib.sh"

BRANCHES="main,master"
CATEGORY_SLUG="security"
FIX_ALL="false"
GH_TOKEN_ARG=""
CHECK_REPO=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)      set -a; source "$2"; set +a; shift 2 ;;
    --branches)      BRANCHES="$2";       shift 2 ;;
    --category-slug) CATEGORY_SLUG="$2";  shift 2 ;;
    --fix-all)       FIX_ALL="$2";        shift 2 ;;
    --github-token)  GH_TOKEN_ARG="$2";   shift 2 ;;
    --check-repo)    CHECK_REPO="$2";     shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

# --github-token wins over whatever --env-file exported.
GH_TOKEN_VALUE="${GH_TOKEN_ARG:-${GITHUB_TOKEN:-}}"
if [[ -z "$GH_TOKEN_VALUE" ]]; then
  echo "ERROR: no GitHub token. Pass --github-token or put GITHUB_TOKEN in the env file." >&2
  exit 1
fi

mint_token

echo "Checking the GitHub token:"
gh_code=$(curl -sS -o /tmp/np-autofix-gh-user.json -w '%{http_code}' \
  -H "Authorization: Bearer $GH_TOKEN_VALUE" -H 'User-Agent: np-autofix-setup' \
  'https://api.github.com/user')
if [[ "$gh_code" != "200" ]]; then
  # A GitHub App installation token has no /user — fall back to rate_limit.
  rl_code=$(curl -sS -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $GH_TOKEN_VALUE" -H 'User-Agent: np-autofix-setup' \
    'https://api.github.com/rate_limit')
  if [[ "$rl_code" != "200" ]]; then
    echo "  FAILED: GitHub returned $gh_code (/user) and $rl_code (/rate_limit) — the token is invalid or expired." >&2
    exit 1
  fi
  echo "  token OK (installation/app token, no user identity)"
else
  echo "  token OK (user: $(jq -r '.login // "?"' /tmp/np-autofix-gh-user.json))"
fi
if [[ -n "$CHECK_REPO" ]]; then
  repo_json=$(curl -sS -H "Authorization: Bearer $GH_TOKEN_VALUE" -H 'User-Agent: np-autofix-setup' \
    "https://api.github.com/repos/$CHECK_REPO")
  can_push=$(jq -r '.permissions.push // false' <<<"$repo_json")
  if [[ "$can_push" != "true" ]]; then
    echo "  WARNING: token cannot push to $CHECK_REPO (permissions.push=$can_push)." >&2
    echo "  Every fix on that repository will fail at 'git push'. Grant contents:write." >&2
  else
    echo "  push permission OK on $CHECK_REPO"
  fi
fi

put() { # name value secret(true|false) path
  local body out
  body=$(jq -n --arg name "$1" --arg value "$2" --argjson secret "$3" --arg path "$4" \
    '{name: $name, value: $value, secret: $secret, path: $path}')
  out=$(api POST "/workflows/config" "$body")
  if [[ "$(last_status)" =~ ^2 ]]; then
    echo "  $4 $1 → $(jq -r '.mode // "upserted"' <<<"$out")"
  else
    echo "  $4 $1 FAILED ($(last_status)): $out"; exit 1
  fi
}

echo "Upserting config entries on /autofix:"
put NP_ORGANIZATION_ID    "$ORG_ID"          false "/autofix"
put AUTOFIX_BRANCHES      "$BRANCHES"        false "/autofix"
put AUTOFIX_CATEGORY_SLUG "$CATEGORY_SLUG"   false "/autofix"
put AUTOFIX_FIX_ALL       "$FIX_ALL"         false "/autofix"
put GITHUB_TOKEN          "$GH_TOKEN_VALUE"  true  "/autofix"

echo "Checking root secret NP_API_KEY (path /):"
existing=$(api GET "/workflows/config?path=/")
st="$(last_status)"
if [[ "$st" =~ ^2 ]]; then
  if jq -e '(.data // .) | map(select(.name == "NP_API_KEY")) | length > 0' <<<"$existing" >/dev/null 2>&1; then
    echo "  / NP_API_KEY already exists → left untouched (never clobber a live secret)"
  else
    put NP_API_KEY "$NP_API_KEY" true "/"
  fi
else
  echo "FAILED: could not verify existing secret (status $st) — refusing to write NP_API_KEY"
  exit 1
fi

echo
echo "Watching branches: $BRANCHES   (category slug: $CATEGORY_SLUG)"
echo "Verify the slug exists with ./02-category.sh before activating anything."
