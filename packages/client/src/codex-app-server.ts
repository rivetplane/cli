import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { ApprovalScope, PendingInteraction, SessionStatus } from "@rivetplane/shared/model";
import type { HarnessCapabilities } from "@rivetplane/shared/protocol";
import type { CreateSessionCommand } from "@rivetplane/shared/protocol";
import WebSocket from "ws";
import type { CommandTarget } from "./relay.js";
import { SessionRegistry } from "./registry.js";
import type { HarnessDiscoveryStatus } from "./session-manager.js";

type RpcId = number | string;
type RecordValue = Record<string, unknown>;
interface PendingRpc { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; method: string }
interface PendingServerRequest { rpc_id: RpcId; method: string; params: RecordValue }
interface ThreadState { turn_id?: string; loaded: boolean; history_loaded?: boolean; history_attempts?: number; history_retry_at?: number; missing_polls?: number; retain_until?: number }

export interface CodexAppServerOptions {
  endpoint?: string;
  token?: string;
  managed?: boolean;
  executable?: string;
  directory?: string;
  socket_path?: string;
  interval_ms?: number;
  request_timeout_ms?: number;
  max_threads?: number;
  missing_poll_limit?: number;
  new_thread_grace_ms?: number;
  history_threads?: number;
  concurrency?: number;
  retry_base_ms?: number;
  max_retry_ms?: number;
  now?: () => number;
  spawn_process?: typeof spawn;
  platform?: NodeJS.Platform;
}

