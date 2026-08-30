import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { JsonValue, PendingInteraction, Question, SessionStatus } from "@rivetplane/shared/model";
import type { HarnessCapabilities } from "@rivetplane/shared/protocol";
import type { CommandTarget } from "./relay.js";
import { SessionRegistry } from "./registry.js";
import type { HarnessDiscoveryStatus } from "./session-manager.js";
import { runBoundedCommand, type CommandRunner } from "./opencode-export-discovery.js";
import type { RawUsageSample, UsageCollector } from "./usage.js";
import type { UsageQuotaWindow } from "@rivetplane/shared/model";

type RecordValue = Record<string, unknown>;

export interface ClaudeAgent {
  sessionId: string;
  pid?: number;
  id?: string;
  name?: string;
  cwd: string;
  kind: "interactive" | "background" | string;
  startedAt?: number | string;
  status?: string;
  waitingFor?: string;
  state?: string;
}

interface OpenTool {
  id: string;
  name: string;
  input?: JsonValue;
  requested_at: string;
}
interface TailCheckpoint {
  path?: string;
  offset: number;
  identity?: string;
  remainder?: string;
  skipping_line?: boolean;
  recent_ids: string[];
  open_tools: Record<string, OpenTool>;
}
interface CheckpointFile { version: 1; sessions: Record<string, TailCheckpoint> }

export interface ClaudeCodeDiscoveryOptions {
  executable?: string;
  executable_args?: string[];
  directory?: string;
  config_dir?: string;
  checkpoint_path?: string;
  interval_ms?: number;
  timeout_ms?: number;
  max_output_bytes?: number;
  max_transcript_bytes_per_poll?: number;
  max_line_bytes?: number;
  max_lines_per_poll?: number;
  max_project_directories?: number;
  max_recent_ids?: number;
  max_sessions?: number;
  concurrency?: number;
  retry_base_ms?: number;
  max_retry_ms?: number;
  question_grace_ms?: number;
  now?: () => number;
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  usage?: UsageCollector;
}

function tokenTotal(...values: Array<number | undefined>): number | undefined {
  return values.some((value) => value !== undefined) ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : undefined;
}

export function claudeMessageUsage(sessionId: string, recordId: string, record: RecordValue, ts: string): RawUsageSample | undefined {
  const message = object(record.message); const usage = object(message?.usage); if (!usage) return undefined;
  const input = number(usage.input_tokens ?? usage.inputTokens); const output = number(usage.output_tokens ?? usage.outputTokens);
  const cacheRead = number(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens); const cacheWrite = number(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens);
  const total = tokenTotal(input, output, cacheRead, cacheWrite); const model = string(message?.model); const cost = number(record.costUSD ?? record.cost_usd);
  return { session_id: sessionId, timestamp: ts, harness: "claude-code", provider: "anthropic", ...(model ? { model } : {}), source: "claude-code:session-jsonl", source_event_id: recordId,
    source_counter_mode: "incremental", tokens: { input, output, cache_read: cacheRead, cache_write: cacheWrite, total }, cost: cost !== undefined ? { status: "estimated", amount: cost, currency: "USD" } : { status: "unavailable" } };
}

