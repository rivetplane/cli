import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import type { JsonValue, PendingInteraction, SessionStatus } from "@rivetplane/shared/model";
import type { HarnessCapabilities } from "@rivetplane/shared/protocol";
import type { CommandTarget } from "./relay.js";
import { SessionRegistry } from "./registry.js";

export const HOOK_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_HOOK_WAIT_MS = 120_000;
export const DEFAULT_CLAUDE_QUESTION_WAIT_MS = 15_000;

export type HookActionMode = "actionable" | "telemetry" | "lifecycle";

export interface NativeHookEnvelope {
  version: typeof HOOK_PROTOCOL_VERSION;
  harness: string;
  event: string;
  session_id: string;
  request_id?: string;
  request_id_kind?: "native" | "telemetry";
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
const VERIFIED_EVENTS: Record<string, Set<string>> = {
  "claude-code": new Set(["PermissionRequest", "PreToolUse", "AskUserQuestion", "PostToolUse", "Stop", "SessionEnd"]),
  codex: new Set(["SessionStart", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop", "SessionEnd"]),
  opencode: new Set(["session.created", "session.updated", "session.status", "session.idle", "session.deleted", "session.error", "permission.asked", "permission.replied", "question.asked", "question.replied", "question.rejected"]),
};

function string(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function timestamp(value: string | undefined): string { return value && !Number.isNaN(Date.parse(value)) ? value : new Date().toISOString(); }
function summary(value: unknown, limit = 500): string { const raw = typeof value === "string" ? value : JSON.stringify(value); return (raw ?? "").slice(0, limit); }
function cleanTitle(value: unknown): string | undefined {
  const title = string(value)?.replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 160) : undefined;
}
function messageText(value: unknown): string | undefined {
  if (typeof value === "string") return cleanTitle(value);
  if (!Array.isArray(value)) return undefined;
  return cleanTitle(value.flatMap((part) => {
    const item = object(part);
    return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join(" "));
}
async function claudeTranscriptTitle(payload: Record<string, unknown>): Promise<string | undefined> {
  const path = string(payload.transcript_path);
  if (!path) return undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return undefined;
    handle = await open(path, "r");
    const buffer = Buffer.alloc(Math.min(info.size, 256 * 1024));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    let firstUser: string | undefined; let customTitle: string | undefined;
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      let record: Record<string, unknown>;
      try { record = object(JSON.parse(line)); } catch { continue; }
      if (record.type === "custom-title") customTitle = cleanTitle(record.customTitle);
      if (!firstUser && record.type === "user" && record.isMeta !== true) {
        const message = object(record.message);
        const candidate = message.role === "user" ? messageText(message.content) : undefined;
        if (candidate && !candidate.startsWith("<local-command")) firstUser = candidate;
      }
    }
    return customTitle ?? firstUser;
  } catch { return undefined; }
  finally { await handle?.close().catch(() => undefined); }
}
function eventId(input: NativeHookEnvelope): string {
  const cursor = input.cursor === undefined ? "" : String(input.cursor);
  const identity = `${input.harness}\0${input.session_id}\0${input.event}\0${input.request_id ?? ""}\0${cursor}\0${JSON.stringify(input.payload)}`;
  return `hook-${createHash("sha256").update(identity).digest("hex")}`;
}

function eventMode(input: NativeHookEnvelope): HookActionMode {
  if (ACTIONABLE_EVENTS[input.harness]?.has(input.event)) return "actionable";
  if (input.harness === "codex" && input.event === "PermissionRequest") return "telemetry";
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
    ...(input.request_id_kind === "native" || input.request_id_kind === "telemetry" ? { request_id_kind: input.request_id_kind } : {}),
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
  #authoritativeTarget: (harness: string, sessionId: string) => boolean = () => false;
  constructor(readonly machine_id: string, readonly registry: SessionRegistry, private readonly wait_ms = DEFAULT_HOOK_WAIT_MS) {}

  target(id: string): CommandTarget | undefined { return this.#targets.has(id) ? new HookTarget(this, id) : undefined; }
  setAuthoritativeTarget(check: (harness: string, sessionId: string) => boolean): void { this.#authoritativeTarget = check; }
  harnesses(): Array<{ harness_type: string; discovered_sessions: number; attached_sessions: number; discovered_session_ids: string[]; attached_session_ids: string[] }> {
    return [...this.#harnesses.keys()].map((harness_type) => {
      const ids = this.registry.list().filter((session) => session.harness_type === harness_type && session.metadata && object(session.metadata).transport === this.#harnesses.get(harness_type)?.transport).map((session) => session.id);
      return { harness_type, discovered_sessions: ids.length, attached_sessions: ids.length, discovered_session_ids: ids, attached_session_ids: ids };
    });
  }
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
    if (input.harness === "codex" && input.event === "PermissionRequest" && !input.request_id) input = withCodexTelemetryIdentity(input);
    validateVerifiedPayload(input);
    const claudeQuestionPermission = isClaudeQuestionPermission(input);
    const claudeQuestionObservation = input.harness === "claude-code" && input.event === "PreToolUse" && string(input.payload.tool_name) === "AskUserQuestion";
    if (claudeQuestionPermission || claudeQuestionObservation) input = { ...input, event: "AskUserQuestion" };
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
    if (this.#authoritativeTarget(input.harness, id)) return { decision: "neutral" };
    const transcriptTitle = input.harness === "claude-code" ? await claudeTranscriptTitle(input.payload) : undefined;
    const title = transcriptTitle ?? prior?.title;
    const clearTelemetry = shouldClearTelemetryPending(input, prior);
    const status = this.#status(input.event, prior?.status);
    this.registry.upsert({
      id, machine_id: this.machine_id, harness_type: input.harness, cwd: input.cwd, status,
      created_at: prior?.created_at ?? ts, last_activity_at: ts, pending: clearTelemetry ? null : prior?.pending ?? null,
      ...(input.model ? { model: parseModel(input.model) } : prior?.model ? { model: prior.model } : {}),
      ...(input.agent ? { agent: input.agent } : prior?.agent ? { agent: prior.agent } : {}), ...(title ? { title } : {}), read_only: harnessMode !== "actionable",
      metadata: { ...object(prior?.metadata), transport: input.transport, hook_event: input.event, hook_mode: harnessMode, ...(clearTelemetry ? { hook_pending: null } : {}), ...(input.harness === "campfire" ? { role: "host" } : {}) } as JsonValue,
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

    const pending = this.#pending(input, ts, claudeQuestionObservation);
    if (!pending) {
      if (isResolution(input.event) && input.request_id) this.#settle(id, input.request_id, { decision: "neutral" }, true);
      return { decision: "neutral" };
    }
    this.registry.setPending(id, pending);
    const session = this.registry.get(id);
    if (session) this.registry.upsert({ ...session, metadata: { ...object(session.metadata), hook_pending: { id: pending.id, turn_id: string(input.payload.turn_id), ...(input.request_id_kind === "native" ? { tool_use_id: pending.id } : {}) } } as JsonValue }, { authority: harnessMode === "actionable" ? 80 : 40 });
    this.registry.setStatus(id, pending.type === "approval" ? "waiting_approval" : "waiting_input");
    if (pending.type === "approval") this.registry.append(id, "permission_request", { approval_id: pending.id, tool_name: pending.tool_name, tool_input_summary: pending.tool_input_summary }, idempotency);
    if (mode !== "actionable" || claudeQuestionObservation) return { decision: "neutral" };
    this.#targets.add(id);
    return new Promise<HookBridgeResult>((resolve) => {
      const key = waiterKey(id, pending.id); const replaced = this.#waiters.get(key);
      if (replaced) { clearTimeout(replaced.timer); replaced.resolve({ decision: "neutral" }); }
      const waiter = { session_id: id, pending_id: pending.id, resolve, timer: undefined as unknown as NodeJS.Timeout };
      const waitMs = claudeQuestionPermission ? Math.min(this.wait_ms, DEFAULT_CLAUDE_QUESTION_WAIT_MS) : this.wait_ms;
      waiter.timer = setTimeout(() => {
        if (this.#waiters.get(key) !== waiter) return;
        if (claudeQuestionPermission && pending.type === "question") {
          this.registry.setPending(id, { ...pending, read_only: true });
          this.registry.setStatus(id, "waiting_input");
          this.#settle(id, pending.id, { decision: "neutral" }, false);
        } else this.#settle(id, pending.id, { decision: "neutral" }, true);
      }, waitMs);
      this.#waiters.set(key, waiter);
    });
  }

  respond(sessionId: string, pendingId: string, response: string, scope?: "once" | "always_this_tool" | "always_session"): void {
    const waiter = this.#waiters.get(waiterKey(sessionId, pendingId)); const pending = this.registry.get(sessionId)?.pending;
    if (!waiter || waiter.session_id !== sessionId || !pending || pending.id !== pendingId) throw new Error(`Pending interaction ${pendingId} is no longer active`);
    clearTimeout(waiter.timer); this.#waiters.delete(waiterKey(sessionId, pendingId)); this.#removeTargetIfIdle(sessionId); this.registry.setPending(sessionId, null); this.registry.setStatus(sessionId, "running");
    if (pending.type === "approval") {
      const decision = response === "deny" ? "deny" : "approve";
      this.registry.append(sessionId, "permission_response", { approval_id: pendingId, resolution: decision, ...(scope ? { scope } : {}) });
      waiter.resolve({ decision, ...(scope ? { scope } : {}) });
    } else {
      const answers = decodeAnswers(response, pending.questions?.length ?? 1);
      const nativeAnswers = this.registry.get(sessionId)?.harness_type === "claude-code" ? Object.fromEntries((pending.questions ?? []).map((question, index) => [question.prompt, answers[index]?.join(", ") ?? ""])) : answers;
      waiter.resolve({ decision: "answer", response, updated_input: { answers: nativeAnswers } });
    }
  }

  stop(): void {
    for (const waiter of [...this.#waiters.values()]) this.#settle(waiter.session_id, waiter.pending_id, { decision: "neutral" }, true);
    this.#targets.clear(); this.#cursors.clear();
  }

  #settle(sessionId: string, pendingId: string, result: HookBridgeResult, clearPending: boolean): void {
    const key = waiterKey(sessionId, pendingId); const waiter = this.#waiters.get(key);
    if (waiter) { clearTimeout(waiter.timer); this.#waiters.delete(key); waiter.resolve(result); }
    const pending = this.registry.get(sessionId)?.pending;
    if (clearPending && pending?.id === pendingId) { this.registry.setPending(sessionId, null); this.registry.setStatus(sessionId, "waiting_input"); }
    this.#removeTargetIfIdle(sessionId);
  }

  #removeTargetIfIdle(sessionId: string): void {
    if (![...this.#waiters.values()].some((waiter) => waiter.session_id === sessionId)) this.#targets.delete(sessionId);
  }

  #pending(input: NativeHookEnvelope, ts: string, readOnlyQuestion = false): PendingInteraction | undefined {
    const requestId = input.request_id ?? string(input.payload.request_id) ?? string(input.payload.permission_request_id) ?? string(input.payload.tool_use_id) ?? string(input.payload.tool_call_id);
    if (!requestId) return undefined;
    if (input.event === "PermissionRequest" || input.event === "permission.asked") return { type: "approval", id: requestId, session_id: input.session_id,
      tool_name: string(input.payload.tool_name) ?? string(input.payload.permission) ?? "tool", tool_input_summary: summary(input.payload.tool_input ?? input.payload.patterns), requested_at: ts, read_only: eventMode(input) !== "actionable" };
    if (/^(AskUserQuestion|question\.asked)$/i.test(input.event)) {
      const toolInput = object(input.payload.tool_input);
      const rawQuestions = Array.isArray(input.payload.questions) ? input.payload.questions : Array.isArray(toolInput.questions) ? toolInput.questions : [];
      const questions = rawQuestions.map((value) => object(value));
      const normalized = questions.map((question) => ({ prompt: string(question.question) ?? string(question.prompt) ?? "Question", header: string(question.header) ?? "Question",
        options: Array.isArray(question.options) ? question.options.map((option) => { const item = object(option); return { label: string(item.label) ?? String(option), ...(string(item.description) ? { description: item.description as string } : {}) }; }) : [],
        ...(typeof question.multiSelect === "boolean" ? { multiple: question.multiSelect } : typeof question.multiple === "boolean" ? { multiple: question.multiple } : {}), custom: true }));
      return { type: "question", id: requestId, session_id: input.session_id, prompt: normalized.map((item) => item.prompt).join("\n") || string(input.payload.prompt) || "Question",
        options: normalized.flatMap((item) => item.options.map((option) => option.label)), questions: normalized, tool_call_id: string(input.payload.tool_use_id), requested_at: ts,
        read_only: eventMode(input) !== "actionable" || readOnlyQuestion };
    }
    return undefined;
  }

  #status(event: string, prior: SessionStatus | undefined): SessionStatus {
    if (/error|failure/i.test(event)) return "error";
    if (/^(SessionEnd|session\.deleted)$/i.test(event)) return "completed";
    if (/^(Stop|session\.idle)$/i.test(event)) return "waiting_input";
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
function waiterKey(sessionId: string, pendingId: string): string { return `${sessionId}\0${pendingId}`; }
function isClaudeQuestionPermission(input: NativeHookEnvelope): boolean {
  if (input.harness !== "claude-code" || input.event !== "PermissionRequest" || string(input.payload.tool_name) !== "AskUserQuestion") return false;
  return Array.isArray(object(input.payload.tool_input).questions) && (object(input.payload.tool_input).questions as unknown[]).length > 0;
}

function validateVerifiedPayload(input: NativeHookEnvelope): void {
  if (!VERIFIED_EVENTS[input.harness]?.has(input.event)) throw new Error(`Harness hook interface is unsupported: ${input.harness}/${input.event}`);
  if (input.harness === "claude-code") {
    if (input.transport !== "claude-code-hook-command") throw new Error("Claude hook transport is invalid");
    if (input.payload.session_id !== input.session_id || input.payload.cwd !== input.cwd || input.payload.hook_event_name !== input.event) throw new Error("Claude hook identity does not match its official payload");
    if (/^(PreToolUse|PostToolUse|PermissionRequest)$/.test(input.event) && (!string(input.payload.tool_name) || !input.payload.tool_input || typeof input.payload.tool_input !== "object")) throw new Error("Claude tool hook payload is invalid");
    if (/^(PreToolUse|PostToolUse)$/.test(input.event) && string(input.payload.tool_use_id) !== input.request_id) throw new Error("Claude tool-use ID does not match");
    if (input.event === "PermissionRequest" && (!input.request_id || !input.request_id.startsWith("rivetplane-"))) throw new Error("Claude PermissionRequest needs a Rivetplane bridge ID");
    return;
  }
  if (input.harness === "codex") {
    if (input.transport !== "codex-hook-command") throw new Error("Codex hook transport is invalid");
    if (input.payload.session_id !== input.session_id || input.payload.cwd !== input.cwd || input.payload.hook_event_name !== input.event) throw new Error("Codex hook identity does not match its official payload");
    if (!string(input.payload.turn_id) && /^(PreToolUse|PostToolUse|PermissionRequest|Stop)$/.test(input.event)) throw new Error("Codex turn ID is required");
    if (/^(PreToolUse|PostToolUse)$/.test(input.event) && string(input.payload.tool_use_id) !== input.request_id) throw new Error("Codex tool-use ID does not match");
    if (/^(PreToolUse|PostToolUse|PermissionRequest)$/.test(input.event) && (!string(input.payload.tool_name) || !("tool_input" in input.payload))) throw new Error("Codex tool hook payload is invalid");
    if (input.event === "PermissionRequest" && input.request_id_kind !== "telemetry") throw new Error("Codex PermissionRequest needs a telemetry identity when no native request ID exists");
    return;
  }
  if (input.transport !== "opencode-plugin") throw new Error("OpenCode plugin transport is invalid");
  const info = object(input.payload.info); const nativeSessionId = string(input.payload.sessionID) ?? string(info.id);
  if (nativeSessionId !== input.session_id) throw new Error("OpenCode session ID does not match");
  const nativeRequestId = string(input.payload.id) ?? string(input.payload.requestID);
  if ((/permission|question/.test(input.event)) && nativeRequestId !== input.request_id) throw new Error("OpenCode request ID does not match");
  if (input.event === "question.asked") {
    if (!Array.isArray(input.payload.questions) || input.payload.questions.length === 0) throw new Error("OpenCode question payload is invalid");
    for (const raw of input.payload.questions) {
      const question = object(raw);
      if (!string(question.header) || !string(question.question) || !Array.isArray(question.options)) throw new Error("OpenCode question shape is invalid");
      for (const rawOption of question.options) if (!string(object(rawOption).label)) throw new Error("OpenCode question option is invalid");
    }
  }
  if (input.event === "permission.asked" && (!string(input.payload.permission) || !Array.isArray(input.payload.patterns))) throw new Error("OpenCode permission payload is invalid");
}
function parseModel(value: string): { provider_id: string; model_id: string } { const [provider, ...model] = value.split("/"); return model.length ? { provider_id: provider!, model_id: model.join("/") } : { provider_id: "unknown", model_id: value }; }
function safeJson(value: unknown): JsonValue | undefined { try { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) as JsonValue; } catch { return undefined; } }
function decodeAnswers(response: string, count: number): string[][] { try { const value = JSON.parse(response) as unknown; if (Array.isArray(value) && value.every((item) => Array.isArray(item) && item.every((answer) => typeof answer === "string"))) return Array.from({ length: count }, (_, index) => (value[index] as string[] | undefined) ?? []); if (count === 1 && Array.isArray(value) && value.every((item) => typeof item === "string")) return [value as string[]]; } catch {} return Array.from({ length: count }, (_, index) => index === 0 ? [response] : []); }

function shouldClearTelemetryPending(input: NativeHookEnvelope, prior: ReturnType<SessionRegistry["get"]>): boolean {
  const pending = prior?.pending; const metadata = object(prior?.metadata); const marker = object(metadata.hook_pending);
  if (!pending?.read_only || metadata.transport !== "codex-hook-command" || input.event === "PermissionRequest") return false;
  if (!(isToolStart(input.event) || isToolEnd(input.event) || /^(Stop|SessionEnd)$/.test(input.event))) return false;
  const markedTool = string(marker.tool_use_id); const incomingTool = input.request_id ?? string(input.payload.tool_use_id);
  if (markedTool && incomingTool) return markedTool === incomingTool;
  const markedTurn = string(marker.turn_id); const incomingTurn = string(input.payload.turn_id);
  return !markedTurn || !incomingTurn || markedTurn === incomingTurn;
}

function withCodexTelemetryIdentity(input: NativeHookEnvelope): NativeHookEnvelope {
  const id = `codex-telemetry-${createHash("sha256").update(input.session_id).update("\0").update(String(input.payload.turn_id ?? "")).update("\0").update(String(input.payload.tool_name ?? "")).update("\0").update(JSON.stringify(input.payload.tool_input ?? null)).digest("hex").slice(0, 32)}`;
  return { ...input, request_id: id, request_id_kind: "telemetry" };
}
