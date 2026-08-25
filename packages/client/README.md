# Rivetplane CLI

Rivetplane connects local ACP-compatible and OpenCode agent sessions to a remote control plane. The client starts all remote connections. It does not open an inbound network port.

## Use the client

Node.js 24 or later is required.

```sh
npx rivetplane login
npx rivetplane
```

The login command uses `https://rivetplane.com`, opens the control plane in your browser, and stores a machine-scoped token in your user configuration directory. The second command starts ACP discovery, the local API, and the outbound relay. Keep it running while you use the control plane. Use `--server` only for a self-hosted control plane.

Run `npx rivetplane --help` for all options.

Source and release instructions are in the [Rivetplane CLI repository](https://github.com/rivetplane/cli).
