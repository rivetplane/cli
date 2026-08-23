import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { Part, PermissionRequest, QuestionRequest, Session as OpenCodeSession, SessionStatus as OpenCodeSessionStatus } from "@opencode-ai/sdk/v2/client";
import type { ApprovalScope, SessionStatus } from "@rivetplane/shared/model";
import type { CreateSessionCommand, HarnessCapabilities } from "@rivetplane/shared/protocol";
import type { CommandTarget } from "./relay.js";
import { SessionRegistry } from "./registry.js";
import type { HarnessDiscoveryStatus } from "./session-manager.js";

type SdkResult<T> = { data?: T; error?: unknown };

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

export interface OpenCodeManagerOptions {
  url?: string;
  directory?: string;
  interval_ms?: number;
  client?: OpencodeClient;
}

export class OpenCodeManager {
  readonly url: string;
  readonly directory: string;
  #client: OpencodeClient;
  #timer: NodeJS.Timeout | undefined;
  #polling = false;
  #online = false;
  #sessions = new Map<string, OpenCodeSession>();
  #parts = new Map<string, string>();
  #questions = new Map<string, QuestionRequest>();
  #lastError = "";
  #capabilities: HarnessCapabilities | undefined;
  #capabilitiesAt = 0;

  constructor(readonly machine_id: string, readonly registry: SessionRegistry, private readonly options: OpenCodeManagerOptions = {}) {
    this.url = options.url ?? "http://localhost:4096";
    this.directory = options.directory ?? process.cwd();
    this.#client = options.client ?? createOpencodeClient({ baseUrl: this.url });
  }

  async start(): Promise<void> {
    await this.poll();
    this.#timer = setInterval(() => void this.poll(), this.options.interval_ms ?? 2_000);
    this.#timer.unref();
  }

  stop(): void { if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; }
  target(id: string): CommandTarget | undefined { return this.#sessions.has(id) ? new OpenCodeTarget(this, id) : undefined; }
  harnesses(): HarnessDiscoveryStatus[] {
    return this.#online ? [{ harness_type: "opencode", discovered_sessions: this.#sessions.size, attached_sessions: this.#sessions.size }] : [];
  }
  capabilities(): HarnessCapabilities | undefined { return this.#capabilities ? structuredClone(this.#capabilities) : undefined; }

  async createSession(command: CreateSessionCommand): Promise<string> {
    const capabilities = this.#capabilities;
    if (!capabilities?.can_create_session) throw new Error("OpenCode session creation is not available");
    if (command.cwd !== this.directory) throw new Error("cwd is outside this OpenCode client scope");
    if (!capabilities.models.some((model) => model.provider_id === command.model.provider_id && model.model_id === command.model.model_id)) throw new Error("Model is not in the OpenCode roster");
    const session = unwrap(await this.#client.session.create({ directory: command.cwd, ...(command.title ? { title: command.title } : {}),
      model: { providerID: command.model.provider_id, id: command.model.model_id } }), "session create");
    await this.#syncSession(session, { type: "idle" });
    return session.id;
  }

