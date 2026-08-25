# Rivetplane CLI

Rivetplane connects local ACP-compatible and OpenCode agent sessions to a remote control plane. The client makes outbound connections. It does not open an internet-facing port. It does not start OpenCode by default.

## Use Rivetplane

Node.js 22 or later is required. Rivetplane tests and publishes releases on Node.js 24.

```sh
npx rivetplane login
npx rivetplane
```

The login command uses `https://rivetplane.com`, opens Rivetplane in your browser, and stores a machine-scoped token in your user configuration directory. The second command starts ACP discovery, OpenCode export discovery, the local API, and the outbound relay. Keep it running while you use Rivetplane. Use `--server` only for a self-hosted control plane.

## Existing OpenCode sessions

When `opencode` is on `PATH`, Rivetplane first runs `opencode debug scrap`, the supported OpenCode command that lists known projects. It uses the configured OpenCode directory as a seed, scans each accessible project worktree, and includes the global project bucket. It runs `opencode session list --format json --max-count 200` in each scope and combines the results by session ID. This immediate startup scan builds the machine session index. Rivetplane caches that index and refreshes it every 60 seconds by default. The 2-second transcript poll does not repeat project discovery or database pages.

Transcript polling selects at most 48 active, recent, or probe sessions from the cached index and exports at most 12 sessions per poll. Pending requests and running sessions have priority. Rivetplane runs two exports at a time and gives each export 30 seconds by default. Use `--opencode-export-concurrency COUNT` and `--opencode-export-timeout SECONDS` to change these limits. A failed export retries with exponential backoff from 30 seconds to five minutes, so one slow session cannot block other sessions or create a warning loop. At startup, Rivetplane probes only the 48 most recently updated sessions. The complete historical index stays local. Only exported active, pending, recently updated, or startup-probe sessions enter the relay registry. A stale non-running session leaves the relay registry after the recent window. Unchanged session state is not sent again. This prevents a new client from sending thousands of old completed sessions to the control plane. A new or updated session becomes available after the next normal index refresh, within 60 seconds by default. Slow scans or partial failures can increase this time, and the diagnostic gives the next refresh delay. Use `--opencode-index-interval SECONDS` to change the normal bound.

The export adapter is read-only. It can relay transcripts and show a live question or supported permission request. It cannot answer that question, approve that request, send a message, or interrupt the original process. Answer it in the original OpenCode process. Rivetplane reports a clear read-only error if a remote command targets such a session.

Rivetplane stores compact transcript checkpoints in `~/.config/harness-cp/opencode-export-checkpoints.json`. These checkpoints prevent duplicate transcript relay after a restart. `--opencode-directory PATH` selects the project-discovery seed; it does not filter out other known projects. Use `--opencode-checkpoint PATH` to select another file, `--opencode-executable PATH` to select the command, or `--no-opencode-export` to disable this adapter.

OpenCode has no session-list paging option, and large piped JSON output can stop at exactly 65,536 bytes even when OpenCode exits with code 0. Rivetplane uses an explicit scope limit of 200 and validates all JSON. When a scope reaches that limit, a directory is inaccessible, or project identities conflict, Rivetplane uses bounded pages through the documented `opencode db` command to complete the root-session index. This fallback uses a fixed read-only query against OpenCode's current session schema. It is isolated as a compatibility fallback because the SQL schema is less stable than the public CLI. `--opencode-max-sessions-per-project COUNT` changes the primary scope limit, but it is not a replacement for the bounded fallback.

Diagnostics report the index refresh duration, cached-session count, next refresh delay, active, recent, or probe candidate count, and per-poll export count. A slow index scan increases the next delay to at least four times the scan duration, up to five minutes. A partial refresh uses exponential backoff, also limited to five minutes. Diagnostics also report inaccessible or shared project directories, duplicate results, use or failure of the database-index fallback, missing commands, empty session-list output and its platform-shell retry, successful-but-malformed or truncated output and its file-backed retry, timeouts, output limits, and per-session export failures. File-backed stdout also protects large exports from known pipe truncation. If both the scoped scan and index fallback are incomplete, Rivetplane keeps prior sessions instead of treating the partial scan as an authoritative removal. One bad export does not stop later polls. Rivetplane does not open the SQLite database directly.

## Managed OpenCode mode

The existing direct HTTP mode remains available with `--opencode-url URL`. To start a loopback-only managed server and an attached TUI explicitly, run:

```sh
npx rivetplane opencode
```

Managed and direct HTTP sessions support messages, interrupts, approvals, and questions. The default export adapter does not start a server or TUI.

## Codex sessions

Rivetplane reads recent Codex rollout JSONL files from `~/.codex/sessions` by default. This discovery does not depend on the current directory. It relays at most 48 rollout sessions updated in the last 24 hours, scans the file roster every 30 seconds, and reports the sessions as read-only. It does not claim that a rollout is attached to a live process. Rivetplane cannot attach to an independently launched `codex app-server` process that uses stdio because that process owns its pipes.

Run `npx rivetplane codex` to start a Rivetplane-managed Codex app-server. This mode supports session creation and recovery, streamed transcripts, messages, interrupts, command and file approvals, and supported user-input questions. It relays the 48 most recently updated threads and loads transcript history for at most 12 threads with two concurrent requests. It always keeps running, pending, and newly created threads during roster convergence. It uses a permission-protected Unix socket on macOS and Linux. It uses an authenticated loopback WebSocket on Windows. Rivetplane stops only the app-server process that it starts.

Use `--codex-endpoint URL` to connect to a supported shared listener. Put its bearer token in `HARNESS_CP_CODEX_TOKEN`; do not put the token on the command line. Use `--codex-sessions-dir`, `--codex-checkpoint`, `--codex-directory`, or `--codex-executable` to change the local defaults. Use `--no-codex` to disable rollout discovery.

Run `npx rivetplane --help` to see all options.

## Develop

Install Bun 1.3.6 or later and Node.js 24 or later.

```sh
bun install
bun run typecheck
bun run test
bun run client:package:verify
```

The package check runs `npm pack --dry-run`, installs the real tarball in a clean temporary directory, and tests the shebang, `npx`, help, version, login, and start commands.

See [npm release instructions](docs/npm-release.md) for the release process.

## License

MIT
