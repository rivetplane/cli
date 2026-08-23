# Rivetplane CLI

Rivetplane connects local ACP-compatible and OpenCode agent sessions to a remote control plane. The client starts all remote connections. It does not open an inbound network port.

## Use the client

Node.js 24 or later is required.

```sh
npx rivetplane login --server https://harness-control-plane-dimavedenyapin.fly.dev
npx rivetplane
```

The login command opens the control plane in your browser and stores a machine-scoped token in your user configuration directory. The second command starts ACP discovery, the local API, and the outbound relay. Keep it running while you use the control plane.

Run `npx rivetplane --help` for all options.

Source and release instructions are in the [Rivetplane CLI repository](https://github.com/rivetplane/cli).
