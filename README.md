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

When `opencode` is on `PATH`, Rivetplane polls `opencode session list --format json`. It runs `opencode export <session-id>` for new, changed, or recent sessions. It parses JSON without `jq`. This finds sessions from plain OpenCode processes without an OpenCode server.

The export adapter is read-only. It can relay transcripts and show a live question or supported permission request. It cannot answer that question, approve that request, send a message, or interrupt the original process. Answer it in the original OpenCode process. Rivetplane reports a clear read-only error if a remote command targets such a session.

Rivetplane stores compact transcript checkpoints in `~/.config/harness-cp/opencode-export-checkpoints.json`. These checkpoints prevent duplicate transcript relay after a restart. Use `--opencode-checkpoint PATH` to select another file, `--opencode-executable PATH` to select the command, or `--no-opencode-export` to disable this adapter.

Diagnostics report missing commands, empty session-list output and its platform-shell retry, malformed or partial JSON, timeouts, output limits, and per-session export failures. One bad export does not stop later polls. Rivetplane does not read OpenCode SQLite data.

## Managed OpenCode mode

The existing direct HTTP mode remains available with `--opencode-url URL`. To start a loopback-only managed server and an attached TUI explicitly, run:

```sh
npx rivetplane opencode
```

Managed and direct HTTP sessions support messages, interrupts, approvals, and questions. The default export adapter does not start a server or TUI.

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
