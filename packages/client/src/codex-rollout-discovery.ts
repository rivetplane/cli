import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Approval, PendingInteraction, Question, Session, TranscriptEventPayloadMap, TranscriptEventType } from "@rivetplane/shared/model";
import type { HarnessCapabilities } from "@rivetplane/shared/protocol";
import type { CommandTarget } from "./relay.js";
import { SessionRegistry } from "./registry.js";
import type { HarnessDiscoveryStatus } from "./session-manager.js";

type RecordValue = Record<string, unknown>;
interface Checkpoint { path: string; offset: number; size: number; mtime_ms: number; inode?: number; meta?: RolloutMeta; skipping_line?: boolean }
interface CheckpointFile { version: 1; sessions: Record<string, Checkpoint> }
interface RolloutMeta { id: string; cwd: string; created_at: string; cli_version?: string; model_provider?: string }
interface ParsedEvent { type: TranscriptEventType; payload: TranscriptEventPayloadMap[TranscriptEventType]; id: string; ts: string }
interface ParsedLine { meta?: RolloutMeta; event?: ParsedEvent; pending?: PendingInteraction; resolved_pending_id?: string; resolved_pending_resolution?: "approve" | "deny" }

export interface CodexRolloutDiscoveryOptions {
  sessions_directory?: string;
  checkpoint_path?: string;
  interval_ms?: number;
  recent_window_ms?: number;
  max_sessions?: number;
  max_scan_files?: number;
  max_initial_bytes?: number;
  max_incremental_bytes?: number;
  max_event_text_bytes?: number;
  concurrency?: number;
  scan_interval_ms?: number;
  retry_base_ms?: number;
  max_retry_ms?: number;
  now?: () => number;
}

function object(value: unknown): RecordValue | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined; }
function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function timestamp(value: unknown, fallback = Date.now()): string { const date = new Date(typeof value === "string" || typeof value === "number" ? value : fallback); return Number.isNaN(date.valueOf()) ? new Date(fallback).toISOString() : date.toISOString(); }
function stableId(sessionId: string, value: unknown): string { return `codex-${createHash("sha256").update(sessionId).update("\0").update(JSON.stringify(value)).digest("hex").slice(0, 32)}`; }
function boundedText(value: unknown, maxBytes: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  const buffer = Buffer.from(text);
  if (buffer.byteLength <= maxBytes) return text;
  if (maxBytes <= 3) return ".".repeat(Math.max(0, maxBytes));
  let prefix = buffer.subarray(0, maxBytes - 3).toString("utf8");
  while (Buffer.byteLength(prefix) > maxBytes - 3) prefix = prefix.slice(0, -1);
  return `${prefix}...`;
}
function sessionTitle(value: unknown): string | undefined {
  const title = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return title && !title.startsWith("<") ? title.slice(0, 160) : undefined;
}
function contentText(content: unknown[], maxBytes: number): string {
  return boundedText(content.flatMap((part) => { const item = object(part); const value = string(item?.text); return value && (item?.type === "input_text" || item?.type === "output_text" || item?.type === "text") ? [value] : []; }).join(""), maxBytes);
}
function sourceField(source: string, field: string): string | undefined {
  const match = source.match(new RegExp(`\\b${field}\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`));
  if (!match?.[1]) return undefined;
  try { const value = JSON.parse(match[1]); return typeof value === "string" ? value : undefined; } catch { return undefined; }
}
function escalatedCustomCall(payload: RecordValue, sessionId: string, ts: string): Approval | undefined {
  const input = string(payload.input); const callId = string(payload.call_id);
  if (!input || !callId || !/\bsandbox_permissions\s*:\s*["']require_escalated["']/.test(input)) return undefined;
  const command = sourceField(input, "cmd") ?? string(payload.name) ?? "tool";
  const justification = sourceField(input, "justification");
  return { type: "approval", id: callId, session_id: sessionId, tool_name: string(payload.name) ?? "tool", tool_input_summary: boundedText(justification ? `${command}\n${justification}` : command, 2_000), requested_at: ts, read_only: true };
}
function codexQuestion(payload: RecordValue, sessionId: string, ts: string): Question | undefined {
  if (payload.name !== "request_user_input") return undefined;
  const callId = string(payload.call_id); const source = string(payload.arguments);
  if (!callId || !source) return undefined;
  let input: RecordValue | undefined; try { input = object(JSON.parse(source)); } catch { return undefined; }
  const rawQuestions = Array.isArray(input?.questions) ? input.questions : [];
  const questions = rawQuestions.flatMap((raw) => {
    const item = object(raw); const prompt = string(item?.question); if (!prompt) return [];
    const options = Array.isArray(item?.options) ? item.options.flatMap((rawOption) => {
      const option = object(rawOption); const label = string(option?.label); const description = string(option?.description); return label ? [{ label, ...(description ? { description } : {}) }] : [];
    }) : [];
    return [{ prompt, header: string(item?.header) ?? "Question", options, multiple: false, custom: true }];
  });
  if (!questions.length) return undefined;
  return { type: "question", id: callId, session_id: sessionId, prompt: questions.map((item) => item.prompt).join("\n"), options: questions.flatMap((item) => item.options.map((option) => option.label)), questions, tool_call_id: callId, requested_at: ts, read_only: true };
}
async function mapLimit<T>(values: readonly T[], concurrency: number, operation: (value: T) => Promise<void>): Promise<void> {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (index < values.length) { const value = values[index++]; if (value !== undefined) await operation(value); }
  }));
}

