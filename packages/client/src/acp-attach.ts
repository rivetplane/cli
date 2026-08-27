import type { ApprovalScope, JsonValue, Session } from "@rivetplane/shared/model";
import { EventEmitter } from "node:events";
import type { AcpSessionDescriptor } from "./discovery.js";
import { normalizeApprovalInput } from "./pending-normalization.js";
import { SessionRegistry } from "./registry.js";
import { JsonRpcPeer } from "./rpc.js";

type ObjectValue = Record<string, unknown>;
interface DeferredPending {
  id: string;
  kind: "approval" | "question";
  options?: Array<{ optionId: string; kind?: string; name?: string }>;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function object(value: unknown): ObjectValue { return typeof value === "object" && value !== null ? value as ObjectValue : {}; }
function string(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
function json(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(value)) as JsonValue; } catch { return String(value); }
}
function summary(value: unknown): string {
  if (typeof value === "string") return value;
  try { const text = JSON.stringify(value); return text.length > 500 ? `${text.slice(0, 497)}...` : text; } catch { return String(value); }
}

export class ACPAttach extends EventEmitter {
  #peer: JsonRpcPeer | undefined;
  #pending: DeferredPending | undefined;
  #closed = false;

  constructor(readonly descriptor: AcpSessionDescriptor, private readonly registry: SessionRegistry, private readonly machineId = "local") { super(); }

