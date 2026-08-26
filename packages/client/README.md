# Rivetplane CLI

Rivetplane connects local ACP-compatible and OpenCode agent sessions to a remote control plane. The client starts all remote connections. It does not open an internet-facing port or start OpenCode by default.

## Use the client

Node.js 22 or later is required. Rivetplane tests and publishes releases on Node.js 24.

```sh
npx rivetplane login
npx rivetplane
```

The login command uses `https://rivetplane.com`, opens the control plane in your browser, and stores a machine-scoped token in your user configuration directory. The second command starts ACP discovery, read-only OpenCode export discovery, the local API, and the outbound relay. Keep it running while you use the control plane. Use `--server` only for a self-hosted control plane.

When `opencode` is on `PATH`, Rivetplane uses `opencode debug scrap` to list known projects. It scans the seed directory, each accessible project worktree, and the global bucket. It combines session results by ID. `--opencode-directory` is a seed, not a project filter. The full index scan runs immediately and every 60 seconds by default. `--opencode-index-interval SECONDS` changes this normal bound. The 2-second transcript poll uses the cached index. It selects at most 48 active, recent, or probe sessions and exports at most 12 per poll, with priority for running sessions and pending requests. It runs two exports at a time with a 30-second timeout. `--opencode-export-concurrency COUNT` and `--opencode-export-timeout SECONDS` change these limits. Failed exports use per-session exponential backoff from 30 seconds to five minutes. The startup probe is limited to the 48 most recently updated sessions. The full historical roster stays in the local index; only bounded live or probe sessions enter the relay registry. Stale non-running sessions leave the relay registry, and unchanged state is not relayed again. Slow scans and partial failures increase the next index delay, up to five minutes. Diagnostics give the scan duration, backoff, candidate count, and export count.

Rivetplane uses an explicit scope limit of 200 and detects successful output that is invalid or stops at exactly 65,536 bytes. Full scopes use bounded pages through `opencode db` as a documented, schema-dependent compatibility fallback. A bounded file-backed retry protects large list and export output from pipe truncation. It relays stable transcript diffs and can detect running question tools and supported explicit permission requests. It uses no server, `jq`, or direct SQLite file access. Compact checkpoints in `~/.config/harness-cp/opencode-export-checkpoints.json` prevent replay after a restart.

Export discovery cannot resolve a Deferred in the original OpenCode process. Exported sessions are marked read-only. Answer questions and approvals in that original process. Use `npx rivetplane opencode` for the explicit managed server and attached-TUI mode, or `--opencode-url URL` for an existing OpenCode HTTP server. These direct modes keep full control support.

Rivetplane also reads up to 48 Codex rollout files updated in the last 24 hours from `~/.codex/sessions`, independent of the current directory. These sessions are read-only, and the file roster refreshes every 30 seconds. A rollout file is not evidence that an independently launched stdio process is attached. Run `npx rivetplane codex` for a managed app-server with messages, streamed transcripts, interrupts, command and file approvals, supported questions, and restart recovery. The managed roster contains the 48 most recently updated threads and protects running, pending, and newly created threads. It uses a protected Unix socket on macOS and Linux and an authenticated loopback WebSocket on Windows. A configured shared listener can use `--codex-endpoint`; its token must be in `HARNESS_CP_CODEX_TOKEN`.

Run `npx rivetplane --help` for all options.

## Verified hook installation

`npx rivetplane hooks install` installs only checked Claude Code and OpenCode interfaces. Other harness names are reported as unsupported and are not changed. The installed hooks call a private, versioned Node bridge at `~/.config/harness-cp/hooks/v1/bridge.cjs` through absolute quoted paths. They do not depend on a global package binary, the npm cache, or network access. Hook commands find the current custom or port-zero local API through a private `~/.config/harness-cp/hook-endpoint.json` record. The local endpoint requires both the Rivetplane owner marker and its random secret. Offline, stale, malformed, refused, and timed-out discovery returns `{}` with exit code 0 so Claude Code and OpenCode keep their native prompts. Full uninstall removes the owned bridge.

See the repository [capability matrix](../../docs/harness-capabilities.md) for the exact interface limits.

Source and release instructions are in the [Rivetplane CLI repository](https://github.com/rivetplane/cli).
