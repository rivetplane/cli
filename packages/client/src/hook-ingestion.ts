import { createHash } from "node:crypto";
import type { JsonValue, PendingInteraction, SessionStatus } from "@rivetplane/shared/model";
import type { HarnessCapabilities } from "@rivetplane/shared/protocol";
import type { CommandTarget } from "./relay.js";
import { SessionRegistry } from "./registry.js";

export const HOOK_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_HOOK_WAIT_MS = 120_000;

export type HookActionMode = "actionable" | "telemetry" | "lifecycle";

export interface NativeHookEnvelope {
  version: typeof HOOK_PROTOCOL_VERSION;
  harness: string;
  event: string;
  session_id: string;
  request_id?: string;
  cwd: string;
  model?: string;
  agent?: string;
  transport: string;
  timestamp?: string;
  cursor?: string | number;
  payload: Record<string, unknown>;
}

export interface HookBridgeResult {
  decision: "neutral" | "approve" | "deny" | "answer";
  response?: string;
  scope?: "once" | "always_this_tool" | "always_session";
  updated_input?: Record<string, unknown>;
}

interface Waiter { session_id: string; pending_id: string; resolve(value: HookBridgeResult): void; timer: NodeJS.Timeout }

const ACTIONABLE_EVENTS: Record<string, Set<string>> = {
  "claude-code": new Set(["PermissionRequest", "AskUserQuestion"]),
  opencode: new Set(["permission.asked", "question.asked"]),
};