function object(value: unknown): RecordValue | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined; }
function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function isoSeconds(value: unknown): string { return new Date((number(value) ?? Date.now() / 1_000) * 1_000).toISOString(); }
function summary(value: unknown, limit = 2_000): string { const text = typeof value === "string" ? value : JSON.stringify(value) ?? ""; return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`; }
function requestKey(id: RpcId): string { return `${typeof id}:${String(id)}`; }
function threadStatus(value: unknown): SessionStatus {
  const type = string(object(value)?.type); return type === "active" ? "running" : type === "systemError" ? "error" : "waiting_input";
}
function questionOptions(value: unknown): Array<{ label: string; description?: string }> {
  return array(value).flatMap((entry) => { const option = object(entry); const label = string(option?.label); const description = string(option?.description); return label ? [{ label, ...(description ? { description } : {}) }] : []; });
}
async function mapLimit<T>(values: readonly T[], concurrency: number, operation: (value: T) => Promise<void>): Promise<void> {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (index < values.length) { const value = values[index++]; if (value !== undefined) await operation(value); }
  }));
}

async function availablePort(): Promise<number> {
  const server = createServer(); await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Could not allocate a Codex app-server port");
  await new Promise<void>((resolve) => server.close(() => resolve())); return address.port;
}

async function unixSocketIsActive(path: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection(path); const finish = (active: boolean) => { clearTimeout(timer); socket.destroy(); resolve(active); }; const timer = setTimeout(() => finish(false), 250);
    socket.once("connect", () => finish(true)); socket.once("error", () => finish(false));
  });
}

class CodexTarget implements CommandTarget {
  constructor(private readonly manager: CodexAppServerManager, private readonly thread_id: string) {}
  sendMessage(text: string): Promise<void> { return this.manager.sendMessage(this.thread_id, text); }
  respondToPending(id: string, response: string, scope?: ApprovalScope): Promise<void> { return this.manager.respondToPending(this.thread_id, id, response, scope); }
  interrupt(): Promise<void> { return this.manager.interrupt(this.thread_id); }
}

export class CodexAppServerManager {
  readonly directory: string;
  #endpoint: string | undefined;
  #token: string | undefined;
  #token_path: string | undefined;
  #child: ChildProcess | undefined;
  #socket: WebSocket | undefined;
  #timer: NodeJS.Timeout | undefined;
  #polling = false;
  #request_id = 1;
  #requests = new Map<string, PendingRpc>();
  #pending = new Map<string, PendingServerRequest>();
  #threads = new Map<string, ThreadState>();
  #unknown = new Set<string>();
  #streamed_items = new Set<string>();
  #delta_counts = new Map<string, number>();
  #online = false;
  #version = "unknown";
  #transport = "none";
  #operations = { persisted_discovery: true, live_attachment: false, messaging: false, interrupt: false, question_response: false, approval_response: false };
  #models: HarnessCapabilities["models"] = [];
  #default_model: string | undefined;
  #pollFailures = 0;
  #nextPollAt = 0;
  #stopped = false;

  constructor(readonly machine_id: string, readonly registry: SessionRegistry, private readonly options: CodexAppServerOptions = {}) {
    this.directory = options.directory ?? process.cwd(); this.#endpoint = options.endpoint; this.#token = options.token;
  }
  async start(): Promise<void> { this.#stopped = false; if (this.options.managed) await this.#launch(); await this.poll(); this.#timer = setInterval(() => void this.poll(), this.options.interval_ms ?? 2_000); this.#timer.unref(); }
  async stop(): Promise<void> {
    this.#stopped = true; if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; this.#close(new Error("Codex app-server stopped"));
    if (this.#child) { const child = this.#child; this.#child = undefined; child.kill("SIGTERM"); }
    if (this.options.managed && this.#transport === "unix" && this.#endpoint) await unlink(this.#endpoint.replace(/^unix:\/\//, "")).catch(() => undefined);
    if (this.options.managed && this.#token_path) await unlink(this.#token_path).catch(() => undefined);
  }
  target(id: string): CommandTarget | undefined { return this.#online && this.#threads.has(id) ? new CodexTarget(this, id) : undefined; }
  harnesses(): HarnessDiscoveryStatus[] {
    const ids = [...this.#threads.keys()];
    return this.#endpoint ? [{ harness_type: "codex", discovered_sessions: ids.length, attached_sessions: this.#online ? ids.length : 0, discovered_session_ids: ids, attached_session_ids: this.#online ? ids : [], capabilities: this.health() }] : [];
  }
  health() {
    const support = (value: boolean, reason: string) => value ? { supported: true, mode: "read_write" as const } : { supported: false, mode: "unsupported" as const, reason };
    const offline = "The Codex app-server transport is not connected.";
    return { persisted_discovery: support(this.#online, offline), discovery: support(this.#online, offline), transcript: support(this.#online, offline), live_attachment: support(this.#operations.live_attachment, offline), messaging: support(this.#operations.messaging, "Codex turn/start is not available."), interrupt: support(this.#operations.interrupt, "Codex turn/interrupt is not available."), question_response: support(this.#operations.question_response, "Codex user-input responses are not available."), approval_response: support(this.#operations.approval_response, "Codex approval responses are not available."), transport: this.#transport, managed: Boolean(this.options.managed), endpoint: this.#endpoint ? this.#endpoint.replace(/token=[^&]+/g, "token=<redacted>") : null };
  }
  capabilities(): HarnessCapabilities | undefined {
    if (!this.#endpoint) return undefined;
    return { machine_id: this.machine_id, harness_type: "codex", can_create_session: this.#online, directories: [this.directory], models: this.#models, ...(this.#default_model ? { default_model: { provider_id: "openai", model_id: this.#default_model } } : {}), reported_at: new Date().toISOString(), session_capabilities: this.health(), transport: this.#transport, harness_version: this.#version,
      limitations: ["Persisted rollout discovery is read-only.", "Rivetplane does not attach to independently launched stdio app-server processes.", "Exact responses cover command and file approvals plus item/tool/requestUserInput. Permissions-profile approvals and MCP elicitation fail closed."] };
  }
  async createSession(command: CreateSessionCommand): Promise<string> {
    if (!this.#online) throw new Error("Codex app-server is not connected");
    const result = object(await this.#request("thread/start", { cwd: command.cwd, model: command.model.model_id, approvalPolicy: "untrusted", sandbox: "workspace-write", serviceName: "rivetplane" }));
    const thread = object(result?.thread); const id = string(thread?.id); if (!thread || !id) throw new Error("Codex thread/start returned no thread ID");
    this.#syncThread(thread); const state = this.#threads.get(id)!; state.loaded = true; state.retain_until = (this.options.now?.() ?? Date.now()) + (this.options.new_thread_grace_ms ?? 60_000); return id;
  }

  async poll(): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    if (this.#polling || now < this.#nextPollAt) return; this.#polling = true;
    try {
      if (this.options.managed && (!this.#child || this.#child.exitCode !== null)) await this.#launch();
      if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) await this.#connect();
      await this.#listThreads();
      this.#pollFailures = 0; this.#nextPollAt = 0;
    } catch (error) {
      this.#online = false; this.#operations.live_attachment = false;
      if (!this.#stopped) { const delay = this.#retryDelay(++this.#pollFailures); this.#nextPollAt = now + delay; this.registry.emit("warning", new Error(`Codex app-server failed; retrying in ${Math.ceil(delay / 1_000)}s: ${error instanceof Error ? error.message : String(error)}`)); }
    }
    finally { this.#polling = false; }
  }

  async sendMessage(threadId: string, text: string): Promise<void> {
    const state = this.#requireThread(threadId); if (!state.loaded) { await this.#request("thread/resume", { threadId }); state.loaded = true; }
    const result = object(await this.#request("turn/start", { threadId, clientUserMessageId: randomUUID(), input: [{ type: "text", text, text_elements: [] }] }));
    const turn = object(result?.turn); state.turn_id = string(turn?.id); this.#operations.messaging = true; this.registry.setStatus(threadId, "running");
  }
  async interrupt(threadId: string): Promise<void> {
    const state = this.#requireThread(threadId); if (!state.turn_id) throw new Error("Codex thread has no active turn to interrupt");
    await this.#request("turn/interrupt", { threadId, turnId: state.turn_id }); this.#operations.interrupt = true;
  }
  async setThreadName(threadId: string, name: string): Promise<void> {
    this.#requireThread(threadId); await this.#request("thread/name/set", { threadId, name });
    const current = this.registry.get(threadId); if (current) this.registry.upsert({ ...current, title: name });
  }
  async setCollaborationMode(threadId: string, mode: "default" | "plan"): Promise<void> {
    this.#requireThread(threadId);
    const model = this.#default_model ?? this.#models[0]?.model_id;
    if (!model) throw new Error("Codex model roster is not available");
    await this.#request("thread/settings/update", { threadId, collaborationMode: { mode, settings: { model, reasoning_effort: mode === "plan" ? "medium" : null, developer_instructions: null } } });
  }
  async respondToPending(threadId: string, pendingId: string, response: string, scope?: ApprovalScope): Promise<void> {
    const pending = this.#pending.get(pendingId); const current = this.registry.get(threadId)?.pending;
    if (!pending || !current || current.id !== pendingId || string(pending.params.threadId) !== threadId) throw new Error(`Codex request ${pendingId} is no longer pending`);
    let result: unknown;
    if (pending.method === "item/tool/requestUserInput") {
      const questions = array(pending.params.questions).map(object).filter((item): item is RecordValue => Boolean(item));
      let supplied: Record<string, string[]> | undefined;
      try { const parsed = object(JSON.parse(response)); if (parsed) supplied = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, Array.isArray(value) ? value.map(String) : [String(value)]])); } catch { /* one answer */ }
      if (questions.length > 1 && !supplied) throw new Error("A multi-question Codex request needs a JSON object keyed by question ID");
      const answers = Object.fromEntries(questions.map((question, index) => { const id = string(question.id) ?? String(index); return [id, { answers: supplied?.[id] ?? (index === 0 ? [response] : []) }]; }));
      result = { answers }; this.#operations.question_response = true;
    } else {
      if (response !== "approve" && response !== "deny") throw new Error("Codex approval response must be approve or deny");
      if (scope === "always_this_tool") throw new Error("Codex app-server does not expose an exact always-this-tool decision for this request");
      const decision = response === "deny" ? "decline" : scope === "always_session" ? "acceptForSession" : "accept";
      result = { decision }; this.#operations.approval_response = true;
    }
    this.#send({ id: pending.rpc_id, result }); this.#pending.delete(pendingId);
    if (current.type === "approval") this.registry.append(threadId, "permission_response", { approval_id: pendingId, resolution: response === "deny" ? "deny" : "approve", ...(scope ? { scope } : {}) });
    this.registry.setPending(threadId, null); this.registry.setStatus(threadId, "running");
  }

  async #launch(): Promise<void> {
    if (this.#child && this.#child.exitCode === null) return;
    const platform = this.options.platform ?? process.platform; const spawnProcess = this.options.spawn_process ?? spawn; const executable = this.options.executable ?? "codex";
    let args: string[];
    if (platform === "win32") {
      const port = await availablePort(); const secretDirectory = join(homedir(), ".config", "harness-cp", "codex"); await mkdir(secretDirectory, { recursive: true, mode: 0o700 });
      const tokenPath = join(secretDirectory, "app-server-token"); this.#token_path = tokenPath; this.#token = randomBytes(32).toString("base64url"); await writeFile(tokenPath, this.#token, { mode: 0o600 });
      this.#endpoint = `ws://127.0.0.1:${port}`; args = ["app-server", "--listen", this.#endpoint, "--ws-auth", "capability-token", "--ws-token-file", tokenPath]; this.#transport = "loopback-websocket";
    } else {
      const socketPath = this.options.socket_path ?? join(homedir(), ".config", "harness-cp", "codex", "app-server.sock"); await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 }); await chmod(dirname(socketPath), 0o700);
      if (await unixSocketIsActive(socketPath)) throw new Error(`Refusing to replace an active Codex socket at ${socketPath}`); await unlink(socketPath).catch(() => undefined);
      this.#endpoint = `unix://${socketPath}`; args = ["app-server", "--listen", this.#endpoint]; this.#transport = "unix";
    }
    const child = spawnProcess(executable, args, { cwd: this.directory, stdio: ["ignore", "ignore", "pipe"], windowsHide: true }); this.#child = child;
    child.stderr?.on("data", (chunk: Buffer) => { const value = chunk.toString("utf8").trim(); if (value) this.registry.emit("log", `Codex app-server: ${summary(value, 500)}`); });
    child.once("exit", () => { if (this.#child === child) { this.#child = undefined; this.#close(new Error("Managed Codex app-server exited")); } });
    for (let attempt = 0; attempt < 50; attempt += 1) { try { await this.#connect(); if (platform !== "win32" && this.#endpoint) await chmod(this.#endpoint.replace(/^unix:\/\//, ""), 0o600); return; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); } }
    throw new Error("Managed Codex app-server did not become ready");
  }

  async #connect(): Promise<void> {
    if (!this.#endpoint) return;
    if (this.#socket?.readyState === WebSocket.OPEN) return;
    const endpoint = this.#endpoint; const isUnix = endpoint.startsWith("unix://"); const socketPath = isUnix ? endpoint.slice("unix://".length) : undefined;
    if (isUnix && socketPath) {
      const info = await stat(socketPath);
      if (this.options.managed) await chmod(socketPath, 0o600);
      else if ((typeof process.getuid === "function" && Number(info.uid) !== process.getuid()) || (info.mode & 0o077) !== 0) throw new Error("Configured Codex Unix socket must be owned by this user and have mode 0600");
    } else {
      const url = new URL(endpoint); const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "::1";
      if (!loopback && (url.protocol !== "wss:" || !this.#token)) throw new Error("A non-loopback Codex endpoint needs WSS and a bearer token");
    }
    const socket = isUnix
      ? new WebSocket("ws://localhost/rpc", { perMessageDeflate: false, createConnection: () => createConnection(socketPath!) })
      : new WebSocket(endpoint, { ...(this.#token ? { headers: { authorization: `Bearer ${this.#token}` } } : {}) });
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { socket.terminate(); reject(new Error("connection timed out")); }, 3_000); socket.once("open", () => { clearTimeout(timer); resolve(); }); socket.once("error", (error) => { clearTimeout(timer); reject(error); }); });
    this.#socket = socket; socket.on("message", (data) => this.#receive(data.toString())); socket.on("close", () => this.#close(new Error("Codex app-server connection closed"))); socket.on("error", () => undefined);
    const initialized = object(await this.#request("initialize", { clientInfo: { name: "rivetplane", title: "Rivetplane", version: "0.3.0" }, capabilities: { experimentalApi: true } }));
    this.#version = string(initialized?.userAgent) ?? this.#version; this.#send({ method: "initialized", params: {} }); this.#online = true;
    this.#operations = { ...this.#operations, live_attachment: true, messaging: true, interrupt: true, question_response: true, approval_response: true };
    await this.#modelsList();
  }

  async #listThreads(): Promise<void> {
    if (!this.#endpoint) return;
    const maxThreads = Math.max(1, this.options.max_threads ?? 48); let cursor: string | null = null; let count = 0; const found = new Set<string>();
    do {
      const response = object(await this.#request("thread/list", { limit: Math.min(100, maxThreads - count), cursor, sortKey: "updated_at", sortDirection: "desc" }));
      const threads = array(response?.data).map(object).filter((item): item is RecordValue => Boolean(item));
      for (const thread of threads) {
        const id = string(thread.id); if (!id || thread.parentThreadId) continue; if (count++ >= maxThreads) break;
        found.add(id); this.#syncThread(thread);
      }
      cursor = string(response?.nextCursor) ?? null;
    } while (cursor && count < maxThreads);
    for (const [id, state] of this.#threads) if (!found.has(id)) {
      const current = this.registry.get(id); const now = this.options.now?.() ?? Date.now();
      if (now < (state.retain_until ?? 0) || current?.status === "running" || current?.pending) continue;
      state.missing_polls = (state.missing_polls ?? 0) + 1; if (state.missing_polls < (this.options.missing_poll_limit ?? 3)) continue;
      this.#threads.delete(id); if (object(current?.metadata)?.codex_control === "app-server") this.registry.remove(id);
    }
    const now = this.options.now?.() ?? Date.now(); const history = [...found].slice(0, Math.max(0, this.options.history_threads ?? 12)).filter((id) => {
      const state = this.#threads.get(id); return state && !state.history_loaded && now >= (state.history_retry_at ?? 0);
    });
    await mapLimit(history, this.options.concurrency ?? 2, async (id) => {
      const state = this.#threads.get(id); if (!state) return;
      try { await this.#readThread(id); state.history_loaded = true; state.history_attempts = 0; state.history_retry_at = 0; }
      catch (error) {
        state.history_attempts = (state.history_attempts ?? 0) + 1; const delay = this.#retryDelay(state.history_attempts); state.history_retry_at = now + delay;
        this.registry.emit("warning", new Error(`Codex thread ${id} history failed; retrying in ${Math.ceil(delay / 1_000)}s: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }
  #syncThread(thread: RecordValue): void {
    const id = string(thread.id)!; const current = this.registry.get(id); const state = this.#threads.get(id) ?? { loaded: false }; state.missing_polls = 0; this.#threads.set(id, state);
    const status = current?.pending?.type === "approval" ? "waiting_approval" : current?.pending?.type === "question" ? "waiting_input" : threadStatus(thread.status);
    this.registry.upsert({ id, machine_id: this.machine_id, harness_type: "codex", cwd: string(thread.cwd) ?? this.directory, status, created_at: isoSeconds(thread.createdAt), last_activity_at: isoSeconds(thread.updatedAt), pending: current?.pending ?? null,
      title: string(thread.name) ?? string(thread.preview), read_only: false, ...(string(thread.modelProvider) ? { model: { provider_id: string(thread.modelProvider)!, model_id: "unknown" } } : {}),
      metadata: { codex_control: "app-server", live_process_attached: true, transport: this.#transport, cli_version: string(thread.cliVersion) ?? this.#version, source: thread.source as never } });
  }
  async #readThread(threadId: string): Promise<void> {
    const response = object(await this.#request("thread/read", { threadId, includeTurns: true })); const thread = object(response?.thread); if (!thread) return;
    for (const turn of array(thread.turns).map(object).filter((item): item is RecordValue => Boolean(item))) {
      const time = number(turn.completedAt ?? turn.startedAt); for (const item of array(turn.items).map(object).filter((entry): entry is RecordValue => Boolean(entry))) this.#syncItem(threadId, item, time ? time * 1_000 : undefined);
    }
  }
  async #modelsList(): Promise<void> {
    try { const response = object(await this.#request("model/list", { limit: 100 })); const data = array(response?.data).map(object).filter((item): item is RecordValue => Boolean(item)); this.#models = data.flatMap((item) => { const id = string(item.model) ?? string(item.id); return id ? [{ provider_id: "openai", model_id: id, name: string(item.displayName) ?? id }] : []; }); this.#default_model = data.find((item) => item.isDefault === true) && (string(data.find((item) => item.isDefault === true)?.model) ?? string(data.find((item) => item.isDefault === true)?.id)); } catch { this.#models = []; this.#default_model = undefined; }
  }

  #receive(raw: string): void {
    let message: RecordValue; try { const parsed = object(JSON.parse(raw)); if (!parsed) return; message = parsed; } catch { this.registry.emit("warning", new Error("Codex app-server sent invalid JSON")); return; }
    if ((typeof message.id === "number" || typeof message.id === "string") && ("result" in message || "error" in message) && !message.method) {
      const pending = this.#requests.get(requestKey(message.id)); if (!pending) return; this.#requests.delete(requestKey(message.id)); clearTimeout(pending.timer);
      const error = object(message.error); if (error) { if (number(error.code) === -32601) this.#disableMethod(pending.method); pending.reject(new Error(`${pending.method}: ${string(error.message) ?? "request failed"}`)); } else pending.resolve(message.result); return;
    }
    const method = string(message.method); const params = object(message.params) ?? {}; if (!method) return;
    if (typeof message.id === "number" || typeof message.id === "string") { this.#serverRequest(method, message.id, params); return; }
    this.#notification(method, params);
  }
  #serverRequest(method: string, rpcId: RpcId, params: RecordValue): void {
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      const threadId = string(params.threadId); if (!threadId || !this.registry.get(threadId)) { this.#send({ id: rpcId, error: { code: -32602, message: "Unknown thread" } }); return; }
      const id = String(rpcId); const pending: PendingInteraction = { type: "approval", id, session_id: threadId, tool_name: method.includes("commandExecution") ? "commandExecution" : "fileChange", tool_input_summary: summary(params.command ?? params.reason ?? params), requested_at: new Date(number(params.startedAtMs) ?? Date.now()).toISOString() };
      this.#pending.set(id, { rpc_id: rpcId, method, params }); this.registry.setPending(threadId, pending); this.registry.append(threadId, "permission_request", { approval_id: id, tool_name: pending.tool_name, tool_input_summary: pending.tool_input_summary }, { id: `codex-request-${requestKey(rpcId)}` }); this.registry.setStatus(threadId, "waiting_approval"); return;
    }
    if (method === "item/tool/requestUserInput") {
      const threadId = string(params.threadId); if (!threadId || !this.registry.get(threadId)) { this.#send({ id: rpcId, error: { code: -32602, message: "Unknown thread" } }); return; }
      const questions = array(params.questions).map(object).filter((item): item is RecordValue => Boolean(item)); const id = String(rpcId);
      const pending: PendingInteraction = { type: "question", id, session_id: threadId, prompt: questions.map((item) => string(item.question) ?? "").join("\n"), header: questions.map((item) => string(item.header) ?? "").join(" / "),
        options: questions.flatMap((item) => questionOptions(item.options).map((option) => option.label)), option_details: questions.flatMap((item) => questionOptions(item.options)),
        questions: questions.map((item) => ({ prompt: string(item.question) ?? "", header: string(item.header) ?? "", options: questionOptions(item.options), custom: item.isOther === true })), tool_call_id: string(params.itemId), requested_at: new Date().toISOString() };
      this.#pending.set(id, { rpc_id: rpcId, method, params }); this.registry.setPending(threadId, pending); this.registry.setStatus(threadId, "waiting_input"); return;
    }
    this.#send({ id: rpcId, error: { code: -32601, message: `Unsupported server request: ${method}` } }); this.#diagnostic(method);
  }
  #notification(method: string, params: RecordValue): void {
    // This official process-level notification has no session state for Rivetplane.
    if (method === "remoteControl/status/changed") return;
    const threadId = string(params.threadId); if (method === "turn/started" && threadId) { const turn = object(params.turn); const state = this.#threads.get(threadId); if (state) state.turn_id = string(turn?.id); if (this.registry.get(threadId)) this.registry.setStatus(threadId, "running"); return; }
    if (method === "turn/completed" && threadId) { const turn = object(params.turn); const state = this.#threads.get(threadId); if (state) state.turn_id = undefined; if (this.registry.get(threadId)) this.registry.setStatus(threadId, string(turn?.status) === "failed" ? "error" : "waiting_input"); return; }
    if ((method === "item/completed" || method === "item/started") && threadId) { const item = object(params.item); if (item) this.#syncItem(threadId, item, number(params.completedAtMs ?? params.startedAtMs)); return; }
    if (method === "item/agentMessage/delta" && threadId) { const delta = string(params.delta); const itemId = string(params.itemId); if (delta && itemId && this.registry.get(threadId)) { const count = (this.#delta_counts.get(itemId) ?? 0) + 1; this.#delta_counts.set(itemId, count); this.#streamed_items.add(itemId); this.registry.append(threadId, "agent_message", { text: delta }, { id: `codex-delta-${itemId}-${count}` }); } return; }
    if (["thread/started", "thread/status/changed", "thread/name/updated"].includes(method)) { const thread = object(params.thread); if (thread?.id) this.#syncThread(thread); return; }
    if (method === "error" || method === "warning") { this.registry.emit("warning", new Error(`Codex ${method}: ${summary(params, 1_000)}`)); return; }
    if (!method.startsWith("account/") && !method.startsWith("serverRequest/")) this.#diagnostic(method);
  }
  #syncItem(threadId: string, item: RecordValue, timeMs?: number): void {
    if (!this.registry.get(threadId)) return; const id = string(item.id) ?? randomUUID(); const ts = new Date(timeMs ?? Date.now()).toISOString(); const type = string(item.type);
    if (type === "userMessage") { const text = array(item.content).map(object).flatMap((part) => string(part?.text) ?? []).join(""); if (text) this.registry.append(threadId, "user_message", { text }, { id: `codex-item-${id}`, ts }); }
    else if (type === "agentMessage") { const text = string(item.text); if (text && !this.#streamed_items.has(id)) this.registry.append(threadId, "agent_message", { text }, { id: `codex-item-${id}`, ts }); }
    else if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"].includes(type ?? "")) {
      const tool = type ?? "tool"; this.registry.append(threadId, "tool_call", { tool_call_id: id, tool_name: tool, input_summary: summary(item.command ?? item.arguments ?? item.changes) }, { id: `codex-item-${id}-call`, ts });
      if (["completed", "failed", "declined"].includes(string(item.status) ?? "")) this.registry.append(threadId, "tool_result", { tool_call_id: id, output_summary: summary(item.aggregatedOutput ?? item.result ?? item.error), is_error: string(item.status) !== "completed" }, { id: `codex-item-${id}-result`, ts });
    }
  }

  #request(method: string, params: unknown): Promise<unknown> {
    const id = this.#request_id++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#requests.delete(requestKey(id)); reject(new Error(`${method} timed out`)); }, this.options.request_timeout_ms ?? 10_000); timer.unref();
      this.#requests.set(requestKey(id), { resolve, reject, timer, method });
      try { this.#send({ method, id, params }); } catch (error) { clearTimeout(timer); this.#requests.delete(requestKey(id)); reject(error); }
    });
  }
  #send(message: unknown): void { if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) throw new Error("Codex app-server is not connected"); this.#socket.send(JSON.stringify(message)); }
  #close(error: Error): void { const socket = this.#socket; this.#socket = undefined; this.#online = false; this.#operations.live_attachment = false; if (socket && socket.readyState === WebSocket.OPEN) socket.close(); for (const request of this.#requests.values()) { clearTimeout(request.timer); request.reject(error); } this.#requests.clear(); this.#pending.clear(); for (const id of this.#threads.keys()) { const current = this.registry.get(id); if (object(current?.metadata)?.codex_control === "app-server") this.registry.remove(id); } this.#threads.clear(); }
  #requireThread(id: string): ThreadState { const state = this.#threads.get(id); if (!state) throw new Error(`Codex thread ${id} is not attached`); return state; }
  #disableMethod(method: string): void { if (method === "turn/start") this.#operations.messaging = false; else if (method === "turn/interrupt") this.#operations.interrupt = false; }
  #retryDelay(attempts: number): number { return Math.min(this.options.max_retry_ms ?? 5 * 60_000, (this.options.retry_base_ms ?? 30_000) * 2 ** Math.max(0, attempts - 1)); }
  #diagnostic(method: string): void { if (this.#unknown.has(method) || this.#unknown.size >= 100) return; this.#unknown.add(method); this.registry.emit("log", `Codex app-server ignored unknown protocol event: ${method}`); }
}
