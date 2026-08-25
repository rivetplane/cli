import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";
import type { JsonValue, PendingInteraction, Question, SessionStatus } from "@rivetplane/shared/model";
import type { CommandTarget } from "./relay.js";
import { SessionRegistry } from "./registry.js";
import type { HarnessDiscoveryStatus } from "./session-manager.js";

type RecordValue = Record<string, unknown>;

export interface OpenCodeListSession {
  id: string;
  title?: string;
  directory?: string;
  projectId?: string;
  created?: number | string;
  updated?: number | string;
}

export interface OpenCodeProject {
  id: string;
  worktree: string;
  sandboxes: string[];
}

export interface CommandResult { stdout: string; stderr: string }
export type CommandRunner = (program: string, args: readonly string[], options: { cwd: string; timeout_ms: number; max_output_bytes: number }) => Promise<CommandResult>;

interface PartCheckpoint { hash: string; length?: number; status?: string }
interface SessionCheckpoint {
  updated?: number | string;
  parts: Record<string, PartCheckpoint>;
  pending?: PendingInteraction;
}
interface CheckpointFile { version: 1; sessions: Record<string, SessionCheckpoint> }

export interface OpenCodeExportDiscoveryOptions {
  executable?: string;
  /** Fixed arguments inserted before OpenCode arguments. Used by packaged launchers and tests. */
  executable_args?: string[];
  directory?: string;
  checkpoint_path?: string;
  interval_ms?: number;
  /** Full machine index refresh interval. The first refresh is immediate. */
  index_interval_ms?: number;
  max_index_interval_ms?: number;
  timeout_ms?: number;
  max_output_bytes?: number;
  max_sessions?: number;
  max_exports_per_poll?: number;
  max_export_candidates?: number;
  max_sessions_per_project?: number;
  database_page_size?: number;
  max_database_pages?: number;
  concurrency?: number;
  recent_window_ms?: number;
  runner?: CommandRunner;
  file_runner?: CommandRunner;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

function object(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function hash(value: string): string { return createHash("sha256").update(value).digest("base64url").slice(0, 22); }
function stableId(...values: string[]): string { return `opencode-export:${hash(values.join("\0"))}`; }
function timestamp(value: unknown, fallback = Date.now()): string {
  if (typeof value === "string") { const parsed = Date.parse(value); if (Number.isFinite(parsed)) return new Date(parsed).toISOString(); }
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value < 10_000_000_000 ? value * 1_000 : value).toISOString();
  return new Date(fallback).toISOString();
}
function epoch(value: number | string | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") { const parsed = Date.parse(value); if (Number.isFinite(parsed)) return parsed; }
  return undefined;
}
function jsonValue(value: unknown): JsonValue | undefined {
  try { return JSON.parse(JSON.stringify(value)) as JsonValue; } catch { return undefined; }
}
function summary(value: unknown, limit = 500): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? "").length > limit ? `${(text ?? "").slice(0, limit)}…` : (text ?? "");
}

/** Parse JSON with optional diagnostic text before the JSON value. */
export function parseCommandJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("command returned empty stdout");
  try { return JSON.parse(trimmed) as unknown; } catch {
    const starts = [trimmed.indexOf("["), trimmed.indexOf("{")].filter((index) => index >= 0).sort((a, b) => a - b);
    for (const start of starts) {
      try { return JSON.parse(trimmed.slice(start)) as unknown; } catch { /* try the next candidate */ }
    }
    throw new Error("command returned malformed or partial JSON");
  }
}

export function parseSessionList(stdout: string): OpenCodeListSession[] {
  const parsed = parseCommandJson(stdout);
  const values = Array.isArray(parsed) ? parsed : array(object(parsed)?.sessions ?? object(parsed)?.data);
  return values.flatMap((value) => {
    const item = object(value); const id = string(item?.id);
    if (!item || !id) return [];
    return [{ id, title: string(item.title), directory: string(item.directory), projectId: string(item.projectId ?? item.projectID),
      created: number(item.created) ?? string(item.created), updated: number(item.updated) ?? string(item.updated) }];
  });
}

export function parseProjectList(stdout: string): OpenCodeProject[] {
  const parsed = parseCommandJson(stdout);
  if (!Array.isArray(parsed)) throw new Error("project list JSON is not an array");
  return parsed.flatMap((value) => {
    const item = object(value); const id = string(item?.id); const worktree = string(item?.worktree);
    if (!item || !id || !worktree) return [];
    return [{ id, worktree, sandboxes: array(item.sandboxes).flatMap((sandbox) => typeof sandbox === "string" ? [sandbox] : []) }];
  });
}

