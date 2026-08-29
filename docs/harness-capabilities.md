# Harness integration capability matrix

The hook installer supports an integration only when the repository contains a checked configuration fixture and a checked native event fixture from an official public interface. An unsupported row is not installed, even when its binary is present.

| Harness | Hook or plugin installation | Verified hook behavior | Other Rivetplane adapter | Status |
|---|---|---|---|---|
| Claude Code | `~/.claude/settings.json` or `CLAUDE_CONFIG_DIR/settings.json` | PermissionRequest, PreToolUse, PostToolUse, Stop, and SessionEnd; AskUserQuestion uses the PreToolUse payload and exact tool-use ID | Existing-session JSONL discovery is read-only | Verified and supported |
| OpenCode | `~/.config/opencode/plugins/rivetplane.ts` or `XDG_CONFIG_HOME/opencode/plugins/rivetplane.ts` | Official plugin event envelope, exact permission/question ID, multi-question option arrays, free text, and reply events | HTTP/SSE is authoritative for attached sessions; CLI export is read-only | Verified and supported |
| Codex | `${CODEX_HOME:-~/.codex}/hooks.json`; `config.toml` is inspected but not changed | SessionStart, SessionEnd, Stop, non-blocking PreToolUse/PostToolUse telemetry, and non-actionable PermissionRequest attention; no standalone request_user_input | Rollout discovery is read-only; only threads created, resumed, or actively controlled through the Rivetplane-owned app-server are live read-write | Verified telemetry-only hook; managed app-server is actionable |
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

## Usage metadata

Usage support is additive. Older harness and ACP versions continue to work and can report no usage.

| Harness | Usage source | Limits |
|---|---|---|
| ACP | `session/update` `usage_update` | Context `used`/`size` is not counted as tokens. Cost is cumulative. |
| Codex | `thread/tokenUsage/updated`; optional account token-usage and rate-limit methods | Checked with Codex CLI 0.149.1. Account methods are version-dependent. Credit cost is estimated, not currency billing. |
| Claude Code | Existing session JSONL plus an owned status-line tee installed with Claude hooks | The tee preserves and restores an existing status-line command. It forwards usage fields only. Context, cost, and rate limits are version-dependent. Cost is estimated. |
| OpenCode | Native assistant message fields through HTTP/SSE or CLI export | Message cost is harness-reported. Model context needs provider-roster data. |

All adapters emit only usage metadata. They do not put prompt text, message text, tool payloads, or file content in a usage sample. Cumulative counters use a durable reset-aware checkpoint and stable event IDs to prevent duplicate replay after reconnect or restart.

The checked fixtures are in `packages/client/src/fixtures/hooks`. The code test compares generated Claude and Codex configuration with their fixtures. It also checks the generated OpenCode plugin contract and runs the official native payload fixtures through normalization and reply handling.

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
- Codex standalone hooks never wait for or return a Rivetplane decision. A PermissionRequest can create only a read-only attention record. The next matching tool start, tool end, Stop, or SessionEnd clears it.
- Codex PermissionRequest has no native request ID in the current generated hook schema. Rivetplane creates a deterministic telemetry identity for deduplication. It is never actionable.
- Normal `codex` has no standalone `request_user_input` hook. Exact question and approval responses require the managed app-server.

## Official sources

- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [OpenCode plugin reference](https://opencode.ai/docs/plugins/)
- [OpenCode server reference](https://opencode.ai/docs/server/)
- [Codex app-server source and protocol](https://github.com/openai/codex/tree/main/codex-rs/app-server)
- [Codex generated hook schemas](https://github.com/openai/codex/tree/main/codex-rs/hooks/schema/generated)

No hook or restore support is claimed for an interface that does not have a checked fixture in this repository.
