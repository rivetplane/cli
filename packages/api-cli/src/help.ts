import { createRequire } from "node:module";

export const VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

export const HELP = `Rivetplane API CLI

Usage:
  rivetplane-api [global options] <command> [arguments]

Global options:
  --server <url>       Control-plane server (or RIVETPLANE_SERVER)
  --token <token>      API token (prefer RIVETPLANE_TOKEN or --token-stdin)
  --token-stdin        Read the API token from standard input
  --json               Emit stable JSON; tail emits newline-delimited JSON
  --no-input           Never prompt
  -h, --help           Show help
  -V, --version        Show version

Commands:
  login [--server URL] [--token-stdin]  Save server and token securely
  logout                              Delete saved credentials
  config show                         Show configuration without the token
  machines list                       List paired machines
  sessions list [filters]             List sessions
  sessions get <session-id>           Get one session
  transcript get <session-id>         Get transcript events
  transcript tail <session-id>        Follow transcript events
  message send <session-id>            Send a message
  pending get <session-id>             Get the current pending interaction
  pending respond <session-id>         Respond to the exact pending interaction
  interrupt <session-id> --yes         Interrupt the current agent turn
  completion <bash|zsh|fish>           Print shell completion
  examples                             Show script examples

Run "rivetplane-api <command> --help" for command options.`;

export const EXAMPLES = `# Configure without placing the token in shell history
printf '%s\\n' "$RIVETPLANE_TOKEN" | rivetplane-api login \\
  --server https://control.example.com --token-stdin

# Use environment variables only in CI
RIVETPLANE_SERVER=https://control.example.com \\
RIVETPLANE_TOKEN="$CI_RIVETPLANE_TOKEN" \\
rivetplane-api --json sessions list --status waiting_approval

# Read the exact pending ID and approve it once
pending_id=$(rivetplane-api --json pending get "$SESSION_ID" | jq -r '.id')
rivetplane-api pending respond "$SESSION_ID" --pending-id "$pending_id" \\
  --response approve --scope once

# Send message text through standard input
printf '%s\\n' 'Run the focused tests.' | rivetplane-api message send "$SESSION_ID" --text-file -

# Consume live events as NDJSON
rivetplane-api --json transcript tail "$SESSION_ID"`;

export function commandHelp(command: string, subcommand?: string): string | undefined {
  const key = [command, subcommand].filter(Boolean).join(" ");
  const values: Record<string, string> = {
    login: "Usage: rivetplane-api login --server <url> [--token-stdin]\n\nToken sources: --token-stdin, RIVETPLANE_TOKEN, or a hidden interactive prompt.",
    "machines list": "Usage: rivetplane-api machines list",
    "sessions list": "Usage: rivetplane-api sessions list [--machine ID] [--harness NAME] [--status STATUS] [--cwd TEXT]",
    "sessions get": "Usage: rivetplane-api sessions get <session-id>",
    "transcript get": "Usage: rivetplane-api transcript get <session-id> [--since ISO-8601] [--limit N] [--cursor VALUE] [--all]",
    "transcript tail": "Usage: rivetplane-api transcript tail <session-id> [--since ISO-8601]",
    "message send": "Usage: rivetplane-api message send <session-id> (--text TEXT | --text-file PATH|-)",
    "pending get": "Usage: rivetplane-api pending get <session-id>",
    "pending respond": "Usage: rivetplane-api pending respond <session-id> --pending-id ID --response VALUE [--scope once|always_this_tool|always_session]",
    interrupt: "Usage: rivetplane-api interrupt <session-id> --yes",
    completion: "Usage: rivetplane-api completion <bash|zsh|fish>",
  };
  return values[key] ?? values[command];
}