export function parseCodexRolloutLine(line: string, fallbackSessionId: string, maxTextBytes = 64 * 1024): ParsedLine {
  let root: RecordValue;
  try { const parsed = object(JSON.parse(line)); if (!parsed) return {}; root = parsed; } catch { return {}; }
  const payload = object(root.payload); const ts = timestamp(root.timestamp);
  if (root.type === "session_meta" && payload) {
    const id = string(payload.id) ?? fallbackSessionId; const cwd = string(payload.cwd);
    if (!id || !cwd) return {};
    return { meta: { id, cwd, created_at: timestamp(payload.timestamp ?? root.timestamp), ...(string(payload.cli_version) ? { cli_version: string(payload.cli_version) } : {}), ...(string(payload.model_provider) ? { model_provider: string(payload.model_provider) } : {}) } };
  }
  if (root.type !== "response_item" || !payload) return {};
  const payloadType = string(payload.type); const identity = { ts, payload };
  if (payloadType === "message" && (payload.role === "user" || payload.role === "assistant")) {
    const text = contentText(Array.isArray(payload.content) ? payload.content : [], maxTextBytes); if (!text) return {};
    const type = payload.role === "user" ? "user_message" : "agent_message";
    return { event: { type, payload: { text }, id: stableId(fallbackSessionId, identity), ts } as ParsedEvent };
  }
  if (payloadType === "function_call") {
    const callId = string(payload.call_id) ?? stableId(fallbackSessionId, identity); const name = string(payload.name) ?? "tool";
    const pending = codexQuestion(payload, fallbackSessionId, ts);
    return { event: { type: "tool_call", payload: { tool_call_id: callId, tool_name: name, input_summary: boundedText(payload.arguments, 2_000) }, id: stableId(fallbackSessionId, identity), ts }, ...(pending ? { pending } : {}) };
  }
  if (payloadType === "function_call_output") {
    const callId = string(payload.call_id) ?? stableId(fallbackSessionId, identity); const output = boundedText(payload.output, maxTextBytes);
    return { event: { type: "tool_result", payload: { tool_call_id: callId, output_summary: output, is_error: false }, id: stableId(fallbackSessionId, identity), ts }, resolved_pending_id: callId };
  }
  if (payloadType === "custom_tool_call") {
    const callId = string(payload.call_id) ?? stableId(fallbackSessionId, identity); const name = string(payload.name) ?? "tool";
    const pending = escalatedCustomCall(payload, fallbackSessionId, ts);
    return { event: { type: "tool_call", payload: { tool_call_id: callId, tool_name: name, input_summary: boundedText(payload.input, 2_000) }, id: stableId(fallbackSessionId, identity), ts }, ...(pending ? { pending } : {}) };
  }
  if (payloadType === "custom_tool_call_output") {
    const callId = string(payload.call_id) ?? stableId(fallbackSessionId, identity); const output = boundedText(payload.output, maxTextBytes);
    const denied = /aborted|denied|cancel|error|failed/i.test(output);
    return { event: { type: "tool_result", payload: { tool_call_id: callId, output_summary: output, is_error: denied }, id: stableId(fallbackSessionId, identity), ts }, resolved_pending_id: callId, resolved_pending_resolution: denied ? "deny" : "approve" };
  }
  return {};
}

