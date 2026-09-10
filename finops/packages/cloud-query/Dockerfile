# syntax=docker/dockerfile:1
# Lean gRPC worker image — self-contained multi-stage build. `docker build` (or
# `docker buildx --platform ...` for multi-arch) compiles the worker inside the
# builder stage and ships just the binary on a minimal runtime. No prebuilt
# artifact, no dist/ — nothing to commit.
#
# The nullplatform agent spawns this as a worker (a pod in Kubernetes, a
# container in Docker) and streams actions to it over gRPC. NP_AGENT_PLUGIN makes
# the binary start the SDK's gRPC server; at runtime the agent injects
# NP_GRPC_LISTEN (the port), the mTLS material (NP_WORKER_TLS_*), and NP_API_KEY.
# Do NOT set NP_MODE=dev — that switches the SDK to the in-memory client and the
# worker would never report action lifecycle (scopes hang/fail).

FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY . .
RUN bun install
# buildkit sets TARGETARCH (amd64|arm64); compile the matching musl target for the
# alpine runtime below. bun cross-compiles from any host, so multi-arch buildx
# needs no emulation for the compile step.
ARG TARGETARCH
RUN if [ "$TARGETARCH" = "arm64" ]; then t=bun-linux-arm64-musl; else t=bun-linux-x64-musl; fi; \
    bun build --compile --target="$t" ./src/index.ts --outfile /app/worker

FROM alpine:3.20
# the bun musl binary links libstdc++/libgcc dynamically.
RUN apk add --no-cache libstdc++ libgcc
COPY --from=build /app/worker /app/worker
# node-config: ship the config dir; custom-environment-variables.json maps env
# vars -> config keys (the single declarative place env config lives).
COPY config/ /app/config/
ENV NODE_CONFIG_DIR=/app/config \
    SUPPRESS_NO_CONFIG_WARNING=1 \
    NP_AGENT_PLUGIN=np-agent-v1
EXPOSE 50051
ENTRYPOINT ["/app/worker"]