export function claudeStatusUsage(sessionId: string, state: RecordValue, model?: string): RawUsageSample | undefined {
  const context = object(state.context_window ?? state.contextWindow); const current = object(context?.current_usage ?? context?.currentUsage);
  const window = number(context?.context_window_size ?? context?.contextWindowSize); const used = current ? tokenTotal(number(current.input_tokens ?? current.inputTokens), number(current.output_tokens ?? current.outputTokens), number(current.cache_read_input_tokens ?? current.cacheReadInputTokens), number(current.cache_creation_input_tokens ?? current.cacheCreationInputTokens)) : undefined;
  const costRoot = object(state.cost); const amount = number(costRoot?.total_cost_usd ?? costRoot?.totalCostUsd ?? state.total_cost_usd);
  const limits = object(state.rate_limits ?? state.rateLimits); const quota: UsageQuotaWindow[] = [];
  if (limits) for (const [name, raw] of Object.entries(limits)) { const item = object(raw); if (!item) continue; const percent = number(item.used_percentage ?? item.usedPercent); const reset = string(item.resets_at ?? item.resetsAt); quota.push({ name, ...(percent !== undefined ? { used_percent: percent } : {}), ...(reset ? { resets_at: timestamp(reset) } : {}) }); }
  if (window === undefined && amount === undefined && quota.length === 0) return undefined;
  return { session_id: sessionId, harness: "claude-code", provider: "anthropic", ...(model ? { model } : {}), source: "claude-code:status-session", source_counter_mode: "cumulative", counter_key: `claude:session:${sessionId}`, tokens: {},
    ...(window !== undefined ? { context: { window_size: window, ...(used !== undefined ? { used_tokens: used } : {}) } } : {}), cost: amount !== undefined ? { status: "estimated", amount, currency: "USD" } : { status: "unavailable" }, ...(quota.length ? { quota } : {}) };
}

function object(value: unknown): RecordValue | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function timestamp(value: unknown, fallback = Date.now()): string {
  if (typeof value === "string") { const parsed = Date.parse(value); if (Number.isFinite(parsed)) return new Date(parsed).toISOString(); }
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value < 10_000_000_000 ? value * 1_000 : value).toISOString();
  return new Date(fallback).toISOString();
}
function latestTimestamp(...values: Array<string | undefined>): string {
  return values.filter((value): value is string => Boolean(value)).sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? new Date().toISOString();
}
function hash(value: string): string { return createHash("sha256").update(value).digest("base64url").slice(0, 22); }
function stableId(...parts: string[]): string { return `claude-jsonl:${hash(parts.join("\0"))}`; }
function jsonValue(value: unknown): JsonValue | undefined { try { return JSON.parse(JSON.stringify(value)) as JsonValue; } catch { return undefined; } }
function summary(value: unknown, limit = 500): string { const text = typeof value === "string" ? value : JSON.stringify(value) ?? ""; return text.length > limit ? `${text.slice(0, limit)}…` : text; }
function agentTime(agent: ClaudeAgent): number {
  if (typeof agent.startedAt === "number") return agent.startedAt < 10_000_000_000 ? agent.startedAt * 1_000 : agent.startedAt;
  return typeof agent.startedAt === "string" ? Date.parse(agent.startedAt) || 0 : 0;
}
async function mapLimit<T>(values: readonly T[], concurrency: number, operation: (value: T) => Promise<void>): Promise<void> {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (index < values.length) { const value = values[index++]; if (value !== undefined) await operation(value); }
  }));
}

export function parseClaudeAgents(stdout: string): ClaudeAgent[] {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout.trim()) as unknown; } catch { throw new Error("claude agents --json returned malformed or partial JSON"); }
  if (!Array.isArray(parsed)) throw new Error("claude agents --json did not return an array");
  return parsed.flatMap((value) => {
    const item = object(value); const sessionId = string(item?.sessionId); const cwd = string(item?.cwd); const kind = string(item?.kind);
    if (!item || !sessionId || !cwd || !kind) return [];
    return [{ sessionId, cwd, kind, pid: number(item.pid), id: string(item.id), name: string(item.name), startedAt: number(item.startedAt) ?? string(item.startedAt), status: string(item.status), waitingFor: string(item.waitingFor), state: string(item.state) }];
  });
}

function executableNames(platform: NodeJS.Platform): string[] { return platform === "win32" ? ["claude.exe", "claude.cmd", "claude.bat", "claude"] : ["claude"]; }
export async function resolveClaudeExecutable(options: Pick<ClaudeCodeDiscoveryOptions, "executable" | "platform" | "env"> = {}): Promise<string | undefined> {
  const platform = options.platform ?? process.platform; const env = options.env ?? process.env;
  const candidates = options.executable ? [options.executable] : executableNames(platform).flatMap((name) => (env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory.replace(/^"|"$/g, ""), name)));
  for (const candidate of candidates) {
    if (!options.executable || isAbsolute(candidate) || candidate.includes("/") || candidate.includes("\\")) {
      try { await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK); return candidate; } catch { continue; }
    }
  }
  return options.executable && !isAbsolute(options.executable) ? options.executable : undefined;
}

