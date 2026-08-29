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

Rivetplane also reads up to 48 Codex rollout files updated in the last 24 hours from `~/.codex/sessions`, independent of the current directory. These sessions are read-only, and the file roster refreshes every 30 seconds. A rollout file is not evidence that an independently launched stdio process is attached. `npx rivetplane hooks install --harness codex` adds verified, asynchronous standalone telemetry hooks. Normal `codex` then provides lifecycle and local-approval attention only. It does not provide remote approval responses or `request_user_input`. Answer its attention item in the local Codex terminal. Run `npx rivetplane codex` for a managed app-server with exact-ID messages, streamed transcripts, interrupts, command and file approvals, supported questions, and restart recovery. Historical list results remain read-only until Rivetplane creates, resumes, or actively controls the thread. It uses a protected Unix socket on macOS and Linux and an authenticated loopback WebSocket on Windows. A configured shared listener can use `--codex-endpoint`; its token must be in `HARNESS_CP_CODEX_TOKEN`.

Run `npx rivetplane --help` for all options.

## AI usage collection

Rivetplane sends usage metadata in `usage.sample` relay frames. It does not add prompts, message text, tool input, tool output, or file content to these frames. A durable checkpoint at `~/.config/harness-cp/usage-checkpoints.json` converts cumulative counters to safe increments and gives replayed source records stable event IDs. A counter decrease emits zero and becomes a new baseline. This prevents the reset snapshot from becoming duplicate usage.

- ACP: documented `session/update` `usage_update` is preferred when an attached harness emits it. Its `used` and `size` fields describe context state. They are not token accounting fields. Its cumulative cost is marked as reported by the harness.
- Codex: normal rollout discovery reads cumulative `event_msg` `token_count` records, so plain `npx rivetplane` collects token and context usage without launching Codex. The managed app-server also reads `thread/tokenUsage/updated`, `account/usage/read`, `account/rateLimits/read`, and rate-limit notifications when the installed version provides them. This was checked against Codex CLI 0.149.1. Older versions can omit account methods or individual token classes. The account response overlaps thread counters, so Rivetplane uses it only for non-overlapping estimated cost and uses thread or rollout counters as token authority. `estimatedUsageCreditsMicros` is marked estimated and uses `CREDITS`, not a billing currency.
- Claude Code: existing-session discovery reads token fields and estimated cost already present in session JSONL. `rivetplane hooks install --harness claude-code` adds an owned status-line tee for interactive context, cost, and rate-limit fields. The tee runs the existing command with the same input and output, keeps its other settings, and restores the exact prior `statusLine` object on uninstall. The bridge removes transcript paths and all non-usage fields before it sends the local event. Claude Code versions can omit context, rate-limit, or cost fields.
- OpenCode: HTTP/SSE and CLI export adapters read native assistant-message token and cost fields. Context size is added only when the provider roster reports it. Older exports can omit usage.

Missing fields stay null or absent. Reported and estimated costs keep different status values. Neither value is presented as an authoritative provider invoice.

## Verified hook installation

`npx rivetplane hooks install` installs only checked Claude Code, Codex, and OpenCode interfaces. Other harness names are reported as unsupported and are not changed. The installed hooks call a private, versioned Node bridge at `~/.config/harness-cp/hooks/v1/bridge.cjs` through absolute quoted paths. They do not depend on a global package binary, the npm cache, or network access. Hook commands find the current custom or port-zero local API through a private `~/.config/harness-cp/hook-endpoint.json` record. The local endpoint requires both the Rivetplane owner marker and its random secret. Offline, stale, malformed, refused, and timed-out discovery returns `{}` with exit code 0. Codex hooks are asynchronous and telemetry-only. Full uninstall removes the owned bridge.

See the repository [capability matrix](../../docs/harness-capabilities.md) for the exact interface limits.

Source and release instructions are in the [Rivetplane CLI repository](https://github.com/rivetplane/cli).
