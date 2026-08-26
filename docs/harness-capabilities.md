# Harness integration capability matrix

This matrix reports only interfaces that have a public, exact identity contract. “Actionable” means that Rivetplane can send a native response for the exact pending request. “Telemetry” means that Rivetplane can observe an event but does not control it. “Lifecycle” means that Rivetplane reports session state only.

| Harness | Lifecycle and transcript | Approval or question | Message and interrupt | Restore | Integration status |
|---|---|---|---|---|---|
| Claude Code | Native hooks and existing JSONL discovery | Actionable `PermissionRequest` and `AskUserQuestion` only in a Rivetplane hook process; existing plain sessions stay read-only | Unsupported for an arbitrary plain session | `claude --resume <id>` | Actionable hooks plus read-only discovery |
| Codex | Hook telemetry, rollout discovery, and app-server events | Actionable only through app-server exact request IDs; stock TUI hooks are telemetry | Actionable only through managed or configured app-server | `codex resume <id>` | App-server actionable; hooks telemetry |
| Grok | `PreToolUse`, `Notification`, and `Stop` | No verified exact-ID reply interface | Unsupported | `grok -r <id>` | Telemetry |
| OpenCode | Native HTTP/SSE and plugin event bus | Actionable through exact permission and question request IDs; options and free text are supported | Actionable through live HTTP/SSE | `opencode --session <id>` | Actionable live adapter and plugin |
| Pi | Extension lifecycle and tool execution events | No verified exact-ID pending interface | Unsupported | `pi --session <id>` | Telemetry |
| OMP | Native extension lifecycle | No verified exact-ID pending interface | Unsupported | `omp --session <id>` | Lifecycle |
| Campfire | Host lifecycle and collaboration notifications; joiner invite URLs are not stored | Driver notification only; no verified exact-ID hook reply | Unsupported | Not claimed | Lifecycle |
| Amp | Plugin lifecycle and status | No verified exact-ID pending interface | Unsupported | `amp threads continue <id>` | Lifecycle |
| Cursor CLI | `beforeShellExecution` | Telemetry only | Unsupported | `cursor-agent --resume <id>` | Telemetry |
| Gemini CLI | `BeforeTool` | Telemetry only | Unsupported | `gemini --resume <id>` | Telemetry |
| Kiro CLI | `SessionStart`, `PreToolUse`, `PostToolUse`, and `Stop` | Telemetry only | Unsupported | `kiro-cli chat --resume-id <id>` | Telemetry |
| Rovo Dev | Session restore evidence | No verified actionable event | Unsupported | `acli rovodev run --restore <id>` | Lifecycle |
| Copilot CLI | `PreToolUse` | Telemetry only | Unsupported | `copilot --resume <id>` | Telemetry |
| CodeBuddy | `PreToolUse` | Telemetry only | Unsupported | `codebuddy --resume <id>` | Telemetry |
| Factory/Droid | `PreToolUse` | Telemetry only | Unsupported | `droid --resume <id>` | Telemetry |
| Qoder | `PreToolUse` | Telemetry only | Unsupported | `qodercli --resume <id>` | Telemetry |
| Kimi Code | `PreToolUse` and `PostToolUse` | Telemetry only | Unsupported | Not claimed | Telemetry |

## Safety rules

- A hook preserves the full native session ID, request ID, tool ID, cwd, model, agent, and transport name.
- Codex stock hooks never wait for a remote decision. Its supported app-server is the action interface.
- A blocking bridge has a 120-second soft wait. A timeout returns a neutral result.
- A reply must match the current session ID and pending ID. A late or stale reply is rejected.
- OpenCode live HTTP/SSE capabilities have priority over export discovery capabilities.
- A native resolution event, or an exact-ID list refresh, clears pending state.
- Hook files use an ownership marker. Installation preserves other settings. Installation refuses to replace an unmarked standalone file.
- `RIVETPLANE_HOOKS_DISABLED=1` disables hooks for one process.
- Launch command capture removes prompts, credentials, environment assignments, old session selectors, and unsafe noninteractive flags.
- Campfire records only the host role. It does not store or replay joiner invite URLs.

## Interface research

The implementation was checked against these public interfaces:

- [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks)
- [Claude Code CLI resume](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
- [Codex app-server protocol](https://github.com/openai/codex/tree/main/codex-rs/app-server)
- [Codex configuration](https://developers.openai.com/codex/config-reference/)
- [OpenCode plugins](https://opencode.ai/docs/plugins/)
- [OpenCode server](https://opencode.ai/docs/server/)
- [Pi extensions](https://pi.dev/docs/latest/extensions)
- [Pi RPC events](https://pi.dev/docs/latest/rpc)
- [Cursor hooks](https://cursor.com/docs/hooks)
- [Gemini CLI hooks](https://geminicli.com/docs/hooks/reference/)
- [Kiro hooks](https://kiro.dev/docs/hooks/)
- [GitHub Copilot hooks](https://docs.github.com/en/copilot/reference/hooks-reference)
- [Factory/Droid hooks](https://docs.factory.ai/harness/hooks)
- [Qoder hooks](https://docs.qoder.com/cli/hooks)
- [Kimi Code hooks](https://moonshotai.github.io/kimi-code/en/customization/hooks)
- [Rovo Dev CLI](https://developer.atlassian.com/cloud/acli/reference/commands/rovodev/)

No action support is claimed for a harness that does not publish an exact-ID response interface.
