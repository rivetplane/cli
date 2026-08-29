import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { createOpencodeServer } from "@opencode-ai/sdk/v2/server";
import { createServer } from "node:net";
import type { Event as OpenCodeEvent, Part, PermissionRequest, PermissionV2Request, QuestionRequest, QuestionV2Request, Session as OpenCodeSession, SessionStatus as OpenCodeSessionStatus } from "@opencode-ai/sdk/v2/client";
import type { ApprovalScope, SessionStatus } from "@rivetplane/shared/model";
import type { CreateSessionCommand, HarnessCapabilities } from "@rivetplane/shared/protocol";
import type { CommandTarget } from "./relay.js";
import { SessionRegistry } from "./registry.js";
import type { HarnessDiscoveryStatus } from "./session-manager.js";
import type { RawUsageSample, UsageCollector } from "./usage.js";

type SdkResult<T> = { data?: T; error?: unknown };

type PendingPermission = (PermissionRequest & { api: "legacy" }) | (PermissionV2Request & { api: "v2" });
type PendingQuestion = (QuestionRequest & { api: "legacy" }) | (QuestionV2Request & { api: "v2" });

function unwrap<T>(result: SdkResult<T>, operation: string): T {
  if (result.error) throw new Error(`OpenCode ${operation} failed: ${result.error instanceof Error ? result.error.message : JSON.stringify(result.error)}`);
  if (result.data === undefined) throw new Error(`OpenCode ${operation} returned no data`);
  return result.data;
}

function iso(value: number | undefined): string { return new Date(value ?? Date.now()).toISOString(); }
function summary(value: unknown, limit = 500): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? "").length > limit ? `${(text ?? "").slice(0, limit)}…` : (text ?? "");
}

function mapStatus(status: OpenCodeSessionStatus | undefined): SessionStatus {
  if (!status || status.type === "idle") return "waiting_input";
  if (status.type === "busy") return "running";
  return "error";
}

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate an OpenCode port");
  }
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

export interface OpenCodeManagerOptions {
  url?: string;
  directory?: string;
  interval_ms?: number;
  client?: OpencodeClient;
  server_factory?: typeof createOpencodeServer;
  port_factory?: () => Promise<number>;
  usage?: UsageCollector;
}

type ObjectValue = Record<string, unknown>;
function objectValue(value: unknown): ObjectValue | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined; }
function finiteNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }

export function openCodeMessageUsage(sessionId: string, raw: unknown, contextWindow?: number): RawUsageSample | undefined {
  const info = objectValue(raw); const messageId = stringValue(info?.id); const usage = objectValue(info?.tokens); if (!info || !messageId || !usage) return undefined;
  const cache = objectValue(usage.cache); const input = finiteNumber(usage.input); const output = finiteNumber(usage.output); const reasoning = finiteNumber(usage.reasoning);
  const cacheRead = finiteNumber(cache?.read ?? usage.cacheRead); const cacheWrite = finiteNumber(cache?.write ?? usage.cacheWrite);
  const values = [input, output, reasoning, cacheRead, cacheWrite]; const total = values.some((value) => value !== undefined) ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : undefined;
  const model = objectValue(info.model); const provider = stringValue(info.providerID ?? model?.providerID); const modelId = stringValue(info.modelID ?? model?.modelID ?? model?.id); const cost = finiteNumber(info.cost);
  const time = objectValue(info.time); const created = finiteNumber(time?.completed ?? time?.created);
  return { session_id: sessionId, ...(created !== undefined ? { timestamp: new Date(created).toISOString() } : {}), harness: "opencode", ...(provider ? { provider } : {}), ...(modelId ? { model: modelId } : {}), source: "opencode-sdk:message", source_event_id: messageId,
    source_counter_mode: "incremental", tokens: { input, output, reasoning, cache_read: cacheRead, cache_write: cacheWrite, total }, ...(contextWindow !== undefined ? { context: { window_size: contextWindow } } : {}), cost: cost !== undefined ? { status: "reported", amount: cost, currency: "USD" } : { status: "unavailable" } };
}