function statusFromAgent(agent: ClaudeAgent): SessionStatus {
  const wait = (agent.waitingFor ?? "").toLowerCase(); const state = (agent.state ?? agent.status ?? "").toLowerCase();
  if (wait.includes("permission")) return "waiting_approval";
  if (wait.includes("input") || state === "blocked" || state === "waiting" || state === "idle") return "waiting_input";
  if (["failed", "error", "crashed"].includes(state)) return "error";
  if (["completed", "done", "stopped"].includes(state)) return "completed";
  return "running";
}

function contentBlocks(record: RecordValue): RecordValue[] {
  const message = object(record.message); const content = message?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return array(content).flatMap((value) => object(value) ? [object(value)!] : []);
}

function questionFromTool(sessionId: string, tool: OpenTool, state: RecordValue | undefined): Question | undefined {
  if (tool.name !== "AskUserQuestion") return undefined;
  const questions = array(object(tool.input)?.questions).flatMap((value) => {
    const item = object(value); const prompt = string(item?.question); if (!item || !prompt) return [];
    const options = array(item.options).flatMap((entry) => { const option = object(entry); const label = string(option?.label); return label ? [{ label, description: string(option?.description) }] : []; });
    return [{ prompt, header: string(item.header) ?? "Question", options, multiple: item.multiSelect === true, custom: true }];
  });
  const stateQuestions = array(object(state?.block)?.questions);
  if (questions.length === 0 || stateQuestions.length === 0) return undefined;
  const prompts = new Set(stateQuestions.flatMap((value) => string(object(value)?.question) ? [string(object(value)?.question)!] : []));
  if (!questions.every((question) => prompts.has(question.prompt))) return undefined;
  return { type: "question", id: tool.id, session_id: sessionId, prompt: questions.map((item) => item.prompt).join("\n"), header: questions.map((item) => item.header).join(" / "), options: questions.flatMap((item) => item.options.map((option) => option.label)), option_details: questions.flatMap((item) => item.options), questions, tool_call_id: tool.id, source: "claude-code-state", response_mode: "local", read_only: true, requested_at: tool.requested_at };
}

function explicitApproval(sessionId: string, state: RecordValue | undefined): PendingInteraction | undefined {
  const block = object(state?.block); const permission = object(block?.permission ?? block?.approval ?? state?.permissionRequest);
  if (!permission) return undefined;
  const id = string(permission.id ?? permission.requestId ?? permission.requestID ?? permission.toolUseId ?? permission.tool_use_id);
  if (!id) return undefined;
  return { type: "approval", id, session_id: sessionId, tool_name: string(permission.toolName ?? permission.tool_name ?? permission.tool) ?? "permission", tool_input_summary: summary(permission.input ?? permission.description ?? permission), source: "claude-code-state", response_mode: "local", requested_at: timestamp(permission.requestedAt ?? permission.timestamp ?? state?.updatedAt), read_only: true };
}

const CAPABILITY_REASON = "Claude Code has no documented local exact-ID reply API for an arbitrary active session; private cc-socks transport is disabled";
function sessionCapabilities() {
  return {
    discovery: { supported: true, mode: "read_only" as const },
    transcript: { supported: true, mode: "read_only" as const },
    messaging: { supported: false, mode: "unsupported" as const, reason: CAPABILITY_REASON },
    question_response: { supported: false, mode: "unsupported" as const, reason: CAPABILITY_REASON },
    approval_response: { supported: false, mode: "unsupported" as const, reason: CAPABILITY_REASON },
  };
}