export function parseSessionExport(stdout: string): { info: RecordValue; messages: Array<{ info: RecordValue; parts: RecordValue[] }> } {
  const parsed = object(parseCommandJson(stdout));
  const info = object(parsed?.info); const messages = array(parsed?.messages);
  if (!parsed || !info || !Array.isArray(parsed.messages)) throw new Error("export JSON does not contain info and messages");
  return { info, messages: messages.map((value) => object(value)).filter((value): value is RecordValue => Boolean(value)).map((message) => {
    const messageInfo = object(message.info); if (!messageInfo || !Array.isArray(message.parts)) throw new Error("export contains a malformed message");
    return { info: messageInfo, parts: message.parts.map((value) => object(value)).filter((value): value is RecordValue => Boolean(value)) };
  }) };
}

function executableNames(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["opencode.exe", "opencode-cli.exe", "opencode.cmd", "opencode.bat", "opencode"] : ["opencode"];
}

export async function resolveOpenCodeExecutable(options: Pick<OpenCodeExportDiscoveryOptions, "executable" | "platform" | "env"> = {}): Promise<string | undefined> {
  const platform = options.platform ?? process.platform; const env = options.env ?? process.env;
  const configured = options.executable;
  const candidates = configured ? [configured] : executableNames(platform).flatMap((name) => (env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory.replace(/^"|"$/g, ""), name)));
  for (const candidate of candidates) {
    if (!configured || isAbsolute(candidate) || candidate.includes("/") || candidate.includes("\\")) {
      try { await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK); return candidate; } catch { continue; }
    }
  }
  return configured && !isAbsolute(configured) ? configured : undefined;
}

async function terminate(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.killed) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", () => resolve()); killer.once("exit", () => resolve());
    });
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  }
}

