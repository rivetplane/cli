import type { NativeHookEnvelope, HookBridgeResult } from "./hook-ingestion.js";

const MAX_STDIN = 1_000_000;
const OWNER = "rivetplane-hook-v1";

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function firstString(input: Record<string, unknown>, names: string[]): string | undefined { for (const name of names) if (typeof input[name] === "string" && input[name]) return input[name] as string; return undefined; }

export async function readHookInput(stream: NodeJS.ReadableStream = process.stdin): Promise<Record<string, unknown>> {
  const argument = process.argv.at(-1);
  if (argument?.trimStart().startsWith("{")) return object(JSON.parse(argument));
  let raw = "";
  for await (const chunk of stream) { raw += String(chunk); if (raw.length > MAX_STDIN) throw new Error("Hook input is too large"); }
  return object(raw ? JSON.parse(raw) : {});
}

export function toHookEnvelope(harness: string, configuredEvent: string, payload: Record<string, unknown>): NativeHookEnvelope {
  const session_id = firstString(payload, ["session_id", "sessionId", "sessionID", "thread-id", "thread_id", "threadId"]);
  if (!session_id) throw new Error("Native hook input has no session ID");
  const event = firstString(payload, ["hook_event_name", "event", "type"]) ?? configuredEvent;
  const cwd = firstString(payload, ["cwd", "directory", "working_directory"]) ?? process.cwd();
  const request_id = firstString(payload, ["request_id", "requestId", "permission_request_id", "tool_use_id", "toolUseId", "tool_call_id", "toolCallId"]);
  return { version: 1, harness, event, session_id, cwd, transport: `${harness}-hook-command`, payload,
    ...(request_id ? { request_id } : {}), ...(firstString(payload, ["model", "model_id"]) ? { model: firstString(payload, ["model", "model_id"])! } : {}),
    ...(firstString(payload, ["agent", "agent_name"]) ? { agent: firstString(payload, ["agent", "agent_name"])! } : {}),
    ...(firstString(payload, ["timestamp"]) ? { timestamp: firstString(payload, ["timestamp"])! } : {}) };
}

export async function emitHook(harness: string, event: string, options: { endpoint?: string; payload?: Record<string, unknown>; timeout_ms?: number } = {}): Promise<unknown> {
  if (process.env.RIVETPLANE_HOOKS_DISABLED === "1") return {};
  const payload = options.payload ?? await readHookInput(); const envelope = toHookEnvelope(harness, event, payload);
  const endpoint = options.endpoint ?? process.env.RIVETPLANE_HOOK_ENDPOINT ?? `http://127.0.0.1:${process.env.HARNESS_CP_LOCAL_PORT ?? "41737"}/v1/hooks/events`;
  try {
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "x-rivetplane-hook-owner": OWNER }, body: JSON.stringify(envelope), signal: AbortSignal.timeout(options.timeout_ms ?? 125_000) });
    if (!response.ok) return {};
    return formatNativeResult(harness, event, payload, await response.json() as HookBridgeResult);
  } catch { return {}; }
}

export function formatNativeResult(harness: string, event: string, input: Record<string, unknown>, result: HookBridgeResult): unknown {
  if (result.decision === "neutral") return {};
  if (harness === "claude-code" && event === "PermissionRequest") {
    const decision = result.decision === "deny" ? { behavior: "deny", message: "Denied through Rivetplane" } : { behavior: "allow", updatedInput: object(input.tool_input) };
    return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
  }
  if (harness === "claude-code" && (event === "AskUserQuestion" || (event === "PreToolUse" && input.tool_name === "AskUserQuestion")) && result.decision === "answer") {
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...object(input.tool_input), ...result.updated_input } } };
  }
  return {};
}
