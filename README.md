# Rivetplane CLI

Rivetplane connects local ACP-compatible and OpenCode agent sessions to a remote control plane. The client makes outbound connections. It does not open an internet-facing port. When OpenCode is installed, Rivetplane starts a loopback-only OpenCode server on an available port and manages its lifetime.

## Use Rivetplane

Node.js 24 or later is required.

```sh
npx rivetplane login
npx rivetplane
```

The login command uses `https://rivetplane.com`, opens Rivetplane in your browser, and stores a machine-scoped token in your user configuration directory. The second command starts ACP discovery, the local API, and the outbound relay. Keep it running while you use Rivetplane. Use `--server` only for a self-hosted control plane.

If OpenCode is installed, the client prints its local server URL. Open an interactive TUI against the managed server with the command it prints:

```sh
opencode attach http://127.0.0.1:<port>
```

Use this attached TUI so Rivetplane can relay its live messages, approvals, and questions. An independent `opencode` process uses a separate internal runtime.

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