  async poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      unwrap(await this.#client.global.health(), "health check");
      if (!this.#online) this.registry.emit("log", `OpenCode server found: ${this.url}`);
      this.#online = true; this.#lastError = "";
      if (!this.#capabilities || Date.now() - this.#capabilitiesAt > 60_000) await this.#refreshCapabilities();
      const [sessions, statuses, permissions, questions] = await Promise.all([
        this.#client.session.list({ directory: this.directory }).then((result) => unwrap(result, "session list")),
        this.#client.session.status({ directory: this.directory }).then((result) => unwrap(result, "session status")),
        this.#client.permission.list({ directory: this.directory }).then((result) => unwrap(result, "permission list")),
        this.#client.question.list({ directory: this.directory }).then((result) => unwrap(result, "question list")),
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
    } finally { this.#polling = false; }
  }

  async #refreshCapabilities(): Promise<void> {
    const roster = unwrap(await this.#client.provider.list({ directory: this.directory }), "provider list");
    const connected = new Set(roster.connected);
    const models = roster.all.filter((provider) => connected.has(provider.id)).flatMap((provider) => Object.values(provider.models).map((model) => ({
      provider_id: provider.id, model_id: model.id, name: `${provider.name} — ${model.name}`, status: model.status,
      context_limit: model.limit.context, output_limit: model.limit.output,
    }))).sort((a, b) => a.name.localeCompare(b.name));
    this.#capabilities = { machine_id: this.machine_id, harness_type: "opencode", can_create_session: true,
      directories: [this.directory], models, reported_at: new Date().toISOString() };
    this.#capabilitiesAt = Date.now();
  }

  async sendMessage(id: string, text: string): Promise<void> {
    const session = this.#require(id);
    this.registry.setStatus(id, "running");
    const result = await this.#client.session.promptAsync({ sessionID: id, directory: session.directory, parts: [{ type: "text", text }] });
    if (result.error) throw new Error(`OpenCode send message failed: ${result.error instanceof Error ? result.error.message : JSON.stringify(result.error)}`);
  }

  async interrupt(id: string): Promise<void> {
    const session = this.#require(id);
    unwrap(await this.#client.session.abort({ sessionID: id, directory: session.directory }), "interrupt");
    this.registry.setStatus(id, "waiting_input");
  }

  async respondToPending(id: string, pendingId: string, response: string, scope?: ApprovalScope): Promise<void> {
    const session = this.#require(id); const pending = this.registry.get(id)?.pending;
    if (!pending || pending.id !== pendingId) throw new Error(`Pending interaction ${pendingId} is no longer active`);
    if (pending.type === "approval") {
      const reply = response === "deny" ? "reject" : scope === "once" || !scope ? "once" : "always";
      unwrap(await this.#client.permission.reply({ requestID: pendingId, directory: session.directory, reply }), "permission reply");
      this.registry.append(id, "permission_response", { approval_id: pendingId, resolution: response === "deny" ? "deny" : "approve", ...(scope ? { scope } : {}) });
    } else {
      const request = this.#questions.get(pendingId);
      if (!request) throw new Error(`Question ${pendingId} is no longer active`);
      const answers = request.questions.map((_, index) => index === 0 ? [response] : []);
      unwrap(await this.#client.question.reply({ requestID: pendingId, directory: session.directory, answers }), "question reply");
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
    });
    if (first) this.registry.emit("log", `Harness attached: opencode (${session.id})`);
    const messages = unwrap(await this.#client.session.messages({ sessionID: session.id, directory: session.directory }), `messages for ${session.id}`);
    for (const message of messages) this.#syncParts(session.id, message.info.role, message.parts);
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

  #syncPending(permissions: PermissionRequest[], questions: QuestionRequest[]): void {
    const byPermission = new Map(permissions.map((item) => [item.sessionID, item]));
    const byQuestion = new Map(questions.map((item) => [item.sessionID, item]));
    this.#questions = new Map(questions.map((item) => [item.id, item]));
    for (const id of this.#sessions.keys()) {
      const current = this.registry.get(id)?.pending; const permission = byPermission.get(id); const question = byQuestion.get(id);
      if (permission) {
        if (current?.id !== permission.id) {
          const toolName = permission.permission || "tool"; const input = permission.patterns.join(", ");
          this.registry.setPending(id, { type: "approval", id: permission.id, session_id: id, tool_name: toolName, tool_input_summary: input, requested_at: new Date().toISOString() });
          this.registry.append(id, "permission_request", { approval_id: permission.id, tool_name: toolName, tool_input_summary: input });
        }
        this.registry.setStatus(id, "waiting_approval");
      } else if (question) {
        if (current?.id !== question.id) this.registry.setPending(id, {
          type: "question", id: question.id, session_id: id,
          prompt: question.questions.map((item) => `${item.header}: ${item.question}`).join("\n"),
          options: question.questions.flatMap((item) => item.options.map((option) => option.label)), requested_at: new Date().toISOString(),
        });
        this.registry.setStatus(id, "waiting_input");
      } else if (current) this.registry.setPending(id, null);
    }
  }

  #require(id: string): OpenCodeSession { const session = this.#sessions.get(id); if (!session) throw new Error(`OpenCode session is not attached: ${id}`); return session; }
}

class OpenCodeTarget implements CommandTarget {
  constructor(private readonly manager: OpenCodeManager, private readonly id: string) {}
  sendMessage(text: string): Promise<void> { return this.manager.sendMessage(this.id, text); }
  respondToPending(id: string, response: string, scope?: ApprovalScope): Promise<void> { return this.manager.respondToPending(this.id, id, response, scope); }
  interrupt(): Promise<void> { return this.manager.interrupt(this.id); }
}
