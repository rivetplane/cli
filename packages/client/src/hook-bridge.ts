import type { NativeHookEnvelope, HookBridgeResult } from "./hook-ingestion.js";
import { createHash, randomUUID } from "node:crypto";
import { defaultHookDiscoveryPath, HOOK_OWNER, readHookDiscovery, validateHookEndpoint } from "./hook-discovery.js";

const MAX_STDIN = 1_000_000;

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
  const nativeRequestId = firstString(payload, ["request_id", "requestId", "requestID", "permission_request_id", "tool_use_id", "toolUseId", "tool_call_id", "toolCallId", ...(harness === "opencode" ? ["id"] : [])]);
  const telemetryIdentity = !nativeRequestId && harness === "codex" && event === "PermissionRequest"
    ? `codex-telemetry-${createHash("sha256").update(session_id).update("\0").update(String(payload.turn_id ?? "")).update("\0").update(String(payload.tool_name ?? "")).update("\0").update(JSON.stringify(payload.tool_input ?? null)).digest("hex").slice(0, 32)}`
    : undefined;
  const request_id = nativeRequestId ?? (harness === "claude-code" && event === "PermissionRequest" ? `rivetplane-${randomUUID()}` : telemetryIdentity);
  return { version: 1, harness, event, session_id, cwd, transport: harness === "opencode" ? "opencode-plugin" : `${harness}-hook-command`, payload,
    ...(request_id ? { request_id } : {}), ...(telemetryIdentity ? { request_id_kind: "telemetry" as const } : nativeRequestId ? { request_id_kind: "native" as const } : {}), ...(firstString(payload, ["model", "model_id"]) ? { model: firstString(payload, ["model", "model_id"])! } : {}),
    ...(firstString(payload, ["agent", "agent_name"]) ? { agent: firstString(payload, ["agent", "agent_name"])! } : {}),
    ...(firstString(payload, ["timestamp"]) ? { timestamp: firstString(payload, ["timestamp"])! } : {}) };
}

export async function emitHook(harness: string, event: string, options: { owner?: string; endpoint?: string; token?: string; discovery_path?: string; payload?: Record<string, unknown>; timeout_ms?: number } = {}): Promise<unknown> {
  if (options.owner !== HOOK_OWNER) throw new Error("Hook ownership marker is invalid");
  try {
    if (process.env.RIVETPLANE_HOOKS_DISABLED === "1") return {};
    const payload = options.payload ?? await readHookInput(); const envelope = toHookEnvelope(harness, event, payload);
    const configuredEndpoint = options.endpoint ?? process.env.RIVETPLANE_HOOK_ENDPOINT;
    const configuredToken = options.token ?? process.env.RIVETPLANE_HOOK_TOKEN;
    const discovery = configuredEndpoint && configuredToken ? undefined : await readHookDiscovery(options.discovery_path ?? process.env.RIVETPLANE_HOOK_DISCOVERY ?? defaultHookDiscoveryPath());
    const endpoint = validateHookEndpoint(configuredEndpoint ?? discovery?.endpoint);
    const token = configuredToken ?? discovery?.token;
    if (!token) return {};
    const actionable = (harness === "claude-code" && event === "PermissionRequest") || (harness === "opencode" && (event === "permission.asked" || event === "question.asked"));
    const environmentTimeout = Number(process.env.RIVETPLANE_HOOK_TIMEOUT_MS);
    const timeout = options.timeout_ms ?? (Number.isSafeInteger(environmentTimeout) && environmentTimeout > 0 ? environmentTimeout : actionable ? 125_000 : 3_000);
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "x-rivetplane-hook-owner": HOOK_OWNER, "x-rivetplane-hook-token": token }, body: JSON.stringify(envelope), signal: AbortSignal.timeout(timeout) });
    if (!response.ok) return {};
    return formatNativeResult(harness, event, payload, await response.json() as HookBridgeResult);
  } catch { return {}; }
}

export function formatNativeResult(harness: string, event: string, input: Record<string, unknown>, result: HookBridgeResult): unknown {
  if (result.decision === "neutral") return {};
  if (harness === "opencode") return result;
  if (harness === "claude-code" && event === "PermissionRequest") {
    const decision = result.decision === "deny" ? { behavior: "deny", message: "Denied through Rivetplane" } : { behavior: "allow", updatedInput: { ...object(input.tool_input), ...object(result.updated_input) } };
    return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
  }
  if (harness === "claude-code" && (event === "AskUserQuestion" || (event === "PreToolUse" && input.tool_name === "AskUserQuestion")) && result.decision === "answer") {
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...object(input.tool_input), ...result.updated_input } } };
  }
  return {};
}
