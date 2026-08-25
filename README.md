# Rivetplane CLI

Rivetplane connects local ACP-compatible and OpenCode agent sessions to a remote control plane. The client makes outbound connections. It does not open an inbound network port.

## Use Rivetplane

Node.js 24 or later is required.

```sh
npx rivetplane login
npx rivetplane
```

The login command uses `https://rivetplane.com`, opens Rivetplane in your browser, and stores a machine-scoped token in your user configuration directory. The second command starts ACP discovery, the local API, and the outbound relay. Keep it running while you use Rivetplane. Use `--server` only for a self-hosted control plane.

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