export const runBoundedCommand: CommandRunner = (program, args, options) => new Promise((resolve, reject) => {
  const child = crossSpawn(program, [...args], { cwd: options.cwd, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = ""; let size = 0; let settled = false;
  const fail = (error: Error): void => { if (settled) return; settled = true; clearTimeout(timer); void terminate(child).finally(() => reject(error)); };
  const collect = (target: "stdout" | "stderr", chunk: Buffer): void => {
    size += chunk.byteLength;
    if (size > options.max_output_bytes) { fail(new Error(`OpenCode command output exceeded ${options.max_output_bytes} bytes`)); return; }
    if (target === "stdout") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
  };
  child.stdout?.on("data", (chunk: Buffer) => collect("stdout", chunk)); child.stderr?.on("data", (chunk: Buffer) => collect("stderr", chunk));
  child.once("error", (error) => fail(error));
  child.once("exit", (code, signal) => {
    if (settled) return; settled = true; clearTimeout(timer);
    if (code === 0) resolve({ stdout, stderr });
    else reject(new Error(`OpenCode command failed (${code ?? signal ?? "unknown"}): ${stderr.trim().slice(0, 500)}`));
  });
  const timer = setTimeout(() => fail(new Error(`OpenCode command timed out after ${options.timeout_ms} ms`)), options.timeout_ms);
  timer.unref();
});

/** Use a regular file for stdout to avoid OpenCode pipe-flush truncation. */
export const runBoundedCommandToFile: CommandRunner = async (program, args, options) => {
  const temporary = await mkdtemp(join(tmpdir(), "rivetplane-opencode-output-")); const outputPath = join(temporary, "stdout.json"); const output = await open(outputPath, "w");
  try {
    const stderr = await new Promise<string>((resolve, reject) => {
      const child = crossSpawn(program, [...args], { cwd: options.cwd, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", output.fd, "pipe"] });
      let errorOutput = ""; let errorSize = 0; let settled = false;
      const fail = (error: Error): void => { if (settled) return; settled = true; clearTimeout(timer); clearInterval(sizeTimer); void terminate(child).finally(() => reject(error)); };
      child.stderr?.on("data", (chunk: Buffer) => {
        errorSize += chunk.byteLength;
        if (errorSize > options.max_output_bytes) { fail(new Error(`OpenCode command stderr exceeded ${options.max_output_bytes} bytes`)); return; }
        errorOutput += chunk.toString("utf8");
      });
      child.once("error", (error) => fail(error));
      child.once("exit", (code, signal) => {
        if (settled) return; settled = true; clearTimeout(timer); clearInterval(sizeTimer);
        if (code === 0) resolve(errorOutput); else reject(new Error(`OpenCode command failed (${code ?? signal ?? "unknown"}): ${errorOutput.trim().slice(0, 500)}`));
      });
      const timer = setTimeout(() => fail(new Error(`OpenCode command timed out after ${options.timeout_ms} ms`)), options.timeout_ms); timer.unref();
      const sizeTimer = setInterval(() => void stat(outputPath).then((value) => { if (value.size > options.max_output_bytes) fail(new Error(`OpenCode command output exceeded ${options.max_output_bytes} bytes`)); }).catch(() => undefined), 100); sizeTimer.unref();
    });
    await output.close(); const size = (await stat(outputPath)).size;
    if (size > options.max_output_bytes) throw new Error(`OpenCode command output exceeded ${options.max_output_bytes} bytes`);
    return { stdout: await readFile(outputPath, "utf8"), stderr };
  } finally { await output.close().catch(() => undefined); await rm(temporary, { recursive: true, force: true }); }
};

function shellListCommand(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, cwd: string, timeout_ms: number, max_output_bytes: number, max_sessions: number, runner: CommandRunner): Promise<CommandResult> {
  // The command contains fixed tokens and a validated integer. No session ID enters it.
  const command = `opencode session list --format json --max-count ${max_sessions}`;
  if (platform === "win32") return runner(env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], { cwd, timeout_ms, max_output_bytes });
  return runner(env.SHELL ?? "/bin/sh", ["-lc", command], { cwd, timeout_ms, max_output_bytes });
}

function questionFromPart(sessionId: string, part: RecordValue): Question | undefined {
  if (part.tool !== "question") return undefined;
  const state = object(part.state); if (state?.status !== "running" && state?.status !== "pending") return undefined;
  const questions = array(object(state.input)?.questions).flatMap((value) => {
    const item = object(value); const prompt = string(item?.question); const header = string(item?.header);
    if (!item || !prompt || !header) return [];
    const options = array(item.options).flatMap((entry) => { const option = object(entry); const label = string(option?.label); return label ? [{ label, description: string(option?.description) }] : []; });
    return [{ prompt, header, options, multiple: item.multiple === true, custom: item.custom === true }];
  });
  if (questions.length === 0) return undefined;
  const callID = string(part.callID) ?? string(part.id) ?? stableId(sessionId, "question");
  return { type: "question", id: callID, session_id: sessionId, prompt: questions.map((item) => item.prompt).join("\n"), header: questions.map((item) => item.header).join(" / "),
    options: questions.flatMap((item) => item.options.map((option) => option.label)), option_details: questions.flatMap((item) => item.options), questions,
    tool_call_id: callID, read_only: true, requested_at: timestamp(object(state.time)?.start) };
}

function approvalFromPart(sessionId: string, part: RecordValue): PendingInteraction | undefined {
  const state = object(part.state); if (!state || (state.status !== "running" && state.status !== "pending")) return undefined;
  const explicit = object(state.permission) ?? object(object(state.metadata)?.permission);
  const tool = string(part.tool) ?? "permission";
  if (!explicit && !["permission", "approval", "request_permission"].includes(tool)) return undefined;
  if (explicit && explicit.status !== undefined && explicit.status !== "running" && explicit.status !== "pending") return undefined;
  const input = explicit ?? object(state.input) ?? {};
  const id = string(explicit?.id) ?? string(explicit?.requestID) ?? string(part.callID) ?? string(part.id);
  if (!id) return undefined;
  return { type: "approval", id, session_id: sessionId, tool_name: string(explicit?.permission) ?? string(explicit?.tool) ?? tool,
    tool_input_summary: summary(input), requested_at: timestamp(object(explicit?.time)?.created ?? object(state.time)?.start), read_only: true };
}

function detectPending(sessionId: string, messages: Array<{ info: RecordValue; parts: RecordValue[] }>): PendingInteraction | undefined {
  let pending: PendingInteraction | undefined;
  for (const message of messages) for (const part of message.parts) pending = questionFromPart(sessionId, part) ?? approvalFromPart(sessionId, part) ?? pending;
  return pending;
}

function terminalToolRequests(messages: Array<{ info: RecordValue; parts: RecordValue[] }>): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) for (const part of message.parts) {
    const state = object(part.state); const status = string(state?.status);
    if (!["completed", "error", "rejected"].includes(status ?? "")) continue;
    const explicit = object(state?.permission) ?? object(object(state?.metadata)?.permission);
    const id = string(explicit?.id) ?? string(explicit?.requestID) ?? string(part.callID) ?? string(part.id); if (id) ids.add(id);
  }
  return ids;
}

function latestIdentity(messages: Array<{ info: RecordValue; parts: RecordValue[] }>): { model?: { provider_id: string; model_id: string }; agent?: string } {
  for (const message of [...messages].reverse()) {
    const model = object(message.info.model); const provider = string(model?.providerID ?? message.info.providerID); const id = string(model?.modelID ?? model?.id ?? message.info.modelID);
    const agent = string(message.info.agent ?? message.info.mode);
    if (provider && id) return { model: { provider_id: provider, model_id: id }, agent };
    if (agent) return { agent };
  }
  return {};
}

function statusFromExport(info: RecordValue, messages: Array<{ info: RecordValue; parts: RecordValue[] }>, pending: PendingInteraction | undefined): SessionStatus {
  if (pending?.type === "question") return "waiting_input";
  if (pending?.type === "approval") return "waiting_approval";
  if (object(info.time)?.archived || info.archived === true) return "completed";
  const latest = messages.at(-1); if (!latest) return "waiting_input";
  if (latest.info.error) return "error";
  if (latest.info.role === "user") return "running";
  if (object(latest.info.time)?.completed || object(latest.info.time)?.finished) return "waiting_input";
  if (latest.parts.some((part) => ["running", "pending"].includes(String(object(part.state)?.status)))) return "running";
  return "waiting_input";
}

export class OpenCodeExportDiscovery {
  readonly directory: string;
  readonly checkpoint_path: string;
  #executable: string | undefined;
  #timer: NodeJS.Timeout | undefined;
  #polling = false;
  #loaded = false;
  #checkpoints: CheckpointFile = { version: 1, sessions: {} };
  #present = new Set<string>();
  #index = new Map<string, OpenCodeListSession>();
  #probeIds = new Set<string>();
  #seenRuntime = new Set<string>();
  #diagnostics = new Set<string>();
  #nextIndexRefreshAt = 0;
  #indexFailures = 0;
  #lastCandidateDiagnostic = "";

  constructor(readonly machine_id: string, readonly registry: SessionRegistry, private readonly options: OpenCodeExportDiscoveryOptions = {}) {
    this.directory = options.directory ?? process.cwd();
    this.checkpoint_path = options.checkpoint_path ?? join(homedir(), ".config", "harness-cp", "opencode-export-checkpoints.json");
  }

  async start(): Promise<void> {
    await this.poll(); this.#timer = setInterval(() => void this.poll(), this.options.interval_ms ?? 2_000); this.#timer.unref();
  }
  stop(): void { if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; }
  target(id: string): CommandTarget | undefined { return this.#present.has(id) ? new ReadOnlyOpenCodeTarget() : undefined; }
  harnesses(): HarnessDiscoveryStatus[] { return this.#executable ? [{ harness_type: "opencode", discovered_sessions: this.#present.size, attached_sessions: this.#present.size }] : []; }
  get executable(): string | undefined { return this.#executable; }

  async poll(): Promise<void> {
    if (this.#polling) return; this.#polling = true;
    try {
      await this.#load();
      this.#executable ??= await resolveOpenCodeExecutable(this.options);
      if (!this.#executable) { this.#diagnostic("OpenCode executable was not found; export discovery is inactive"); return; }
      const command = this.options.runner ?? runBoundedCommand; const common = this.#commandOptions();
      if (this.#now() >= this.#nextIndexRefreshAt) await this.#refreshIndex(command, common);
      const indexed = [...this.#index.values()].sort((a, b) => this.#updated(b) - this.#updated(a));
      const recentAfter = this.#now() - (this.options.recent_window_ms ?? 5 * 60_000);
      const eligible = indexed.filter((session) => {
        const current = this.registry.get(session.id); const pending = current?.pending ?? this.#checkpoints.sessions[session.id]?.pending;
        const probeChanged = this.#probeIds.has(session.id) && !this.#seenRuntime.has(session.id) && this.#checkpoints.sessions[session.id]?.updated !== session.updated;
        return Boolean(pending) || current?.status === "running" || this.#updated(session) >= recentAfter || probeChanged;
      });
      const candidateLimit = this.#positiveLimit(this.options.max_export_candidates, 48);
      const priority = (session: OpenCodeListSession): number => {
        const current = this.registry.get(session.id);
        if (current?.pending ?? this.#checkpoints.sessions[session.id]?.pending) return 3;
        if (current?.status === "running") return 2;
        if (!this.#seenRuntime.has(session.id) || this.#checkpoints.sessions[session.id]?.updated !== session.updated) return 1;
        return 0;
      };
      const candidates = eligible.sort((a, b) => priority(b) - priority(a) || this.#updated(b) - this.#updated(a)).slice(0, candidateLimit);
      const exports = candidates.slice(0, this.#positiveLimit(this.options.max_exports_per_poll, 12, true));
      const candidateDiagnostic = `OpenCode export poll has ${eligible.length} active, recent, or probe candidates from ${indexed.length} indexed sessions; selected ${candidates.length} and exporting ${exports.length}`;
      if (candidateDiagnostic !== this.#lastCandidateDiagnostic) { this.#lastCandidateDiagnostic = candidateDiagnostic; this.registry.emit("log", candidateDiagnostic); }
      await this.#mapLimit(exports, this.options.concurrency ?? 4, async (session) => this.#export(session, command, common));
      if (exports.length > 0) await this.#save();
    } catch (error) { this.#diagnostic(`OpenCode export discovery failed: ${error instanceof Error ? error.message : String(error)}`, true); }
    finally { this.#polling = false; }
  }

  #commandOptions(): { cwd: string; timeout_ms: number; max_output_bytes: number } {
    return { cwd: this.directory, timeout_ms: this.options.timeout_ms ?? 10_000, max_output_bytes: this.options.max_output_bytes ?? 16 * 1024 * 1024 };
  }
  #now(): number { return this.options.now?.() ?? Date.now(); }
  #positiveLimit(value: number | undefined, fallback: number, allowZero = false): number {
    if (Number.isSafeInteger(value) && (allowZero ? value! >= 0 : value! > 0)) return value!;
    return fallback;
  }
  #indexInterval(): number { return this.#positiveLimit(this.options.index_interval_ms, 60_000, true); }
  async #refreshIndex(command: CommandRunner, common: { cwd: string; timeout_ms: number; max_output_bytes: number }): Promise<void> {
    const started = this.#now(); const scopes = await this.#projectScopes(command, common);
    const listedResult = await this.#listAllScopes(scopes.directories, command, common);
    let listed = listedResult.sessions; let databaseAuthoritative = false;
    if (scopes.requiresIndex || !scopes.complete || !listedResult.authoritative || listedResult.saturated) {
      try {
        listed = this.#mergeSessions(listed, await this.#listDatabasePages(common)); databaseAuthoritative = true;
        this.#diagnostic(`OpenCode used the bounded database-index fallback and found ${listed.length} unique root sessions`);
      } catch (error) {
        this.#diagnostic(`OpenCode database-index fallback failed; discovery coverage is partial: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
    listed.sort((a, b) => this.#updated(b) - this.#updated(a));
    const authoritative = databaseAuthoritative || (scopes.complete && listedResult.authoritative && !listedResult.saturated);
    const next = authoritative ? new Map<string, OpenCodeListSession>() : new Map(this.#index);
    for (const session of listed) next.set(session.id, session);
    if (authoritative) for (const id of this.#present) if (!next.has(id)) this.registry.remove(id);
    this.#index = next; this.#present = new Set(next.keys());
    this.#probeIds = new Set([...next.values()].sort((a, b) => this.#updated(b) - this.#updated(a)).slice(0, this.#positiveLimit(this.options.max_export_candidates, 48)).map((session) => session.id));
    for (const session of listed) this.#upsertListSnapshot(session);

    const duration = Math.max(0, this.#now() - started); const base = this.#indexInterval();
    const maximum = this.#positiveLimit(this.options.max_index_interval_ms, 5 * 60_000);
    this.#indexFailures = authoritative ? 0 : Math.min(this.#indexFailures + 1, 6);
    const slowDelay = base === 0 ? 0 : Math.min(maximum, Math.max(base, duration * 4));
    const failureDelay = Math.min(maximum, base * 2 ** this.#indexFailures);
    const delay = Math.max(slowDelay, failureDelay); this.#nextIndexRefreshAt = this.#now() + delay;
    this.registry.emit("log", `OpenCode index refresh ${authoritative ? "completed" : "was partial"} in ${duration} ms with ${this.#index.size} cached sessions; next refresh in ${delay} ms`);
    if (!authoritative) this.registry.emit("warning", new Error(`OpenCode index refresh backoff is ${delay} ms after ${this.#indexFailures} consecutive partial refresh${this.#indexFailures === 1 ? "" : "es"}`));
    else if (delay > base) this.registry.emit("log", `OpenCode index refresh used a ${delay} ms slow-scan backoff`);
  }
  async #projectScopes(command: CommandRunner, common: { cwd: string; timeout_ms: number; max_output_bytes: number }): Promise<{ directories: string[]; complete: boolean; requiresIndex: boolean }> {
    const scopes = new Set([this.directory]); let complete = true; let requiresIndex = false;
    try {
      const result = await command(this.#executable!, [...(this.options.executable_args ?? []), "debug", "scrap"], common);
      let missing = 0; const directoryProjects = new Map<string, string>();
      for (const project of parseProjectList(result.stdout)) {
        const candidates = [project.worktree, ...project.sandboxes]; let selected: string | undefined;
        for (const candidate of candidates) {
          try { await access(candidate, constants.F_OK); scopes.add(candidate); selected = candidate; break; } catch { /* try the next known directory */ }
        }
        if (!selected) { missing++; complete = false; requiresIndex = true; continue; }
        const prior = directoryProjects.get(selected);
        if (prior && prior !== project.id) { requiresIndex = true; this.#diagnostic(`OpenCode project records ${prior} and ${project.id} share ${selected}; the directory scope is scanned once and the database index completes project identity coverage`); }
        else directoryProjects.set(selected, project.id);
      }
      if (missing > 0) this.#diagnostic(`OpenCode project discovery skipped ${missing} project${missing === 1 ? "" : "s"} with no accessible worktree or sandbox; the database-index fallback was requested`, true);
      this.#diagnostic(`OpenCode project discovery found ${scopes.size} directory scope${scopes.size === 1 ? "" : "s"}`);
    } catch (error) {
      complete = false; requiresIndex = true;
      this.#diagnostic(`OpenCode project discovery is unavailable; scanning seed directory ${this.directory} and requesting the database-index fallback: ${error instanceof Error ? error.message : String(error)}`, true);
    }
    return { directories: [...scopes], complete, requiresIndex };
  }
  async #listAllScopes(scopes: string[], command: CommandRunner, common: { cwd: string; timeout_ms: number; max_output_bytes: number }): Promise<{ sessions: OpenCodeListSession[]; authoritative: boolean; saturated: boolean }> {
    const combined = new Map<string, OpenCodeListSession>(); let failures = 0; let duplicates = 0; let saturated = false;
    await this.#mapLimit(scopes, this.options.concurrency ?? 4, async (directory) => {
      try {
        const sessions = await this.#listScope(directory, command, common);
        if (sessions.length >= this.#scopeLimit()) saturated = true;
        for (const session of sessions) {
          const prior = combined.get(session.id); if (prior) duplicates++;
          if (!prior || this.#updated(session) > this.#updated(prior)) combined.set(session.id, session);
        }
      } catch (error) {
        failures++; this.registry.emit("warning", new Error(`Cannot list OpenCode sessions for ${directory}: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    if (duplicates > 0) this.#diagnostic(`OpenCode project discovery removed ${duplicates} duplicate session result${duplicates === 1 ? "" : "s"}`);
    if (failures === 0) this.#diagnostic(`OpenCode machine discovery covered ${scopes.length} project scope${scopes.length === 1 ? "" : "s"} and found ${combined.size} unique session${combined.size === 1 ? "" : "s"}`);
    else this.#diagnostic(`OpenCode machine discovery completed with ${failures} failed project scope${failures === 1 ? "" : "s"}; the database-index fallback was requested`, true);
    return { sessions: [...combined.values()], authoritative: failures === 0, saturated };
  }
  async #listScope(directory: string, command: CommandRunner, common: { cwd: string; timeout_ms: number; max_output_bytes: number }): Promise<OpenCodeListSession[]> {
    const max = this.#scopeLimit();
    let result = await command(this.#executable!, [...(this.options.executable_args ?? []), "session", "list", "--format", "json", "--max-count", String(max)], { ...common, cwd: directory });
    if (!result.stdout.trim()) {
      this.#diagnostic("OpenCode session list returned empty stdout; retrying once through the platform shell");
      try { result = await shellListCommand(this.options.platform ?? process.platform, this.options.env ?? process.env, directory, common.timeout_ms, common.max_output_bytes, max, command); }
      catch (error) { this.registry.emit("warning", new Error(`OpenCode shell retry failed for ${directory}: ${error instanceof Error ? error.message : String(error)}`)); }
    }
    let sessions: OpenCodeListSession[];
    try {
      if (!result.stdout.trim()) throw new Error("command returned empty stdout");
      sessions = parseSessionList(result.stdout);
    } catch (error) {
      this.#diagnostic(`OpenCode session list output was empty, malformed, or truncated in ${directory}; retrying with file-backed stdout: ${error instanceof Error ? error.message : String(error)}`);
      const fileCommand = this.options.file_runner ?? (this.options.runner ? command : runBoundedCommandToFile);
      const fileResult = await fileCommand(this.#executable!, [...(this.options.executable_args ?? []), "session", "list", "--format", "json", "--max-count", String(max)], { ...common, cwd: directory });
      if (!fileResult.stdout.trim()) { this.#diagnostic("OpenCode session list returned empty stdout after all retries; treating the successful empty result as no sessions"); sessions = []; }
      else sessions = parseSessionList(fileResult.stdout);
    }
    if (sessions.length >= max) this.#diagnostic(`OpenCode session list reached the explicit limit of ${max} in ${directory}; bounded database-index pagination will complete coverage`);
    return sessions;
  }
  #scopeLimit(): number {
    const value = this.options.max_sessions_per_project ?? 200;
    return Number.isSafeInteger(value) && value > 0 ? value : 200;
  }
  async #listDatabasePages(common: { cwd: string; timeout_ms: number; max_output_bytes: number }): Promise<OpenCodeListSession[]> {
    const pageSize = Number.isSafeInteger(this.options.database_page_size) && (this.options.database_page_size ?? 0) > 0 ? this.options.database_page_size! : 1_000;
    const maxPages = Number.isSafeInteger(this.options.max_database_pages) && (this.options.max_database_pages ?? 0) > 0 ? this.options.max_database_pages! : 100;
    const command = this.options.file_runner ?? (this.options.runner ? this.options.runner : runBoundedCommandToFile); const sessions: OpenCodeListSession[] = [];
    for (let page = 0; page < maxPages; page++) {
      const offset = page * pageSize;
      const query = `SELECT id, title, time_updated AS updated, time_created AS created, project_id AS projectId, directory FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC, id DESC LIMIT ${pageSize} OFFSET ${offset}`;
      const result = await command(this.#executable!, [...(this.options.executable_args ?? []), "db", query, "--format", "json"], common);
      const values = parseSessionList(result.stdout); sessions.push(...values);
      if (values.length < pageSize) return this.#mergeSessions([], sessions);
    }
    throw new Error(`database session index exceeded ${maxPages} pages of ${pageSize}`);
  }
  #mergeSessions(left: OpenCodeListSession[], right: OpenCodeListSession[]): OpenCodeListSession[] {
    const combined = new Map<string, OpenCodeListSession>();
    for (const session of [...left, ...right]) {
      const prior = combined.get(session.id); if (!prior || this.#updated(session) > this.#updated(prior)) combined.set(session.id, session);
    }
    return [...combined.values()];
  }
  #updated(session: OpenCodeListSession): number { return typeof session.updated === "number" ? session.updated : Date.parse(session.updated ?? "") || 0; }
  #upsertListSnapshot(listed: OpenCodeListSession): void {
    const current = this.registry.get(listed.id); const pending = current?.pending ?? this.#checkpoints.sessions[listed.id]?.pending ?? null;
    this.registry.upsert({ id: listed.id, machine_id: this.machine_id, harness_type: "opencode", cwd: listed.directory ?? current?.cwd ?? "",
      status: pending?.type === "question" ? "waiting_input" : pending?.type === "approval" ? "waiting_approval" : current?.status ?? "waiting_input",
      created_at: timestamp(listed.created ?? current?.created_at), last_activity_at: timestamp(listed.updated ?? current?.last_activity_at ?? listed.created), pending, title: listed.title ?? current?.title, read_only: true });
  }
  async #export(listed: OpenCodeListSession, command: CommandRunner, common: { cwd: string; timeout_ms: number; max_output_bytes: number }): Promise<void> {
    try {
      const fileCommand = this.options.file_runner ?? (this.options.runner ? command : runBoundedCommandToFile);
      const output = await fileCommand(this.#executable!, [...(this.options.executable_args ?? []), "export", listed.id], common);
      const exported = parseSessionExport(output.stdout); this.#syncExport(listed, exported.info, exported.messages); this.#seenRuntime.add(listed.id);
    } catch (error) { this.registry.emit("warning", new Error(`Cannot export OpenCode session ${listed.id}: ${error instanceof Error ? error.message : String(error)}`)); }
  }
  #syncExport(listed: OpenCodeListSession, info: RecordValue, messages: Array<{ info: RecordValue; parts: RecordValue[] }>): void {
    const id = string(info.id) ?? listed.id; if (id !== listed.id) throw new Error(`export session ID ${id} does not match ${listed.id}`);
    const checkpoint = this.#checkpoints.sessions[id] ?? { parts: {} }; const foundPending = detectPending(id, messages); const terminal = terminalToolRequests(messages);
    const exportUpdated = listed.updated ?? number(object(info.time)?.updated) ?? string(object(info.time)?.updated);
    const currentEpoch = epoch(exportUpdated); const priorEpoch = epoch(checkpoint.updated);
    const newer = checkpoint.updated === undefined || (currentEpoch !== undefined && priorEpoch !== undefined ? currentEpoch > priorEpoch : exportUpdated !== undefined && exportUpdated !== checkpoint.updated);
    const pending = foundPending ?? (checkpoint.pending && !terminal.has(checkpoint.pending.id) && !newer ? checkpoint.pending : undefined); const identity = latestIdentity(messages);
    const current = this.registry.get(id); const time = object(info.time);
    this.registry.upsert({ id, machine_id: this.machine_id, harness_type: "opencode", cwd: string(info.directory) ?? listed.directory ?? current?.cwd ?? "",
      status: current?.status ?? "waiting_input", created_at: timestamp(time?.created ?? listed.created), last_activity_at: timestamp(time?.updated ?? listed.updated ?? time?.created),
      pending: current?.pending ?? null, title: string(info.title) ?? listed.title, ...identity, read_only: true,
      metadata: { project_id: String(info.projectID ?? listed.projectId ?? ""), slug: String(info.slug ?? ""), version: String(info.version ?? "") } });
    for (const message of messages) this.#syncMessage(id, message.info, message.parts, checkpoint);
    if (pending?.type === "approval" && checkpoint.pending?.id !== pending.id) this.registry.append(id, "permission_request", {
      approval_id: pending.id, tool_name: pending.tool_name, tool_input_summary: pending.tool_input_summary,
    }, { id: stableId(id, pending.id, "permission_request"), ts: pending.requested_at });
    this.registry.setPending(id, pending ?? null); this.registry.setStatus(id, statusFromExport(info, messages, pending));
    checkpoint.updated = exportUpdated; checkpoint.pending = pending;
    this.#checkpoints.sessions[id] = checkpoint;
  }
  #syncMessage(sessionId: string, info: RecordValue, parts: RecordValue[], checkpoint: SessionCheckpoint): void {
    const messageId = string(info.id) ?? stableId(sessionId, "message", JSON.stringify(info)); const role = info.role === "user" ? "user" : "assistant";
    const messageTs = timestamp(object(info.time)?.created);
    for (const part of parts) {
      const partId = string(part.id) ?? stableId(messageId, JSON.stringify(part)); const key = `${messageId}/${partId}`; const prior = checkpoint.parts[key];
      if (part.type === "text" && typeof part.text === "string") {
        const full = part.text; let emitted = full;
        if (prior?.length !== undefined && prior.length <= full.length && hash(full.slice(0, prior.length)) === prior.hash) emitted = full.slice(prior.length);
        else if (prior?.hash === hash(full)) emitted = "";
        if (emitted) this.registry.append(sessionId, role === "user" ? "user_message" : "agent_message", { text: emitted },
          { id: stableId(sessionId, messageId, partId, "text", String(full.length), hash(full)), ts: messageTs });
        checkpoint.parts[key] = { hash: hash(full), length: full.length };
      } else if (part.type === "tool") this.#syncTool(sessionId, messageId, partId, part, prior, checkpoint, key, messageTs);
    }
  }
  #syncTool(sessionId: string, messageId: string, partId: string, part: RecordValue, prior: PartCheckpoint | undefined, checkpoint: SessionCheckpoint, key: string, fallbackTs: string): void {
    const state = object(part.state) ?? {}; const status = string(state.status) ?? "unknown"; const callID = string(part.callID) ?? partId; const tool = string(part.tool) ?? "tool";
    const input = state.input; const signature = hash(JSON.stringify({ tool, status, input, output: state.output, error: state.error }));
    if (!prior) this.registry.append(sessionId, "tool_call", { tool_call_id: callID, tool_name: tool, input_summary: summary(input), ...(jsonValue(input) !== undefined ? { input: jsonValue(input) } : {}) },
      { id: stableId(sessionId, messageId, partId, "call"), ts: timestamp(object(state.time)?.start, Date.parse(fallbackTs)) });
    if (prior?.status !== status && ["completed", "error", "rejected"].includes(status)) {
      const failed = status !== "completed"; const output = failed ? state.error ?? state.output ?? status : state.output;
      this.registry.append(sessionId, "tool_result", { tool_call_id: callID, output_summary: summary(output), ...(jsonValue(output) !== undefined ? { output: jsonValue(output) } : {}), is_error: failed },
        { id: stableId(sessionId, messageId, partId, "result", status), ts: timestamp(object(state.time)?.end, Date.parse(fallbackTs)) });
    }
    checkpoint.parts[key] = { hash: signature, status };
  }
  async #mapLimit<T>(values: T[], limit: number, operation: (value: T) => Promise<void>): Promise<void> {
    let offset = 0; const workers = Array.from({ length: Math.max(1, Math.min(limit, values.length)) }, async () => {
      while (offset < values.length) { const value = values[offset++]!; await operation(value); }
    }); await Promise.all(workers);
  }
  async #load(): Promise<void> {
    if (this.#loaded) return; this.#loaded = true;
    try {
      const value = JSON.parse(await readFile(this.checkpoint_path, "utf8")) as CheckpointFile;
      if (value.version === 1 && object(value.sessions)) this.#checkpoints = value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.registry.emit("warning", new Error("OpenCode checkpoint is malformed; discovery will rebuild it")); }
  }
  async #save(): Promise<void> {
    const ordered = Object.entries(this.#checkpoints.sessions).sort(([, a], [, b]) => (epoch(b.updated) ?? 0) - (epoch(a.updated) ?? 0));
    if (this.options.max_sessions !== undefined) ordered.splice(this.options.max_sessions);
    this.#checkpoints.sessions = Object.fromEntries(ordered);
    await mkdir(dirname(this.checkpoint_path), { recursive: true, mode: 0o700 }); const temporary = `${this.checkpoint_path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#checkpoints)}\n`, { mode: 0o600 }); await rename(temporary, this.checkpoint_path);
  }
  #diagnostic(message: string, warning = false): void {
    if (this.#diagnostics.has(message)) return; this.#diagnostics.add(message); this.registry.emit(warning ? "warning" : "log", warning ? new Error(message) : message);
  }
}

class ReadOnlyOpenCodeTarget implements CommandTarget {
  #error(): never { throw new Error("This OpenCode session was discovered by export and is read-only. Rivetplane can show live pending questions, but it cannot resolve the Deferred in the original OpenCode process."); }
  async sendMessage(_text: string): Promise<void> { this.#error(); }
  async respondToPending(_id: string, _response: string): Promise<void> { this.#error(); }
  async interrupt(): Promise<void> { this.#error(); }
}
