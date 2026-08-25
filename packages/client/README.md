# Rivetplane CLI

Rivetplane connects local ACP-compatible and OpenCode agent sessions to a remote control plane. The client starts all remote connections. It does not open an internet-facing port or start OpenCode by default.

## Use the client

Node.js 22 or later is required. Rivetplane tests and publishes releases on Node.js 24.

```sh
npx rivetplane login
npx rivetplane
```

The login command uses `https://rivetplane.com`, opens the control plane in your browser, and stores a machine-scoped token in your user configuration directory. The second command starts ACP discovery, read-only OpenCode export discovery, the local API, and the outbound relay. Keep it running while you use the control plane. Use `--server` only for a self-hosted control plane.

When `opencode` is on `PATH`, Rivetplane polls the JSON session list and exports new, changed, or recent sessions. It relays stable transcript diffs and can detect running question tools and supported explicit permission requests. It uses no server, `jq`, or direct SQLite access. Compact checkpoints in `~/.config/harness-cp/opencode-export-checkpoints.json` prevent replay after a restart.

Export discovery cannot resolve a Deferred in the original OpenCode process. Exported sessions are marked read-only. Answer questions and approvals in that original process. Use `npx rivetplane opencode` for the explicit managed server and attached-TUI mode, or `--opencode-url URL` for an existing OpenCode HTTP server. These direct modes keep full control support.

Run `npx rivetplane --help` for all options.

Source and release instructions are in the [Rivetplane CLI repository](https://github.com/rivetplane/cli).
