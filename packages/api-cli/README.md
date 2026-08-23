# Rivetplane API CLI

`rivetplane-api` is the script-friendly command line client for the Rivetplane control-plane API. It is separate from the `rivetplane` local harness runner.

The CLI uses the first-party `@rivetplane/sdk`. It does not implement a second HTTP or streaming transport.

## Install and run

```sh
npx @rivetplane/api-cli --help
npm install --global @rivetplane/api-cli
rivetplane-api --version
```

Node.js 24 or later is required.

## Login and credentials

Create an API token in the Rivetplane dashboard. Then pass it through standard input so it does not enter shell history:

```sh
printf '%s\n' "$RIVETPLANE_TOKEN" | rivetplane-api login \
  --server https://control.example.com \
  --token-stdin
```

The CLI writes the configuration to `$XDG_CONFIG_HOME/rivetplane/api-cli.json`, or `~/.config/rivetplane/api-cli.json`. It sets the directory mode to `0700` and the file mode to `0600` on systems that support POSIX permissions. `RIVETPLANE_CONFIG_DIR` can set a different configuration directory.

For CI, do not write a configuration file. Use environment variables:

```sh
export RIVETPLANE_SERVER=https://control.example.com
export RIVETPLANE_TOKEN="$CI_RIVETPLANE_TOKEN"
rivetplane-api --no-input --json machines list
```

The precedence is command options, environment variables, and then the saved configuration. Use `rivetplane-api logout` to delete the saved configuration. `config show` never prints the token.

`login` checks the server and token with the machines API before it writes the file.

## Commands

```text
rivetplane-api machines list
rivetplane-api sessions list [--machine ID] [--harness NAME] [--status STATUS] [--cwd TEXT]
rivetplane-api sessions get SESSION_ID
rivetplane-api transcript get SESSION_ID [--since TIME] [--limit N] [--cursor VALUE] [--all]
rivetplane-api transcript tail SESSION_ID
rivetplane-api message send SESSION_ID --text "Continue with the tests."
rivetplane-api message send SESSION_ID --text-file message.txt
rivetplane-api pending get SESSION_ID
rivetplane-api pending respond SESSION_ID --pending-id ID --response approve --scope once
rivetplane-api interrupt SESSION_ID --yes
```

`transcripts` is an alias for `transcript`. `--json` writes JSON for one-time commands. A tail writes one JSON object per line. Data goes to standard output. Errors go to standard error.

`pending respond` first gets the current pending interaction and compares its ID with `--pending-id`. The SDK and server also enforce this match. This check prevents a response to a new interaction after a race.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Success |
| 2 | Invalid command or option |
| 3 | Missing, invalid, or forbidden credentials |
| 4 | Resource not found |
| 5 | State conflict, such as a stale pending ID or an offline runner |
| 6 | API, server, network, or stream failure |
| 7 | User interruption |
| 8 | Missing or invalid configuration |
| 10 | Unexpected local failure |

These codes are part of the CLI compatibility contract.

## Completion and examples

```sh
# Bash
source <(rivetplane-api completion bash)

# Zsh
source <(rivetplane-api completion zsh)

# Fish
rivetplane-api completion fish | source

rivetplane-api examples
```

## Development

```sh
npm install
npm run typecheck
npm test
npm pack --dry-run
```

The end-to-end tests start a local HTTP and SSE server. They run the built CLI as a separate process with the real TypeScript SDK.
