# Rivetplane CLI

Rivetplane connects local ACP-compatible and OpenCode agent sessions to a remote control plane. The client starts all remote connections. It does not open an internet-facing port. When OpenCode is installed, Rivetplane starts a loopback-only OpenCode server on an available port and manages its lifetime.

## Use the client

Node.js 24 or later is required.

```sh
npx rivetplane login
npx rivetplane opencode
```

The login command uses `https://rivetplane.com`, opens the control plane in your browser, and stores a machine-scoped token in your user configuration directory. The second command starts ACP discovery, the local API, the outbound relay, and an OpenCode TUI attached to Rivetplane's managed OpenCode server. Keep it running while you use the control plane. Use `--server` only for a self-hosted control plane.

Use plain `npx rivetplane` when you want only the background relay. It prints its local server URL and an `opencode attach` command. An independent `opencode` process uses a separate internal runtime, so Rivetplane cannot observe its process-local approvals or questions.

Run `npx rivetplane --help` for all options.

Source and release instructions are in the [Rivetplane CLI repository](https://github.com/rivetplane/cli).