class ReadOnlyClaudeTarget implements CommandTarget {
  async sendMessage(): Promise<void> { throw new Error(`Claude Code message sending is read-only: ${CAPABILITY_REASON}`); }
  async respondToPending(): Promise<void> { throw new Error(`Claude Code pending responses are read-only: ${CAPABILITY_REASON}`); }
  async interrupt(): Promise<void> { throw new Error(`Claude Code interruption is read-only: ${CAPABILITY_REASON}`); }
}

export class ClaudeCodeDiscovery {
  readonly directory: string;
  readonly config_dir: string;
  readonly checkpoint_path: string;
  #executable: string | undefined;
  #version: string | undefined;
  #timer: NodeJS.Timeout | undefined;
  #polling = false;
  #loaded = false;
  #present = new Set<string>();
  #checkpoints: CheckpointFile = { version: 1, sessions: {} };
  #pathCache = new Map<string, string>();
  #diagnostics = new Set<string>();
  #pollFailures = 0;
  #nextPollAt = 0;
  #lastPollFailure: string | undefined;
  #syncFailures = new Map<string, { attempts: number; next_attempt_at: number }>();
  #questionGrace = new Map<string, { fingerprint: string; timer: NodeJS.Timeout }>();

  constructor(readonly machine_id: string, readonly registry: SessionRegistry, private readonly options: ClaudeCodeDiscoveryOptions = {}) {
    this.directory = options.directory ?? process.cwd();
    this.config_dir = options.config_dir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
    this.checkpoint_path = options.checkpoint_path ?? join(homedir(), ".config", "harness-cp", "claude-code-checkpoints.json");
  }

