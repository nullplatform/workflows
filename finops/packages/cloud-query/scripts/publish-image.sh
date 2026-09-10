#!/usr/bin/env bash
# Build + push the lean worker image for amd64 + arm64 from the multi-stage
# Dockerfile (it compiles the worker inside), and print registry/repo@sha256:<digest>
# on stdout for `np package publish` to register. Build logs go to stderr.
#
# Version: $NP_VERSION (the release tag, v-stripped). Registry: $NP_PUSH_REGISTRY
# (any registry you're `docker login`ed to). Needs docker buildx.
set -eu

registry="${NP_PUSH_REGISTRY:-}"
if [ -z "$registry" ]; then
  echo "publish-image: set NP_PUSH_REGISTRY=<registry>/<repository> and 'docker login' to it first." >&2
  exit 1
fi

version="${NP_VERSION:-$(sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' package.json | head -1)}"
version="${version#v}"
version="${version:-0.0.0}"

tag="${registry}:${version}"
meta="$(mktemp)"

docker buildx build --platform linux/amd64,linux/arm64 -t "$tag" --push --metadata-file "$meta" . >&2

digest=$(sed -nE 's/.*"containerimage.digest"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$meta" | head -1)
if [ -z "$digest" ]; then
  echo "publish-image: could not read the image digest from buildx metadata" >&2
  exit 1
fi

echo "${registry}@${digest}"