  get connected(): boolean { return this.#peer !== undefined; }

  async connect(): Promise<void> {
    this.#closed = false;
    const peer = await JsonRpcPeer.connect(this.descriptor.transport);
    this.#peer = peer;
    peer.on("warning", (error) => this.registry.emit("warning", error));
    peer.on("close", (error) => this.#onClose(error as Error));
    peer.onNotification("session/update", (params) => this.#onUpdate(params));
    peer.onRequest("session/request_permission", (params) => this.#onPermission(params));
    peer.onRequest("session/requestPermission", (params) => this.#onPermission(params));
    peer.onRequest("session/request_input", (params) => this.#onQuestion(params, "input"));
    peer.onRequest("elicitation/create", (params) => this.#onQuestion(params, "elicitation"));

    await peer.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "harness-cp", title: "Harness Control Plane", version: "0.1.0" },
    });
    const now = new Date().toISOString();
    const old = this.registry.get(this.descriptor.session_id);
    const session: Session = {
      id: this.descriptor.session_id,
      machine_id: old?.machine_id ?? this.machineId,
      harness_type: this.descriptor.harness_type,
      cwd: this.descriptor.cwd,
      status: old?.status === "completed" ? "completed" : "running",
      created_at: old?.created_at ?? this.descriptor.created_at ?? now,
      last_activity_at: old?.last_activity_at ?? now,
      pending: old?.pending ?? null,
    };
    this.registry.upsert(session);
    await this.#loadSession(peer);
    if (this.registry.get(this.descriptor.session_id)?.status === "running") this.registry.setStatus(this.descriptor.session_id, "waiting_input", "attached");
  }

  async #loadSession(peer: JsonRpcPeer): Promise<void> {
    const params = { sessionId: this.descriptor.session_id, cwd: this.descriptor.cwd, mcpServers: [] };
    try { await peer.request("session/load", params); }
    catch (loadError) {
      try { await peer.request("session/resume", params); }
      catch { throw loadError; }
    }
  }

  async sendMessage(text: string): Promise<void> {
    const peer = this.#requirePeer();
    this.registry.append(this.descriptor.session_id, "user_message", { text });
    this.registry.setStatus(this.descriptor.session_id, "running");
    try {
      const response = object(await peer.request("session/prompt", {
        sessionId: this.descriptor.session_id,
        prompt: [{ type: "text", text }],
      }));
      const reason = string(response.stopReason, "end_turn");
      this.registry.setStatus(this.descriptor.session_id, reason === "refusal" ? "error" : "waiting_input", reason);
    } catch (error) {
      this.registry.setStatus(this.descriptor.session_id, "error", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  interrupt(): void {
    this.#requirePeer().notify("session/cancel", { sessionId: this.descriptor.session_id });
    this.registry.setStatus(this.descriptor.session_id, "waiting_input", "interrupted");
  }

  respondToPending(pendingId: string, response: string, scope?: ApprovalScope): void {
    const pending = this.#pending;
    if (!pending || pending.id !== pendingId) throw new Error(`Pending interaction ${pendingId} is no longer active`);
    if (pending.kind === "approval") {
      const normalized = response.toLowerCase();
      const deny = normalized === "deny" || normalized === "reject";
      const option = pending.options?.find((item) => item.optionId === response)
        ?? pending.options?.find((item) => {
          const kind = `${item.kind ?? ""} ${item.name ?? ""}`.toLowerCase();
          if (deny) return kind.includes("reject") || kind.includes("deny");
          if (scope && scope !== "once") return kind.includes("always");
          return kind.includes("allow") || kind.includes("approve");
        });
      if (!option && !deny) throw new Error("The harness did not provide a matching approval option");
      this.#pending = undefined;
      if (option) pending.resolve({ outcome: { outcome: "selected", optionId: option.optionId } });
      else pending.resolve({ outcome: { outcome: "cancelled" } });
      this.registry.append(this.descriptor.session_id, "permission_response", {
        approval_id: pendingId,
        resolution: deny ? "deny" : "approve",
        ...(scope ? { scope } : {}),
      });
    } else {
      this.#pending = undefined;
      pending.resolve({ response, action: "accept", content: { response } });
    }
    this.registry.setPending(this.descriptor.session_id, null);
    this.registry.setStatus(this.descriptor.session_id, "running");
  }

  close(): void { this.#closed = true; this.#peer?.close(); this.#peer = undefined; }

  #onPermission(value: unknown): Promise<unknown> {
    const params = object(value);
    if (string(params.sessionId) !== this.descriptor.session_id) throw new Error("Permission request has the wrong session ID");
    const toolCall = object(params.toolCall);
    const id = string(toolCall.toolCallId) || string(params.toolCallId) || `permission-${Date.now()}`;
    const options = Array.isArray(params.options) ? params.options.map((value) => object(value)).map((item) => ({
      optionId: string(item.optionId),
      ...(string(item.kind) ? { kind: string(item.kind) } : {}),
      ...(string(item.name) ? { name: string(item.name) } : {}),
    })).filter((item) => item.optionId) : [];
    if (this.#pending) this.#pending.reject(new Error("A newer pending interaction replaced this request"));
    const rawInput = toolCall.rawInput ?? toolCall.content ?? toolCall; const details = normalizeApprovalInput(rawInput);
    this.registry.setPending(this.descriptor.session_id, {
      type: "approval", id, session_id: this.descriptor.session_id,
      tool_name: string(toolCall.title) || string(toolCall.kind, "tool"),
      tool_input_summary: details.summary, ...(details.command ? { command: details.command } : {}), ...(details.description ? { description: details.description } : {}),
      source: "acp", response_mode: "remote", requested_at: new Date().toISOString(),
    });
    this.registry.append(this.descriptor.session_id, "permission_request", {
      approval_id: id,
      tool_name: string(toolCall.title) || string(toolCall.kind, "tool"),
      tool_input_summary: summary(toolCall.rawInput ?? toolCall.content ?? toolCall),
    });
    this.registry.setStatus(this.descriptor.session_id, "waiting_approval");
    return new Promise((resolve, reject) => { this.#pending = { id, kind: "approval", options, resolve, reject }; });
  }

  #onQuestion(value: unknown, method: "input" | "elicitation"): Promise<unknown> {
    const params = object(value);
    const id = string(params.id) || `question-${Date.now()}`;
    const prompt = string(params.prompt) || string(params.message, "Input required");
    const options = Array.isArray(params.options) ? params.options.filter((item): item is string => typeof item === "string") : undefined;
    this.registry.setPending(this.descriptor.session_id, {
      type: "question", id, session_id: this.descriptor.session_id, prompt,
      ...(options ? { options } : {}), source: "acp", response_mode: "remote", requested_at: new Date().toISOString(),
    });
    this.registry.setStatus(this.descriptor.session_id, "waiting_input");
    return new Promise((resolve, reject) => { this.#pending = { id, kind: "question", resolve: method === "elicitation" ? (answer) => resolve(answer) : resolve, reject }; });
  }

  #onUpdate(value: unknown): void {
    const params = object(value);
    if (string(params.sessionId) !== this.descriptor.session_id) return;
    const update = object(params.update);
    const kind = string(update.sessionUpdate) || string(update.type);
    if (kind === "agent_message_chunk") {
      const content = object(update.content); if (content.type === "text") this.registry.append(this.descriptor.session_id, "agent_message", { text: string(content.text) });
    } else if (kind === "user_message_chunk") {
      const content = object(update.content); if (content.type === "text") this.registry.append(this.descriptor.session_id, "user_message", { text: string(content.text) });
    } else if (kind === "tool_call") {
      const rawInput = update.rawInput;
      this.registry.append(this.descriptor.session_id, "tool_call", {
        tool_call_id: string(update.toolCallId), tool_name: string(update.title) || string(update.kind, "tool"),
        input_summary: summary(rawInput ?? update.content ?? update), ...(json(rawInput) !== undefined ? { input: json(rawInput)! } : {}),
      });
    } else if (kind === "tool_call_update" && (update.status === "completed" || update.status === "failed")) {
      const rawOutput = update.rawOutput;
      this.registry.append(this.descriptor.session_id, "tool_result", {
        tool_call_id: string(update.toolCallId), output_summary: summary(rawOutput ?? update.content ?? update),
        ...(json(rawOutput) !== undefined ? { output: json(rawOutput)! } : {}), is_error: update.status === "failed",
      });
    }
  }

  #onClose(error: Error): void {
    this.#peer = undefined;
    this.#pending?.reject(error); this.#pending = undefined;
    if (!this.#closed && this.registry.get(this.descriptor.session_id)) this.registry.setStatus(this.descriptor.session_id, "error", "ACP connection closed");
    if (!this.#closed) this.emit("close", error);
  }
  #requirePeer(): JsonRpcPeer { if (!this.#peer) throw new Error(`Session ${this.descriptor.session_id} is not attached`); return this.#peer; }
}