class ReadOnlyCodexTarget implements CommandTarget {
  async sendMessage(): Promise<void> { throw new Error("This Codex session was discovered from a rollout file and is read-only; Rivetplane cannot attach to an independently launched stdio process"); }
  async respondToPending(): Promise<void> { throw new Error("This Codex pending interaction is read-only"); }
  async interrupt(): Promise<void> { throw new Error("This Codex session is not attached to a supported app-server transport"); }
}

async function rolloutFiles(root: string, limit: number): Promise<Array<{ path: string; mtime: number }>> {
  const files: Array<{ path: string; mtime: number }> = [];
  async function walk(directory: string): Promise<void> {
    if (files.length >= limit) return;
    let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((left, right) => right.name.localeCompare(left.name))) {
      if (files.length >= limit) break;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) { const value = await stat(path).catch(() => undefined); if (value) files.push({ path, mtime: value.mtimeMs }); }
    }
  }
  await walk(root); return files.sort((a, b) => b.mtime - a.mtime);
}

export class CodexRolloutDiscovery {
  readonly sessions_directory: string;
  readonly checkpoint_path: string;
  #timer: NodeJS.Timeout | undefined;
  #polling = false;
  #loaded = false;
  #checkpoints: CheckpointFile = { version: 1, sessions: {} };
  #present = new Set<string>();
  #available = false;
  #files: string[] = [];
  #nextScanAt = 0;
  #fileFailures = new Map<string, { attempts: number; next_attempt_at: number }>();

