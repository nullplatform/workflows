#!/usr/bin/env bash
# Release the cloud-query worker image to nullplatform's public ECR:
#   public.ecr.aws/nullplatform/agent-plugins/workflows/aws-cost-explorer
#
# What it does
#   1. docker login to ECR Public with AWS credentials that can push to that repo
#      (AWS_PROFILE or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY[/AWS_SESSION_TOKEN]).
#      Most people do NOT have these — the nullplatform registry owner runs this.
#   2. buildx a multi-arch image (linux/amd64 + linux/arm64) from the Dockerfile
#      (compiles the worker inside the build), tag it <version> and push.
#   3. Print the immutable reference registry/repo@sha256:<digest> and write
#      release.json next to this script for the platform registration step.
#
# Usage
#   scripts/release.sh                 # version from package.json (e.g. 0.0.1)
#   scripts/release.sh 0.0.2           # explicit version tag
#   NP_PUSH_REGISTRY=<other registry/repo> scripts/release.sh   # override the target
#   scripts/release.sh --dry-run       # build for the local arch only, no login, no push
#   scripts/release.sh 0.0.2 --latest  # also move the :latest tag to this version
#
# Then register the version on the platform (needs NP_API_KEY with publish grants):
#   np-preview package publish --nrn "$NRN" --image "$(jq -r .image scripts/release.json)"
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

REGISTRY_HOST="public.ecr.aws"
DEFAULT_REPO="public.ecr.aws/nullplatform/agent-plugins/workflows/aws-cost-explorer"
NP_PUSH_REGISTRY="${NP_PUSH_REGISTRY:-$DEFAULT_REPO}"
DRY_RUN=0
LATEST=0
VERSION=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --latest) LATEST=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) VERSION="$arg" ;;
  esac
done
if [[ -z "$VERSION" ]]; then
  VERSION=$(sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' package.json | head -1)
fi
VERSION="${VERSION#v}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][A-Za-z0-9.]+)?$ ]] || { echo "release: version '$VERSION' is not semver" >&2; exit 1; }

for tool in docker; do command -v "$tool" >/dev/null || { echo "release: $tool is required" >&2; exit 1; }; done
docker buildx version >/dev/null 2>&1 || { echo "release: docker buildx is required" >&2; exit 1; }

echo "release: cloud-query ${VERSION} → ${NP_PUSH_REGISTRY}" >&2

if [[ "$DRY_RUN" == "1" ]]; then
  # Local-arch build only (multi-platform images cannot be --load'ed). Validates the Dockerfile.
  docker buildx build --load -t "cloud-query-release:${VERSION}" . >&2
  echo "release: dry run OK — image cloud-query-release:${VERSION} built for $(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')" >&2
  exit 0
fi

# 1) login (ECR Public tokens are always minted in us-east-1, regardless of the repo's region)
command -v aws >/dev/null || { echo "release: aws CLI is required for the ECR Public login" >&2; exit 1; }
aws sts get-caller-identity --query Arn --output text >&2 || { echo "release: AWS credentials missing/invalid (AWS_PROFILE or AWS_ACCESS_KEY_ID/SECRET)" >&2; exit 1; }
aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin "$REGISTRY_HOST" >&2

# 2) multi-arch build + push (a dedicated builder guarantees multi-platform support)
BUILDER="cloud-query-release"
docker buildx inspect "$BUILDER" >/dev/null 2>&1 || docker buildx create --name "$BUILDER" --driver docker-container --bootstrap >/dev/null
META="$(mktemp)"
TAGS=(-t "${NP_PUSH_REGISTRY}:${VERSION}")
[[ "$LATEST" == "1" ]] && TAGS+=(-t "${NP_PUSH_REGISTRY}:latest")
docker buildx build --builder "$BUILDER" \
  --platform linux/amd64,linux/arm64 \
  "${TAGS[@]}" \
  --push --metadata-file "$META" . >&2

# 3) immutable reference
DIGEST=$(sed -nE 's/.*"containerimage.digest"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$META" | head -1)
[[ -n "$DIGEST" ]] || { echo "release: could not read the image digest from buildx metadata" >&2; exit 1; }
IMAGE="${NP_PUSH_REGISTRY}@${DIGEST}"
printf '{\n  "package": "cloud-query",\n  "version": "%s",\n  "tag": "%s:%s",\n  "image": "%s",\n  "platforms": ["linux/amd64", "linux/arm64"],\n  "released_at": "%s"\n}\n' \
  "$VERSION" "$NP_PUSH_REGISTRY" "$VERSION" "$IMAGE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > scripts/release.json
echo "release: pushed ${NP_PUSH_REGISTRY}:${VERSION}$([[ "$LATEST" == "1" ]] && echo ' (+ :latest)')" >&2
echo "$IMAGE"
