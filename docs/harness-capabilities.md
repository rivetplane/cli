# Harness integration capability matrix

The hook installer supports an integration only when the repository contains a checked configuration fixture and a checked native event fixture from an official public interface. An unsupported row is not installed, even when its binary is present.

| Harness | Hook or plugin installation | Verified hook behavior | Other Rivetplane adapter | Status |
|---|---|---|---|---|
| Claude Code | `~/.claude/settings.json` or `CLAUDE_CONFIG_DIR/settings.json` | PermissionRequest, PreToolUse, PostToolUse, Stop, and SessionEnd; AskUserQuestion uses the PreToolUse payload and exact tool-use ID | Existing-session JSONL discovery is read-only | Verified and supported |
| OpenCode | `~/.config/opencode/plugins/rivetplane.ts` or `XDG_CONFIG_HOME/opencode/plugins/rivetplane.ts` | Official plugin event envelope, exact permission/question ID, multi-question option arrays, free text, and reply events | HTTP/SSE is authoritative for attached sessions; CLI export is read-only | Verified and supported |
| Codex | None | No hook configuration is installed | Managed or configured app-server is actionable; rollout discovery is read-only | Hook integration unsupported |
| Grok | None | No checked official configuration and payload fixture | None | Unsupported |
| Pi | None | No checked official configuration and payload fixture | None | Unsupported |
| OMP | None | No checked official configuration and payload fixture | None | Unsupported |
| Campfire | None | No checked official configuration and payload fixture | None | Unsupported |
| Amp | None | No checked official configuration and payload fixture | None | Unsupported |
| Cursor CLI | None | No checked official configuration and payload fixture | None | Unsupported |
| Gemini CLI | None | No checked official configuration and payload fixture | None | Unsupported |
| Kiro CLI | None | No checked official configuration and payload fixture | None | Unsupported |
| Rovo Dev | None | No checked official configuration and payload fixture | None | Unsupported |
| Copilot CLI | None | No checked official configuration and payload fixture | None | Unsupported |
| CodeBuddy | None | No checked official configuration and payload fixture | None | Unsupported |
| Factory/Droid | None | No checked official configuration and payload fixture | None | Unsupported |
| Qoder | None | No checked official configuration and payload fixture | None | Unsupported |
| Kimi Code | None | No checked official configuration and payload fixture | None | Unsupported |

The checked fixtures are in `packages/client/src/fixtures/hooks`. The code test compares the generated Claude settings with the configuration fixture. It also checks the generated OpenCode plugin contract and runs the official native payload fixtures through normalization and reply handling.

## Hook endpoint security

The local client creates a random 256-bit hook token. It writes the current loopback endpoint, token, process ID, owner marker, and start time to `~/.config/harness-cp/hook-endpoint.json`. The directory has mode `0700` and the file has mode `0600` on POSIX systems. The reader rejects a symbolic link, broad permissions, a different file owner, a non-loopback URL, a wrong owner marker, and a stale process. The client removes the file at shutdown only when the stored token still matches.

Every hook POST must send both `x-rivetplane-hook-owner: rivetplane-hook-v1` and the current secret in `x-rivetplane-hook-token`. This discovery record lets global hooks find a client that uses a custom port or port `0`.

## Lifecycle and waiter rules

- Stop and session.idle mean `waiting_input`.
- Only SessionEnd and session.deleted mean `completed`.
- A timeout, local reply, replacement, or shutdown settles its exact waiter and removes its target.
- A reply must match both the session ID and pending ID.
- OpenCode HTTP/SSE stays authoritative. A plugin event cannot create a second waiter for a session that the live adapter owns.
- OpenCode question replies preserve the full array for every question. Claude AskUserQuestion replies use the documented question-text-to-answer object.

## Official sources

- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [OpenCode plugin reference](https://opencode.ai/docs/plugins/)
- [OpenCode server reference](https://opencode.ai/docs/server/)
- [Codex app-server source and protocol](https://github.com/openai/codex/tree/main/codex-rs/app-server)

No hook or restore support is claimed for an interface that does not have a checked fixture in this repository.
