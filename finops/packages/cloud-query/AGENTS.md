# AGENTS.md — cloud-query

Guidance for AI agents / new contributors working in this **custom command** package.

## What this is

The low-level plugin path: raw `createPlugin` + `registerManifest` from
`@nullplatform/plugin` (no `defineScope`/`defineService`). Compiled to a
standalone binary and run as a **gRPC worker** the controlplane agent spawns.
You own the manifest and the single `execute(req)` entry point; there's no
action routing or lifecycle scaffolding.

## File map

```
src/index.ts    registerManifest({...}); --describe guard; createPlugin({ execute }).start()
Dockerfile      lean worker image (the agent spawns this)
mise.toml       tasks: test, build:image, run, publish:image
```

## How it works

- `registerManifest({ name, version, command_types })` declares identity in
  memory (raw createPlugin has no `plugin.yaml`).
- The `--describe` guard prints that manifest and exits — `np package publish`
  runs the binary with `--describe` to read it. **Keep this guard**; without it,
  publish fails.
- `createPlugin({ execute }).start()` boots the gRPC server (only when
  `NP_AGENT_PLUGIN` is set, which the agent does at spawn).
- `execute(req)` gets `{ commandType, actionType, payload }` and returns
  `{ success, data }`.

## Rules that matter

- **Keep the `--describe` block** before `.start()`.
- **Never set `NP_MODE=dev` in the image.**
- Return `{ success: false, error, errorCode }` on failure — don't throw silently.
- The agent injects the API key + TLS at spawn; don't hand-roll credentials.

## Run / test

- `mise run test`
- `np package run` — real local run: dockerized agent spawns this worker. Needs `NP_API_KEY`.