function string(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function timestamp(value: string | undefined): string { return value && !Number.isNaN(Date.parse(value)) ? value : new Date().toISOString(); }
function summary(value: unknown, limit = 500): string { const raw = typeof value === "string" ? value : JSON.stringify(value); return (raw ?? "").slice(0, limit); }
function eventId(input: NativeHookEnvelope): string {
  const cursor = input.cursor === undefined ? "" : String(input.cursor);
  const identity = `${input.harness}\0${input.session_id}\0${input.event}\0${input.request_id ?? ""}\0${cursor}\0${JSON.stringify(input.payload)}`;
  return `hook-${createHash("sha256").update(identity).digest("hex")}`;
}

function eventMode(input: NativeHookEnvelope): HookActionMode {
  if (ACTIONABLE_EVENTS[input.harness]?.has(input.event)) return "actionable";
  if (/^(PreToolUse|PostToolUse|PostToolUseFailure|beforeShellExecution|BeforeTool|AfterTool|preToolUse|postToolUse|tool_execution_start|tool_execution_end)$/i.test(input.event)) return "telemetry";
  return "lifecycle";
}

export function validateHookEnvelope(value: unknown): NativeHookEnvelope {
  const input = object(value);
  if (input.version !== HOOK_PROTOCOL_VERSION) throw new Error("Unsupported hook protocol version");
  for (const field of ["harness", "event", "session_id", "cwd", "transport"] as const) if (!string(input[field])) throw new Error(`${field} is required`);
  return {
    version: HOOK_PROTOCOL_VERSION, harness: input.harness as string, event: input.event as string,
    session_id: input.session_id as string, cwd: input.cwd as string, transport: input.transport as string,
    ...(string(input.request_id) ? { request_id: input.request_id as string } : {}),
    ...(string(input.model) ? { model: input.model as string } : {}), ...(string(input.agent) ? { agent: input.agent as string } : {}),
    ...(string(input.timestamp) ? { timestamp: input.timestamp as string } : {}),
    ...(typeof input.cursor === "string" || typeof input.cursor === "number" ? { cursor: input.cursor } : {}), payload: object(input.payload),
  };
}

export class HookIngestor {
  #waiters = new Map<string, Waiter>();
  #targets = new Set<string>();
  #cursors = new Map<string, number>();
  #harnesses = new Map<string, { cwd: string; transport: string; mode: HookActionMode }>();
  constructor(readonly machine_id: string, readonly registry: SessionRegistry, private readonly wait_ms = DEFAULT_HOOK_WAIT_MS) {}

  target(id: string): CommandTarget | undefined { return this.#targets.has(id) ? new HookTarget(this, id) : undefined; }
  capabilities(): HarnessCapabilities[] {
    return [...this.#harnesses].map(([harness, state]) => {
      const actionable = state.mode === "actionable"; const telemetry = state.mode !== "lifecycle";
      const actionReason = actionable ? undefined : "This native hook has no verified exact-ID response interface";
      const unsupported = { supported: false, mode: "unsupported" as const, ...(actionReason ? { reason: actionReason } : {}) };
      return { machine_id: this.machine_id, harness_type: harness, can_create_session: false, directories: [state.cwd], models: [], reported_at: new Date().toISOString(), transport: state.transport,
        session_capabilities: {
          discovery: { supported: true, mode: "read_only" }, transcript: telemetry ? { supported: true, mode: "read_only" } : { supported: false, mode: "unsupported", reason: "Lifecycle events do not include a transcript" },
          live_attachment: { supported: true, mode: "read_only" }, messaging: unsupported, interrupt: unsupported,
          question_response: actionable && (harness === "claude-code" || harness === "opencode") ? { supported: true, mode: "read_write" } : unsupported,
          approval_response: actionable && (harness === "claude-code" || harness === "opencode") ? { supported: true, mode: "read_write" } : unsupported,
        } };
    });
  }

  async ingest(raw: unknown): Promise<HookBridgeResult> {
    let input = validateHookEnvelope(raw);
    if (input.harness === "campfire" && string(input.payload.role) && string(input.payload.role) !== "host") return { decision: "neutral" };
    if (input.harness === "claude-code" && input.event === "PreToolUse" && string(input.payload.tool_name) === "AskUserQuestion") input = { ...input, event: "AskUserQuestion" };
    const id = input.session_id; const ts = timestamp(input.timestamp); const mode = eventMode(input);
    const priorHarness = this.#harnesses.get(input.harness); const rank = (value: HookActionMode): number => value === "actionable" ? 3 : value === "telemetry" ? 2 : 1;
    if (!priorHarness || rank(mode) >= rank(priorHarness.mode)) this.#harnesses.set(input.harness, { cwd: input.cwd, transport: input.transport, mode });
    const harnessMode = this.#harnesses.get(input.harness)?.mode ?? mode;
    const cursorKey = `${input.harness}/${id}/${input.transport}`;
    if (typeof input.cursor === "number") {
      const prior = this.#cursors.get(cursorKey);
      if (prior !== undefined && input.cursor <= prior) return { decision: "neutral" };
      this.#cursors.set(cursorKey, input.cursor);
    }
    const prior = this.registry.get(id);
    const status = this.#status(input.event, prior?.status);
    this.registry.upsert({
      id, machine_id: this.machine_id, harness_type: input.harness, cwd: input.cwd, status,
      created_at: prior?.created_at ?? ts, last_activity_at: ts, pending: prior?.pending ?? null,
      ...(input.model ? { model: parseModel(input.model) } : prior?.model ? { model: prior.model } : {}),
      ...(input.agent ? { agent: input.agent } : prior?.agent ? { agent: prior.agent } : {}), read_only: harnessMode !== "actionable",
      metadata: { transport: input.transport, hook_event: input.event, hook_mode: harnessMode, ...(input.harness === "campfire" ? { role: "host" } : {}) } as JsonValue,
    }, { authority: harnessMode === "actionable" ? 80 : 40 });

    const idempotency = { id: eventId(input), ts };
    if (isToolStart(input.event)) this.registry.append(id, "tool_call", {
      tool_call_id: input.request_id ?? string(input.payload.tool_use_id) ?? string(input.payload.tool_call_id) ?? idempotency.id,
      tool_name: string(input.payload.tool_name) ?? string(input.payload.toolName) ?? "tool",
      input_summary: summary(input.payload.tool_input ?? input.payload.toolArgs ?? input.payload.input),
      input: safeJson(input.payload.tool_input ?? input.payload.toolArgs ?? input.payload.input),
    }, idempotency);
    else if (isToolEnd(input.event)) this.registry.append(id, "tool_result", {
      tool_call_id: input.request_id ?? string(input.payload.tool_use_id) ?? string(input.payload.tool_call_id) ?? idempotency.id,
      output_summary: summary(input.payload.tool_response ?? input.payload.tool_output ?? input.payload.output ?? input.payload.error),
      output: safeJson(input.payload.tool_response ?? input.payload.tool_output ?? input.payload.output), is_error: /failure|error/i.test(input.event) || Boolean(input.payload.error),
    }, idempotency);

    const pending = this.#pending(input, ts);
    if (!pending) {
      if (isResolution(input.event) && (!input.request_id || prior?.pending?.id === input.request_id)) this.registry.setPending(id, null);
      return { decision: "neutral" };
    }
    this.registry.setPending(id, pending);
    this.registry.setStatus(id, pending.type === "approval" ? "waiting_approval" : "waiting_input");
    if (pending.type === "approval") this.registry.append(id, "permission_request", { approval_id: pending.id, tool_name: pending.tool_name, tool_input_summary: pending.tool_input_summary }, idempotency);
    if (mode !== "actionable") return { decision: "neutral" };
    this.#targets.add(id);
    return new Promise<HookBridgeResult>((resolve) => {
      const timer = setTimeout(() => { this.#waiters.delete(pending.id); resolve({ decision: "neutral" }); }, this.wait_ms);
      timer.unref(); this.#waiters.set(pending.id, { session_id: id, pending_id: pending.id, resolve, timer });
    });
  }

  respond(sessionId: string, pendingId: string, response: string, scope?: "once" | "always_this_tool" | "always_session"): void {
    const waiter = this.#waiters.get(pendingId); const pending = this.registry.get(sessionId)?.pending;
    if (!waiter || waiter.session_id !== sessionId || !pending || pending.id !== pendingId) throw new Error(`Pending interaction ${pendingId} is no longer active`);
    clearTimeout(waiter.timer); this.#waiters.delete(pendingId); this.registry.setPending(sessionId, null); this.registry.setStatus(sessionId, "running");
    if (pending.type === "approval") {
      const decision = response === "deny" ? "deny" : "approve";
      this.registry.append(sessionId, "permission_response", { approval_id: pendingId, resolution: decision, ...(scope ? { scope } : {}) });
      waiter.resolve({ decision, ...(scope ? { scope } : {}) });
    } else waiter.resolve({ decision: "answer", response, updated_input: { answers: decodeAnswers(response, pending.questions?.length ?? 1) } });
  }

  #pending(input: NativeHookEnvelope, ts: string): PendingInteraction | undefined {
    const requestId = input.request_id ?? string(input.payload.request_id) ?? string(input.payload.permission_request_id) ?? string(input.payload.tool_use_id) ?? string(input.payload.tool_call_id);
    if (!requestId) return undefined;
    if (/permission/i.test(input.event)) return { type: "approval", id: requestId, session_id: input.session_id,
      tool_name: string(input.payload.tool_name) ?? "tool", tool_input_summary: summary(input.payload.tool_input), requested_at: ts, read_only: eventMode(input) !== "actionable" };
    if (/askuserquestion|question\.asked/i.test(input.event)) {
      const toolInput = object(input.payload.tool_input);
      const rawQuestions = Array.isArray(input.payload.questions) ? input.payload.questions : Array.isArray(toolInput.questions) ? toolInput.questions : [];
      const questions = rawQuestions.map((value) => object(value));
      const normalized = questions.map((question) => ({ prompt: string(question.question) ?? string(question.prompt) ?? "Question", header: string(question.header) ?? "Question",
        options: Array.isArray(question.options) ? question.options.map((option) => { const item = object(option); return { label: string(item.label) ?? String(option), ...(string(item.description) ? { description: item.description as string } : {}) }; }) : [],
        ...(typeof question.multiSelect === "boolean" ? { multiple: question.multiSelect } : {}), custom: true }));
      return { type: "question", id: requestId, session_id: input.session_id, prompt: normalized.map((item) => item.prompt).join("\n") || string(input.payload.prompt) || "Question",
        options: normalized.flatMap((item) => item.options.map((option) => option.label)), questions: normalized, tool_call_id: string(input.payload.tool_use_id), requested_at: ts,
        read_only: eventMode(input) !== "actionable" };
    }
    return undefined;
  }

  #status(event: string, prior: SessionStatus | undefined): SessionStatus {
    if (/error|failure/i.test(event)) return "error";
    if (/SessionEnd|Stop|session\.idle|session\.ended/i.test(event)) return "completed";
    if (/Notification/i.test(event)) return prior ?? "waiting_input";
    return "running";
  }
}

class HookTarget implements CommandTarget {
  constructor(private readonly ingestor: HookIngestor, private readonly id: string) {}
  sendMessage(): Promise<void> { return Promise.reject(new Error("This hook transport does not support messaging")); }
  interrupt(): Promise<void> { return Promise.reject(new Error("This hook transport does not support interrupt")); }
  respondToPending(id: string, response: string, scope?: "once" | "always_this_tool" | "always_session"): void { this.ingestor.respond(this.id, id, response, scope); }
}

function isToolStart(event: string): boolean { return /^(PreToolUse|beforeShellExecution|BeforeTool|preToolUse|tool_execution_start)$/i.test(event); }
function isToolEnd(event: string): boolean { return /^(PostToolUse|PostToolUseFailure|AfterTool|postToolUse|tool_execution_end)$/i.test(event); }
function isResolution(event: string): boolean { return /replied|resolved|rejected|cancelled/i.test(event); }
function parseModel(value: string): { provider_id: string; model_id: string } { const [provider, ...model] = value.split("/"); return model.length ? { provider_id: provider!, model_id: model.join("/") } : { provider_id: "unknown", model_id: value }; }
function safeJson(value: unknown): JsonValue | undefined { try { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) as JsonValue; } catch { return undefined; } }
function decodeAnswers(response: string, count: number): string[][] { try { const value = JSON.parse(response) as unknown; if (Array.isArray(value) && value.every((item) => Array.isArray(item) && item.every((answer) => typeof answer === "string"))) return Array.from({ length: count }, (_, index) => (value[index] as string[] | undefined) ?? []); if (count === 1 && Array.isArray(value) && value.every((item) => typeof item === "string")) return [value as string[]]; } catch {} return Array.from({ length: count }, (_, index) => index === 0 ? [response] : []); }