  constructor(readonly machine_id: string, readonly registry: SessionRegistry, private readonly options: CodexRolloutDiscoveryOptions = {}) {
    this.sessions_directory = options.sessions_directory ?? join(homedir(), ".codex", "sessions");
    this.checkpoint_path = options.checkpoint_path ?? join(homedir(), ".config", "harness-cp", "codex-rollout-checkpoints.json");
  }
  async start(): Promise<void> { await this.poll(); this.#timer = setInterval(() => void this.poll(), this.options.interval_ms ?? 2_000); this.#timer.unref(); }
  stop(): void { if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; }
  target(id: string): CommandTarget | undefined { return this.#present.has(id) && this.registry.get(id)?.read_only !== false ? new ReadOnlyCodexTarget() : undefined; }
  harnesses(): HarnessDiscoveryStatus[] { return this.#available ? [{ harness_type: "codex", discovered_sessions: this.#present.size, attached_sessions: 0, discovered_session_ids: [...this.#present], attached_session_ids: [], capabilities: this.health() }] : []; }
  capabilities(): HarnessCapabilities | undefined {
    if (!this.#available) return undefined;
    const reason = "Codex rollout files are read-only; use 'rivetplane codex' for a managed app-server session";
    return { machine_id: this.machine_id, harness_type: "codex", can_create_session: false, directories: [], models: [], reported_at: new Date().toISOString(), transport: "codex-rollout-jsonl", session_capabilities: this.health(), limitations: [reason] };
  }
  health() {
    const unsupported = (reason: string) => ({ supported: false, mode: "unsupported" as const, reason });
    const readOnly = { supported: this.#available, mode: "read_only" as const, ...(!this.#available ? { reason: "The Codex sessions directory is not readable." } : {}) };
    const noAttach = "A rollout file does not provide a supported live attachment transport.";
    return { persisted_discovery: readOnly, discovery: readOnly, transcript: readOnly, live_attachment: unsupported(noAttach), messaging: unsupported(noAttach), interrupt: unsupported(noAttach), question_response: unsupported(noAttach), approval_response: unsupported(noAttach), transport: "rollout-jsonl", managed: false };
  }

  async poll(): Promise<void> {
    if (this.#polling) return; this.#polling = true;
    try {
      await this.#load();
      await access(this.sessions_directory, constants.R_OK); this.#available = true;
      const now = this.options.now?.() ?? Date.now();
      if (now >= this.#nextScanAt) {
        const cutoff = now - (this.options.recent_window_ms ?? 24 * 60 * 60_000); const limit = Math.max(1, this.options.max_sessions ?? 48);
        const candidates = await rolloutFiles(this.sessions_directory, this.options.max_scan_files ?? 10_000);
        this.#files = candidates.filter((file) => file.mtime >= cutoff).slice(0, limit).map((file) => file.path);
        this.#nextScanAt = now + (this.options.scan_interval_ms ?? 30_000);
      }
      const seen = new Set<string>();
      await mapLimit(this.#files, this.options.concurrency ?? 2, async (path) => {
        const retry = this.#fileFailures.get(path); const current = this.options.now?.() ?? Date.now();
        if (retry && current < retry.next_attempt_at) { const id = this.#checkpointForPath(path)?.meta?.id; if (id) seen.add(id); return; }
        try { const id = await this.#read(path); if (id) seen.add(id); this.#fileFailures.delete(path); }
        catch (error) {
          const attempts = (retry?.attempts ?? 0) + 1; const delay = this.#retryDelay(attempts); const id = this.#checkpointForPath(path)?.meta?.id;
          if (id) seen.add(id); this.#fileFailures.set(path, { attempts, next_attempt_at: current + delay });
          this.registry.emit("warning", new Error(`Codex rollout ${basename(path)} failed; retrying in ${Math.ceil(delay / 1_000)}s: ${error instanceof Error ? error.message : String(error)}`));
        }
      });
      for (const id of this.#present) if (!seen.has(id) && this.registry.get(id)?.read_only !== false) this.registry.remove(id);
      this.#present = seen; await this.#save();
    } catch (error) { this.#available = false; this.registry.emit("warning", new Error(`Codex rollout discovery failed: ${error instanceof Error ? error.message : String(error)}`)); }
    finally { this.#polling = false; }
  }

  async #read(path: string): Promise<string | undefined> {
    const info = await stat(path); const fallback = basename(path, ".jsonl").split("-").at(-1) ?? basename(path, ".jsonl");
    let checkpoint = this.#checkpointForPath(path);
    if (checkpoint && !this.registry.get(checkpoint.meta?.id ?? fallback)) checkpoint = undefined;
    const rotated = checkpoint && ((checkpoint.inode !== undefined && Number(info.ino) !== checkpoint.inode) || info.size < checkpoint.offset);
    if (rotated) checkpoint = undefined;
    let start = checkpoint?.offset ?? 0; const max = checkpoint ? (this.options.max_incremental_bytes ?? 1024 * 1024) : (this.options.max_initial_bytes ?? 4 * 1024 * 1024);
    if (!checkpoint && info.size > max) start = Math.max(0, info.size - max);
    const length = Math.min(max, Math.max(0, info.size - start));
    const handle = await open(path, "r"); let raw = "";
    try { const buffer = Buffer.alloc(length); const read = await handle.read(buffer, 0, length, start); raw = buffer.subarray(0, read.bytesRead).toString("utf8"); } finally { await handle.close(); }
    let skippedBytes = 0; let forcedConsumed = 0; let skippingLine = checkpoint?.skipping_line ?? false;
    if (skippingLine || (start > 0 && !checkpoint)) {
      const newline = raw.indexOf("\n");
      if (newline < 0) { forcedConsumed = Buffer.byteLength(raw); raw = ""; skippingLine = true; }
      else { skippedBytes = Buffer.byteLength(raw.slice(0, newline + 1)); raw = raw.slice(newline + 1); skippingLine = false; }
    } else if (raw.lastIndexOf("\n") < 0 && length === max) { forcedConsumed = Buffer.byteLength(raw); raw = ""; skippingLine = true; }
    const lastNewline = raw.lastIndexOf("\n"); const complete = lastNewline >= 0 ? raw.slice(0, lastNewline + 1) : ""; const lines = complete.split("\n"); lines.pop();
    let meta = checkpoint?.meta;
    if (!meta) {
      const headHandle = await open(path, "r"); const headBuffer = Buffer.alloc(Math.min(128 * 1024, info.size));
      let head = ""; try { const result = await headHandle.read(headBuffer, 0, headBuffer.length, 0); head = headBuffer.subarray(0, result.bytesRead).toString("utf8"); } finally { await headHandle.close(); }
      for (const line of head.split("\n")) { const parsed = parseCodexRolloutLine(line, fallback, this.options.max_event_text_bytes); if (parsed.meta) { meta = parsed.meta; break; } }
    }
    if (!meta) return undefined;
    const current = this.registry.get(meta.id); const controlled = current?.read_only === false && object(current.metadata)?.codex_control === "app-server";
    const recent = info.mtimeMs >= (this.options.now?.() ?? Date.now()) - (this.options.recent_window_ms ?? 24 * 60 * 60_000);
    const pending = current?.pending ?? null;
    const session: Session = { id: meta.id, machine_id: this.machine_id, harness_type: "codex", cwd: meta.cwd, status: controlled ? current.status : pending?.type === "question" ? "waiting_input" : pending ? "waiting_approval" : "completed", created_at: meta.created_at,
      last_activity_at: info.mtime.toISOString(), pending, title: current?.title, read_only: !controlled,
      ...(meta.model_provider ? { model: { provider_id: meta.model_provider, model_id: "unknown" } } : {}),
      metadata: controlled ? current.metadata : { discovery: "rollout", activity: recent ? "recently_updated" : "persisted", live_process_attached: false, cli_version: meta.cli_version ?? "unknown" } };
    this.registry.upsert(session);
    for (const line of lines) {
      const parsed = parseCodexRolloutLine(line, meta.id, this.options.max_event_text_bytes); const event = parsed.event;
      if (event) {
        this.registry.append(meta.id, event.type, event.payload as never, { id: event.id, ts: event.ts });
        if (event.type === "user_message" && !this.registry.get(meta.id)?.title) {
          const title = sessionTitle((event.payload as TranscriptEventPayloadMap["user_message"]).text); const latest = this.registry.get(meta.id);
          if (title && latest) this.registry.upsert({ ...latest, title });
        }
      }
      if (!controlled && parsed.pending) {
        this.registry.setPending(meta.id, parsed.pending); this.registry.setStatus(meta.id, parsed.pending.type === "approval" ? "waiting_approval" : "waiting_input");
        if (parsed.pending.type === "approval") this.registry.append(meta.id, "permission_request", { approval_id: parsed.pending.id, tool_name: parsed.pending.tool_name, tool_input_summary: parsed.pending.tool_input_summary }, { id: `${event?.id ?? parsed.pending.id}-permission`, ts: parsed.pending.requested_at });
      }
      if (!controlled && parsed.resolved_pending_id) {
        const active = this.registry.get(meta.id)?.pending;
        if (active && active.id === parsed.resolved_pending_id) {
          this.registry.setPending(meta.id, null); this.registry.setStatus(meta.id, "completed");
          if (active.type === "approval") this.registry.append(meta.id, "permission_response", { approval_id: active.id, resolution: parsed.resolved_pending_resolution ?? "deny" }, { id: `${event?.id ?? active.id}-permission`, ts: event?.ts });
        }
      }
    }
    const consumed = start + skippedBytes + forcedConsumed + Buffer.byteLength(complete);
    this.#checkpoints.sessions[meta.id] = { path, offset: consumed, size: info.size, mtime_ms: info.mtimeMs, inode: Number(info.ino), meta, ...(skippingLine ? { skipping_line: true } : {}) };
    return meta.id;
  }

  async #load(): Promise<void> {
    if (this.#loaded) return; this.#loaded = true;
    try { const value = JSON.parse(await readFile(this.checkpoint_path, "utf8")) as CheckpointFile; if (value.version === 1 && value.sessions && typeof value.sessions === "object") this.#checkpoints = value; } catch { /* first run or invalid checkpoint */ }
  }
  async #save(): Promise<void> {
    const entries = Object.entries(this.#checkpoints.sessions).sort((a, b) => b[1].mtime_ms - a[1].mtime_ms).slice(0, 1_000);
    this.#checkpoints.sessions = Object.fromEntries(entries); await mkdir(dirname(this.checkpoint_path), { recursive: true, mode: 0o700 });
    const temporary = `${this.checkpoint_path}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(this.#checkpoints)}\n`, { mode: 0o600 }); await rename(temporary, this.checkpoint_path);
  }
  #checkpointForPath(path: string): Checkpoint | undefined { return Object.values(this.#checkpoints.sessions).find((item) => item.path === path); }
  #retryDelay(attempts: number): number { return Math.min(this.options.max_retry_ms ?? 5 * 60_000, (this.options.retry_base_ms ?? 30_000) * 2 ** Math.max(0, attempts - 1)); }
}