export class OpenCodeManager {
  readonly directory: string;
  #url: string | undefined;
  #client: OpencodeClient | undefined;
  #server: Awaited<ReturnType<typeof createOpencodeServer>> | undefined;
  #nextLaunchAttempt = 0;
  #timer: NodeJS.Timeout | undefined;
  #polling = false;
  #online = false;
  #sessions = new Map<string, OpenCodeSession>();
  #parts = new Map<string, string>();
  #permissions = new Map<string, PendingPermission>();
  #questions = new Map<string, PendingQuestion>();
  #lastError = "";
  #capabilities: HarnessCapabilities | undefined;
  #capabilitiesAt = 0;
  #eventAbort: AbortController | undefined;
  #eventTask: Promise<void> | undefined;

  constructor(readonly machine_id: string, readonly registry: SessionRegistry, private readonly options: OpenCodeManagerOptions = {}) {
    this.#url = options.url;
    this.directory = options.directory ?? process.cwd();
    this.#client = options.client ?? (options.url ? createOpencodeClient({ baseUrl: options.url }) : undefined);
  }

  get url(): string { return this.#url ?? "automatic"; }

  async start(): Promise<void> {
    await this.poll();
    this.#timer = setInterval(() => void this.poll(), this.options.interval_ms ?? 2_000);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#server?.close();
    this.#server = undefined;
    this.#eventAbort?.abort(); this.#eventAbort = undefined; this.#eventTask = undefined;
    if (!this.options.url && !this.options.client) { this.#client = undefined; this.#url = undefined; }
  }
  target(id: string): CommandTarget | undefined { return this.#sessions.has(id) ? new OpenCodeTarget(this, id) : undefined; }
  harnesses(): HarnessDiscoveryStatus[] {
    return this.#online ? [{ harness_type: "opencode", discovered_sessions: this.#sessions.size, attached_sessions: this.#sessions.size }] : [];
  }
  capabilities(): HarnessCapabilities | undefined { return this.#capabilities ? structuredClone(this.#capabilities) : undefined; }

  async createSession(command: CreateSessionCommand): Promise<string> {
    const client = this.#requireClient();
    const capabilities = this.#capabilities;
    if (!capabilities?.can_create_session) throw new Error("OpenCode session creation is not available");
    if (command.cwd !== this.directory) throw new Error("cwd is outside this OpenCode client scope");
    if (!capabilities.models.some((model) => model.provider_id === command.model.provider_id && model.model_id === command.model.model_id)) throw new Error("Model is not in the OpenCode roster");
    const session = unwrap(await client.session.create({ directory: command.cwd, ...(command.title ? { title: command.title } : {}),
      model: { providerID: command.model.provider_id, id: command.model.model_id } }), "session create");
    await this.#syncSession(session, { type: "idle" });
    return session.id;
  }

  async poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      const client = await this.#ensureClient();
      if (!client) return;
      unwrap(await client.global.health(), "health check");
      if (!this.#online) this.registry.emit("log", `OpenCode server found: ${this.url}`);
      this.#online = true; this.#lastError = "";
      this.#ensureEventStream(client);
      if (!this.#capabilities || Date.now() - this.#capabilitiesAt > 60_000) await this.#refreshCapabilities();
      const [sessions, statuses] = await Promise.all([
        client.session.list({ directory: this.directory }).then((result) => unwrap(result, "session list")),
        client.session.status().then((result) => unwrap(result, "session status")),
      ]);
      const [permissions, questions] = await Promise.all([
        this.#listPermissions(client, sessions),
        this.#listQuestions(client, sessions),
      ]);
      const active = new Set(sessions.map((session) => session.id));
      for (const id of this.#sessions.keys()) if (!active.has(id)) this.#sessions.delete(id);
      for (const session of sessions) await this.#syncSession(session, statuses[session.id]);
      this.#syncPending(permissions, questions);
    } catch (error) {
      this.#online = false;
      const message = error instanceof Error ? error.message : String(error);
      if (this.#lastError !== message && this.#sessions.size > 0) this.registry.emit("warning", new Error(message));
      this.#lastError = message;
      if (this.#server && !this.options.url && !this.options.client) {
        this.#server.close();
        this.#server = undefined;
        this.#client = undefined;
        this.#url = undefined;
        this.#nextLaunchAttempt = Date.now() + 2_000;
      }
    } finally { this.#polling = false; }
  }

  #ensureEventStream(client: OpencodeClient): void {
    if (this.#eventTask) return;
    const controller = new AbortController(); this.#eventAbort = controller;
    this.#eventTask = (async () => {
      const subscription = await client.event.subscribe({ directory: this.directory }, { signal: controller.signal });
      for await (const event of subscription.stream) await this.#nativeEvent(event as OpenCodeEvent);
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) this.registry.emit("warning", new Error(`OpenCode event stream ended: ${error instanceof Error ? error.message : String(error)}`));
    }).finally(() => { if (this.#eventAbort === controller) { this.#eventAbort = undefined; this.#eventTask = undefined; } });
  }

  async #nativeEvent(event: OpenCodeEvent): Promise<void> {
    if (event.type === "permission.asked") {
      const permission: PendingPermission = { ...event.properties, api: "legacy" };
      this.#permissions.set(permission.id, permission); this.#syncPending([...this.#permissions.values()], [...this.#questions.values()]); return;
    }
    if (event.type === "question.asked") {
      const question: PendingQuestion = { ...event.properties, api: "legacy" };
      this.#questions.set(question.id, question); this.#syncPending([...this.#permissions.values()], [...this.#questions.values()]); return;
    }
    if (event.type === "permission.replied" || event.type === "question.replied" || event.type === "question.rejected") {
      const requestId = event.properties.requestID; this.#permissions.delete(requestId); this.#questions.delete(requestId);
      const session = this.registry.get(event.properties.sessionID);
      if (session?.pending?.id === requestId) { this.registry.setPending(session.id, null); this.registry.setStatus(session.id, "running"); }
      return;
    }
    if (event.type === "session.status") {
      const session = this.registry.get(event.properties.sessionID); if (session && !session.pending) this.registry.setStatus(session.id, mapStatus(event.properties.status)); return;
    }
    if (event.type === "session.idle") {
      const session = this.registry.get(event.properties.sessionID); if (session && !session.pending) this.registry.setStatus(session.id, "waiting_input"); return;
    }
    if (event.type === "message.updated" || event.type === "message.part.updated" || event.type === "session.created" || event.type === "session.updated") queueMicrotask(() => void this.poll());
  }

  async #refreshCapabilities(): Promise<void> {
    const roster = unwrap(await this.#requireClient().provider.list({ directory: this.directory }), "provider list");
    const connected = new Set(roster.connected);
    const models = roster.all.filter((provider) => connected.has(provider.id)).flatMap((provider) => Object.values(provider.models).map((model) => ({
      provider_id: provider.id, model_id: model.id, name: `${provider.name} — ${model.name}`, status: model.status,
      context_limit: model.limit.context, output_limit: model.limit.output,
    }))).sort((a, b) => a.name.localeCompare(b.name));
    this.#capabilities = { machine_id: this.machine_id, harness_type: "opencode", can_create_session: true,
      directories: [this.directory], models, reported_at: new Date().toISOString(), transport: "opencode-http-sse",
      session_capabilities: {
        persisted_discovery: { supported: true, mode: "read_write" },
        discovery: { supported: true, mode: "read_write" },
        transcript: { supported: true, mode: "read_write" },
        live_attachment: { supported: true, mode: "read_write" },
        messaging: { supported: true, mode: "read_write" },
        interrupt: { supported: true, mode: "read_write" },
        question_response: { supported: true, mode: "read_write" },
        approval_response: { supported: true, mode: "read_write" },
      } };
    this.#capabilitiesAt = Date.now();
  }

  async sendMessage(id: string, text: string): Promise<void> {
    const session = this.#require(id);
    this.registry.setStatus(id, "running");
    const result = await this.#requireClient().session.promptAsync({ sessionID: id, directory: session.directory, parts: [{ type: "text", text }] });
    if (result.error) throw new Error(`OpenCode send message failed: ${result.error instanceof Error ? result.error.message : JSON.stringify(result.error)}`);
  }

  async interrupt(id: string): Promise<void> {
    const session = this.#require(id);
    unwrap(await this.#requireClient().session.abort({ sessionID: id, directory: session.directory }), "interrupt");
    this.registry.setStatus(id, "waiting_input");
  }

  async respondToPending(id: string, pendingId: string, response: string, scope?: ApprovalScope): Promise<void> {
    const session = this.#require(id); const pending = this.registry.get(id)?.pending;
    if (!pending || pending.id !== pendingId) throw new Error(`Pending interaction ${pendingId} is no longer active`);
    if (pending.type === "approval") {
      const reply = response === "deny" ? "reject" : scope === "once" || !scope ? "once" : "always";
      const request = this.#permissions.get(pendingId);
      if (!request) throw new Error(`Permission ${pendingId} is no longer active`);
      if (request.api === "v2") {
        unwrap(await this.#requireClient().v2.session.permission.reply({ sessionID: id, requestID: pendingId, reply }), "V2 permission reply");
      } else {
        unwrap(await this.#requireClient().permission.reply({ requestID: pendingId, directory: session.directory, reply }), "permission reply");
      }
      this.#permissions.delete(pendingId);
      this.registry.append(id, "permission_response", { approval_id: pendingId, resolution: response === "deny" ? "deny" : "approve", ...(scope ? { scope } : {}) });
    } else {
      const request = this.#questions.get(pendingId);
      if (!request) throw new Error(`Question ${pendingId} is no longer active`);
      const answers = decodeQuestionAnswers(response, request.questions.length);
      if (request.api === "v2") {
        unwrap(await this.#requireClient().v2.session.question.reply({
          sessionID: id,
          requestID: pendingId,
          questionV2Reply: { answers },
        }), "V2 question reply");
      } else {
        unwrap(await this.#requireClient().question.reply({ requestID: pendingId, directory: session.directory, answers }), "question reply");
      }
      this.#questions.delete(pendingId);
    }
    this.registry.setPending(id, null); this.registry.setStatus(id, "running");
  }

  async #syncSession(session: OpenCodeSession, status: OpenCodeSessionStatus | undefined): Promise<void> {
    const first = !this.#sessions.has(session.id); this.#sessions.set(session.id, session);
    const current = this.registry.get(session.id);
    this.registry.upsert({
      id: session.id, machine_id: this.machine_id, harness_type: "opencode", cwd: session.directory,
      status: current?.pending?.type === "approval" ? "waiting_approval" : current?.pending?.type === "question" ? "waiting_input" : mapStatus(status),
      created_at: iso(session.time.created), last_activity_at: iso(session.time.updated), pending: current?.pending ?? null,
    }, { authority: 100 });
    if (first) this.registry.emit("log", `Harness attached: opencode (${session.id})`);
    const messages = unwrap(await this.#requireClient().session.messages({ sessionID: session.id, directory: session.directory }), `messages for ${session.id}`);
    for (const message of messages) {
      const info = message.info as unknown; const parsed = objectValue(info); const model = objectValue(parsed?.model); const provider = stringValue(parsed?.providerID ?? model?.providerID); const modelId = stringValue(parsed?.modelID ?? model?.modelID ?? model?.id);
      const window = this.#capabilities?.models.find((entry) => entry.provider_id === provider && entry.model_id === modelId)?.context_limit;
      const usage = openCodeMessageUsage(session.id, info, window); if (usage) this.options.usage?.ingest(usage);
      this.#syncParts(session.id, message.info.role, message.parts);
    }
  }

  #syncParts(sessionId: string, role: "user" | "assistant", parts: Part[]): void {
    for (const part of parts) {
      const key = `${sessionId}/${part.messageID}/${part.id}`;
      if (part.type === "text") {
        const prior = this.#parts.get(key) ?? "";
        if (part.text !== prior) {
          const text = part.text.startsWith(prior) ? part.text.slice(prior.length) : part.text;
          if (text) this.registry.append(sessionId, role === "user" ? "user_message" : "agent_message", { text });
          this.#parts.set(key, part.text);
        }
      } else if (part.type === "tool") this.#syncTool(sessionId, key, part);
    }
  }

  #syncTool(sessionId: string, key: string, part: Extract<Part, { type: "tool" }>): void {
    const prior = this.#parts.get(key);
    if (!prior) this.registry.append(sessionId, "tool_call", { tool_call_id: part.callID, tool_name: part.tool, input_summary: summary(part.state.input) });
    if (prior !== part.state.status && part.state.status === "completed") this.registry.append(sessionId, "tool_result", { tool_call_id: part.callID, output_summary: summary(part.state.output), is_error: false });
    if (prior !== part.state.status && part.state.status === "error") this.registry.append(sessionId, "tool_result", { tool_call_id: part.callID, output_summary: summary(part.state.error), is_error: true });
    this.#parts.set(key, part.state.status);
  }

  async #listPermissions(client: OpencodeClient, sessions: OpenCodeSession[]): Promise<PendingPermission[]> {
    const directories = [...new Set(sessions.map((session) => session.directory))];
    const [legacyResults, v2Results] = await Promise.all([
      Promise.all(directories.map((directory) => client.permission.list({ directory }))),
      Promise.all(directories.map((directory) => client.v2.permission.request.list({ location: { directory } }))),
    ]);
    if (sessions.length > 0 && legacyResults.every((result) => result.error) && v2Results.every((result) => result.error)) {
      throw new Error("OpenCode permission list failed for both legacy and V2 APIs");
    }
    const permissions = new Map<string, PendingPermission>();
    for (const result of legacyResults) {
      if (!result.error) for (const permission of result.data ?? []) permissions.set(permission.id, { ...permission, api: "legacy" });
    }
    for (const result of v2Results) {
      if (!result.error) for (const permission of result.data?.data ?? []) permissions.set(permission.id, { ...permission, api: "v2" });
    }
    return [...permissions.values()];
  }

  async #listQuestions(client: OpencodeClient, sessions: OpenCodeSession[]): Promise<PendingQuestion[]> {
    const directories = [...new Set(sessions.map((session) => session.directory))];
    const [legacyResults, v2Results] = await Promise.all([
      Promise.all(directories.map((directory) => client.question.list({ directory }))),
      Promise.all(directories.map((directory) => client.v2.question.request.list({ location: { directory } }))),
    ]);
    if (sessions.length > 0 && legacyResults.every((result) => result.error) && v2Results.every((result) => result.error)) {
      throw new Error("OpenCode question list failed for both legacy and V2 APIs");
    }
    const questions = new Map<string, PendingQuestion>();
    for (const result of legacyResults) {
      if (!result.error) for (const question of result.data ?? []) questions.set(question.id, { ...question, api: "legacy" });
    }
    for (const result of v2Results) {
      if (!result.error) for (const question of result.data?.data ?? []) questions.set(question.id, { ...question, api: "v2" });
    }
    return [...questions.values()];
  }

  #syncPending(permissions: PendingPermission[], questions: PendingQuestion[]): void {
    const byPermission = new Map(permissions.map((item) => [item.sessionID, item]));
    const byQuestion = new Map(questions.map((item) => [item.sessionID, item]));
    this.#permissions = new Map(permissions.map((item) => [item.id, item]));
    this.#questions = new Map(questions.map((item) => [item.id, item]));
    for (const id of this.#sessions.keys()) {
      const current = this.registry.get(id)?.pending; const permission = byPermission.get(id); const question = byQuestion.get(id);
      if (permission) {
        if (current?.id !== permission.id) {
          const toolName = permission.api === "v2" ? permission.action : permission.permission || "tool";
          const input = (permission.api === "v2" ? permission.resources : permission.patterns).join(", ");
          this.registry.setPending(id, { type: "approval", id: permission.id, session_id: id, tool_name: toolName, tool_input_summary: input, source: "opencode-sdk", response_mode: "remote", requested_at: new Date().toISOString() });
          this.registry.append(id, "permission_request", { approval_id: permission.id, tool_name: toolName, tool_input_summary: input });
        }
        this.registry.setStatus(id, "waiting_approval");
      } else if (question) {
        if (current?.id !== question.id) this.registry.setPending(id, {
          type: "question", id: question.id, session_id: id,
          prompt: question.questions.map((item) => `${item.header}: ${item.question}`).join("\n"),
          options: question.questions.flatMap((item) => item.options.map((option) => option.label)), source: "opencode-sdk", response_mode: "remote", requested_at: new Date().toISOString(),
        });
        this.registry.setStatus(id, "waiting_input");
      } else if (current) this.registry.setPending(id, null);
    }
  }

  #require(id: string): OpenCodeSession { const session = this.#sessions.get(id); if (!session) throw new Error(`OpenCode session is not attached: ${id}`); return session; }

  #requireClient(): OpencodeClient {
    if (!this.#client) throw new Error("OpenCode server is not available");
    return this.#client;
  }

  async #ensureClient(): Promise<OpencodeClient | undefined> {
    if (this.#client) return this.#client;
    if (Date.now() < this.#nextLaunchAttempt) return undefined;
    this.#nextLaunchAttempt = Date.now() + 30_000;
    try {
      const launch = this.options.server_factory ?? createOpencodeServer;
      const port = await (this.options.port_factory ?? availableLoopbackPort)();
      this.#server = await launch({ hostname: "127.0.0.1", port, timeout: 10_000 });
      this.#url = this.#server.url;
      this.#client = createOpencodeClient({ baseUrl: this.#url });
      this.registry.emit("log", `OpenCode available; started loopback server: ${this.#url}`);
      this.registry.emit("log", `OpenCode TUI: opencode attach ${this.#url}`);
      return this.#client;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.#lastError !== message) this.registry.emit("log", `OpenCode is not available for automatic startup: ${message}`);
      this.#lastError = message;
      return undefined;
    }
  }
}

class OpenCodeTarget implements CommandTarget {
  constructor(private readonly manager: OpenCodeManager, private readonly id: string) {}
  sendMessage(text: string): Promise<void> { return this.manager.sendMessage(this.id, text); }
  respondToPending(id: string, response: string, scope?: ApprovalScope): Promise<void> { return this.manager.respondToPending(this.id, id, response, scope); }
  interrupt(): Promise<void> { return this.manager.interrupt(this.id); }
}

function decodeQuestionAnswers(response: string, count: number): string[][] {
  try {
    const value = JSON.parse(response) as unknown;
    if (Array.isArray(value) && value.every((item) => Array.isArray(item) && item.every((answer) => typeof answer === "string"))) return Array.from({ length: count }, (_, index) => (value[index] as string[] | undefined) ?? []);
    if (count === 1 && Array.isArray(value) && value.every((item) => typeof item === "string")) return [value as string[]];
  } catch {}
  return Array.from({ length: count }, (_, index) => index === 0 ? [response] : []);
}