  async start(): Promise<void> { await this.poll(); this.#timer = setInterval(() => void this.poll(), this.options.interval_ms ?? 2_000); this.#timer.unref(); }
  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    for (const grace of this.#questionGrace.values()) clearTimeout(grace.timer);
    this.#questionGrace.clear();
  }
  target(id: string): CommandTarget | undefined { return this.#present.has(id) ? new ReadOnlyClaudeTarget() : undefined; }
  get executable(): string | undefined { return this.#executable; }
  harnesses(): HarnessDiscoveryStatus[] { return this.#executable ? [{ harness_type: "claude-code", discovered_sessions: this.#present.size, attached_sessions: this.registry.list().filter((session) => session.harness_type === "claude-code").length, ...(this.#version ? { version: this.#version } : {}), capabilities: sessionCapabilities() }] : []; }
  capabilities(): HarnessCapabilities | undefined {
    if (!this.#executable) return undefined;
    return { machine_id: this.machine_id, harness_type: "claude-code", can_create_session: false, directories: [], models: [], reported_at: new Date().toISOString(), session_capabilities: sessionCapabilities(), ...(this.#version ? { harness_version: this.#version } : {}) };
  }

  async poll(): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    if (this.#polling || now < this.#nextPollAt) return; this.#polling = true;
    try {
      await this.#load(); this.#executable ??= await resolveClaudeExecutable(this.options);
      if (!this.#executable) { this.#diagnostic("Claude Code executable was not found; existing-session discovery is inactive"); return; }
      const runner = this.options.runner ?? runBoundedCommand; const common = { cwd: this.directory, timeout_ms: this.options.timeout_ms ?? 10_000, max_output_bytes: this.options.max_output_bytes ?? 4 * 1024 * 1024 };
      if (!this.#version) {
        try { const result = await this.#command(runner, [...(this.options.executable_args ?? []), "--version"], common); this.#version = /\d+\.\d+\.\d+/.exec(result.stdout)?.[0]; } catch { /* discovery remains useful */ }
      }
      const result = await this.#command(runner, [...(this.options.executable_args ?? []), "agents", "--json"], common);
      const agents = parseClaudeAgents(result.stdout).filter((agent) => agent.kind !== "subagent" && agent.kind !== "sidechain");
      if (this.#lastPollFailure) this.registry.emit("log", "Claude Code discovery recovered");
      this.#lastPollFailure = undefined;
      this.#pollFailures = 0; this.#nextPollAt = 0;
      const found = new Set(agents.map((agent) => agent.sessionId));
      for (const id of this.#present) if (!found.has(id)) {
        this.#cancelQuestionGrace(id);
        this.registry.remove(id); this.#pathCache.delete(id); this.#syncFailures.delete(id);
      }
      this.#present = found;
      const limit = Math.max(1, this.options.max_sessions ?? 128);
      const selected = [...agents].sort((left, right) => agentTime(right) - agentTime(left)).slice(0, limit);
      if (agents.length > limit) this.#diagnostic(`Claude Code reports ${agents.length} active sessions; relaying the newest ${limit}`);
      await mapLimit(selected, this.options.concurrency ?? 2, async (agent) => {
        const retry = this.#syncFailures.get(agent.sessionId); const current = this.options.now?.() ?? Date.now();
        if (retry && current < retry.next_attempt_at) return;
        try { await this.#sync(agent); this.#syncFailures.delete(agent.sessionId); }
        catch (error) {
          const attempts = (retry?.attempts ?? 0) + 1; const delay = this.#retryDelay(attempts);
          this.#syncFailures.set(agent.sessionId, { attempts, next_attempt_at: current + delay });
          this.registry.emit("warning", new Error(`Claude Code session ${agent.sessionId} sync failed; retrying in ${Math.ceil(delay / 1_000)}s: ${error instanceof Error ? error.message : String(error)}`));
        }
      });
      await this.#save();
    } catch (error) {
      const now = this.options.now?.() ?? Date.now(); const delay = this.#retryDelay(++this.#pollFailures); this.#nextPollAt = now + delay;
      const failure = error instanceof Error ? error.message : String(error);
      if (failure !== this.#lastPollFailure) this.registry.emit("warning", new Error(`Claude Code discovery failed; retrying in ${Math.ceil(delay / 1_000)}s: ${failure}`));
      this.#lastPollFailure = failure;
    }
    finally { this.#polling = false; }
  }

  async #sync(agent: ClaudeAgent): Promise<void> {
    const prior = this.registry.get(agent.sessionId); const state = await this.#readState(agent);
    const checkpoint = this.#checkpoints.sessions[agent.sessionId] ?? { offset: 0, recent_ids: [], open_tools: {} };
    const transcriptPath = await this.#transcriptPath(agent, state);
    this.registry.upsert({ id: agent.sessionId, machine_id: this.machine_id, harness_type: "claude-code", cwd: agent.cwd, status: statusFromAgent(agent), created_at: timestamp(agent.startedAt ?? state?.createdAt), last_activity_at: timestamp(state?.updatedAt ?? prior?.last_activity_at ?? agent.startedAt), pending: prior?.pending ?? null, title: agent.name ?? string(state?.name), read_only: true,
      metadata: { kind: agent.kind, short_id: agent.id ?? "", claude_version: this.#version ?? string(state?.cliVersion) ?? "", transcript_available: Boolean(transcriptPath), control: "read_only", control_reason: CAPABILITY_REASON } });
    if (transcriptPath) await this.#tail(agent.sessionId, transcriptPath, checkpoint);
    const observedActivity = latestTimestamp(timestamp(state?.updatedAt ?? agent.startedAt), this.registry.get(agent.sessionId)?.last_activity_at);
    const wait = (agent.waitingFor ?? "").toLowerCase(); let pending: PendingInteraction | undefined;
    if (wait.includes("input")) {
      const questions = Object.values(checkpoint.open_tools).filter((tool) => tool.name === "AskUserQuestion").map((tool) => questionFromTool(agent.sessionId, tool, state)).filter((value): value is Question => Boolean(value));
      if (questions.length === 1) pending = questions[0];
    } else if (wait.includes("permission")) pending = explicitApproval(agent.sessionId, state);
    const currentSession = this.registry.get(agent.sessionId); const currentPending = currentSession?.pending ?? null;
    const hookMarker = object(object(currentSession?.metadata)?.hook_pending);
    const hookPending = currentPending && !currentPending.read_only && string(hookMarker?.id) === currentPending.id ? currentPending : null;
    // The live hook owns Claude's response callback. Transcript/state discovery
    // can observe the same question under its native tool-use ID, but that
    // read-only observation must never replace the actionable hook record.
    this.#reconcilePending(agent.sessionId, currentPending, hookPending, pending);
    this.registry.setStatus(agent.sessionId, statusFromAgent(agent));
    const current = this.registry.get(agent.sessionId); if (current) this.registry.upsert({ ...current, last_activity_at: observedActivity });
    const usage = state && claudeStatusUsage(agent.sessionId, state, current?.model?.model_id); if (usage) this.options.usage?.ingest(usage);
    this.#checkpoints.sessions[agent.sessionId] = checkpoint;
  }

  #reconcilePending(sessionId: string, current: PendingInteraction | null, hook: PendingInteraction | null, discovered: PendingInteraction | undefined): void {
    if (hook) {
      this.#cancelQuestionGrace(sessionId);
      if (JSON.stringify(current) !== JSON.stringify(hook)) this.registry.setPending(sessionId, hook);
      return;
    }
    if (discovered?.type === "question" && discovered.read_only) {
      if (current?.id === discovered.id) {
        this.#cancelQuestionGrace(sessionId);
        return;
      }
      if (current) this.registry.setPending(sessionId, null);
      this.#scheduleQuestionGrace(sessionId, discovered);
      return;
    }
    this.#cancelQuestionGrace(sessionId);
    const next = discovered ?? null;
    if (JSON.stringify(current) !== JSON.stringify(next)) this.registry.setPending(sessionId, next);
  }

  #scheduleQuestionGrace(sessionId: string, pending: PendingInteraction): void {
    const delayMs = this.options.question_grace_ms ?? 2_500;
    if (delayMs <= 0) {
      this.registry.setPending(sessionId, pending);
      return;
    }
    const fingerprint = JSON.stringify(pending);
    const prior = this.#questionGrace.get(sessionId);
    if (prior?.fingerprint === fingerprint) return;
    if (prior) clearTimeout(prior.timer);
    const timer = setTimeout(() => {
      const scheduled = this.#questionGrace.get(sessionId);
      if (!scheduled || scheduled.fingerprint !== fingerprint) return;
      this.#questionGrace.delete(sessionId);
      const current = this.registry.get(sessionId);
      if (!current) return;
      const marker = object(object(current.metadata)?.hook_pending);
      const hookPending = current.pending && string(marker?.id) === current.pending.id;
      if (!hookPending) this.registry.setPending(sessionId, pending);
    }, delayMs);
    timer.unref();
    this.#questionGrace.set(sessionId, { fingerprint, timer });
  }

  #cancelQuestionGrace(sessionId: string): void {
    const grace = this.#questionGrace.get(sessionId);
    if (grace) clearTimeout(grace.timer);
    this.#questionGrace.delete(sessionId);
  }

  async #readState(agent: ClaudeAgent): Promise<RecordValue | undefined> {
    if (agent.kind !== "background" || !agent.id || !/^[a-f0-9]{8}$/i.test(agent.id)) return undefined;
    try {
      const value = object(JSON.parse(await readFile(join(this.config_dir, "jobs", agent.id, "state.json"), "utf8")) as unknown);
      return string(value?.sessionId) === agent.sessionId ? value : undefined;
    } catch { return undefined; }
  }

  async #transcriptPath(agent: ClaudeAgent, state: RecordValue | undefined): Promise<string | undefined> {
    const linked = string(state?.linkScanPath); if (linked && await this.#safeTranscript(linked, agent.sessionId)) return linked;
    const cached = this.#pathCache.get(agent.sessionId); if (cached && await this.#safeTranscript(cached, agent.sessionId)) return cached;
    const encoded = agent.cwd.replace(/[^A-Za-z0-9_-]/g, "-"); const direct = join(this.config_dir, "projects", encoded, `${agent.sessionId}.jsonl`);
    if (await this.#safeTranscript(direct, agent.sessionId)) { this.#pathCache.set(agent.sessionId, direct); return direct; }
    try {
      const projects = await readdir(join(this.config_dir, "projects"), { withFileTypes: true }); const limit = this.options.max_project_directories ?? 10_000;
      if (projects.length > limit) { this.#diagnostic(`Claude transcript search exceeds ${limit} project directories; only cwd-derived paths are used`); return undefined; }
      for (const project of projects) if (project.isDirectory()) {
        const candidate = join(this.config_dir, "projects", project.name, `${agent.sessionId}.jsonl`);
        if (await this.#safeTranscript(candidate, agent.sessionId)) { this.#pathCache.set(agent.sessionId, candidate); return candidate; }
      }
    } catch { /* no transcript directory */ }
    return undefined;
  }

  async #safeTranscript(path: string, sessionId: string): Promise<boolean> {
    if (!path.endsWith(`${sessionId}.jsonl`)) return false;
    try {
      const [root, candidate] = await Promise.all([realpath(join(this.config_dir, "projects")), realpath(path)]);
      return candidate.startsWith(`${root}/`) || candidate.startsWith(`${root}\\`);
    } catch { return false; }
  }

  async #tail(sessionId: string, path: string, checkpoint: TailCheckpoint): Promise<void> {
    const info = await stat(path); const identity = `${String(info.dev)}:${String(info.ino)}`;
    if (checkpoint.path !== path || checkpoint.identity !== identity || info.size < checkpoint.offset) {
      checkpoint.path = path; checkpoint.identity = identity; checkpoint.offset = 0; checkpoint.remainder = undefined; checkpoint.skipping_line = false;
      this.#diagnostic(`Claude transcript ${sessionId.slice(0, 8)} reset after path, rotation, or truncation change`);
    }
    const maxBytes = this.options.max_transcript_bytes_per_poll ?? 4 * 1024 * 1024; const remaining = Math.min(maxBytes, Math.max(0, info.size - checkpoint.offset));
    if (remaining === 0) { if (checkpoint.remainder) await this.#consume(sessionId, Buffer.alloc(0), checkpoint); return; }
    const handle = await open(path, "r"); const buffer = Buffer.alloc(remaining);
    try { const read = await handle.read(buffer, 0, remaining, checkpoint.offset); checkpoint.offset += read.bytesRead; await this.#consume(sessionId, buffer.subarray(0, read.bytesRead), checkpoint); }
    finally { await handle.close(); }
  }

  async #consume(sessionId: string, chunk: Buffer, checkpoint: TailCheckpoint): Promise<void> {
    let data = checkpoint.remainder ? Buffer.concat([Buffer.from(checkpoint.remainder, "base64"), chunk]) : chunk; checkpoint.remainder = undefined;
    const maxLine = this.options.max_line_bytes ?? 1024 * 1024; const maxLines = this.options.max_lines_per_poll ?? 2_000; let start = 0; let lines = 0;
    for (let index = 0; index < data.length; index++) if (data[index] === 10) {
      const line = data.subarray(start, index); start = index + 1;
      if (checkpoint.skipping_line) { checkpoint.skipping_line = false; continue; }
      if (line.length > maxLine) { this.#diagnostic(`Claude transcript line exceeded ${maxLine} bytes and was skipped`); continue; }
      if (++lines > maxLines) { checkpoint.remainder = data.subarray(index - line.length).toString("base64"); return; }
      this.#record(sessionId, line.toString("utf8").replace(/\r$/, ""), checkpoint);
    }
    const remainder = data.subarray(start);
    if (remainder.length > maxLine) { checkpoint.skipping_line = true; this.#diagnostic(`Claude transcript line exceeded ${maxLine} bytes and was skipped`); }
    else if (remainder.length > 0) checkpoint.remainder = remainder.toString("base64");
  }

  #record(sessionId: string, line: string, checkpoint: TailCheckpoint): void {
    if (!line) return; let record: RecordValue;
    try { const parsed = object(JSON.parse(line) as unknown); if (!parsed) return; record = parsed; } catch { this.#diagnostic("Claude transcript contains a malformed JSONL record"); return; }
    if (record.isSidechain === true || string(record.sessionId ?? record.session_id) !== sessionId) return;
    const recordId = string(record.uuid) ?? string(record.messageId) ?? stableId(sessionId, line); const seen = new Set(checkpoint.recent_ids);
    if (seen.has(recordId)) return;
    const ts = timestamp(record.timestamp); const role = string(object(record.message)?.role) ?? string(record.type);
    const current = this.registry.get(sessionId); const model = string(object(record.message)?.model); const customTitle = record.type === "custom-title" ? string(record.customTitle) : undefined;
    if (current && (model || customTitle)) this.registry.upsert({ ...current, ...(model ? { model: { provider_id: "anthropic", model_id: model } } : {}), ...(customTitle ? { title: customTitle } : {}) });
    const usage = claudeMessageUsage(sessionId, recordId, record, ts); if (usage) this.options.usage?.ingest(usage);
    for (const [index, block] of contentBlocks(record).entries()) {
      const blockType = string(block.type); const blockId = string(block.id) ?? `${recordId}:${index}`; const eventId = stableId(sessionId, recordId, blockId, blockType ?? "unknown");
      if (blockType === "text" && typeof block.text === "string") this.registry.append(sessionId, role === "user" ? "user_message" : "agent_message", { text: block.text }, { id: eventId, ts });
      else if (blockType === "tool_use") {
        const toolId = string(block.id); const name = string(block.name);
        if (toolId && name) {
          const input = jsonValue(block.input); checkpoint.open_tools[toolId] = { id: toolId, name, ...(input !== undefined ? { input } : {}), requested_at: ts };
          this.registry.append(sessionId, "tool_call", { tool_call_id: toolId, tool_name: name, input_summary: summary(block.input), ...(input !== undefined ? { input } : {}) }, { id: eventId, ts });
        }
      } else if (blockType === "tool_result") {
        const toolId = string(block.tool_use_id ?? block.toolUseId); if (!toolId) continue; delete checkpoint.open_tools[toolId];
        const output = jsonValue(block.content); const isError = block.is_error === true || block.isError === true;
        this.registry.append(sessionId, "tool_result", { tool_call_id: toolId, output_summary: summary(block.content), ...(output !== undefined ? { output } : {}), is_error: isError }, { id: eventId, ts });
      }
    }
    checkpoint.recent_ids.push(recordId); const limit = this.options.max_recent_ids ?? 4_096; if (checkpoint.recent_ids.length > limit) checkpoint.recent_ids.splice(0, checkpoint.recent_ids.length - limit);
  }

  async #load(): Promise<void> {
    if (this.#loaded) return; this.#loaded = true;
    try { const value = JSON.parse(await readFile(this.checkpoint_path, "utf8")) as CheckpointFile; if (value.version === 1 && object(value.sessions)) this.#checkpoints = value; }
    catch { /* first run or invalid checkpoint */ }
  }
  async #command(runner: CommandRunner, args: readonly string[], options: { cwd: string; timeout_ms: number; max_output_bytes: number }): Promise<{ stdout: string; stderr: string }> {
    try { return await runner(this.#executable!, args, options); }
    catch (error) { throw new Error((error instanceof Error ? error.message : String(error)).replaceAll("OpenCode", "Claude Code")); }
  }
  async #save(): Promise<void> {
    await mkdir(dirname(this.checkpoint_path), { recursive: true, mode: 0o700 }); const temporary = `${this.checkpoint_path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#checkpoints)}\n`, { mode: 0o600 }); await rename(temporary, this.checkpoint_path);
  }
  #retryDelay(attempts: number): number { return Math.min(this.options.max_retry_ms ?? 5 * 60_000, (this.options.retry_base_ms ?? 30_000) * 2 ** Math.max(0, attempts - 1)); }
  #diagnostic(message: string): void { if (this.#diagnostics.has(message)) return; this.#diagnostics.add(message); this.registry.emit("log", message); }
}
