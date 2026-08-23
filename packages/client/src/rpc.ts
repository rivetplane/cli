import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import WebSocket from "ws";
import type { AcpTransport } from "./discovery.js";

type JsonRpcId = number | string;
interface JsonRpcMessage { jsonrpc: "2.0"; id?: JsonRpcId; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } }
type RequestHandler = (params: unknown, id: JsonRpcId) => unknown | Promise<unknown>;
type NotificationHandler = (params: unknown) => void | Promise<void>;

interface Channel { send(value: string): void; close(): void; onMessage(handler: (value: string) => void): void; onClose(handler: (error?: Error) => void): void }

class WebSocketChannel implements Channel {
  constructor(private readonly socket: WebSocket) {}
  send(value: string): void { this.socket.send(value); }
  close(): void { this.socket.close(); }
  onMessage(handler: (value: string) => void): void { this.socket.on("message", (data) => handler(data.toString())); }
  onClose(handler: (error?: Error) => void): void { this.socket.on("close", () => handler()); this.socket.on("error", handler); }
}

class LineChannel implements Channel {
  #buffer = "";
  constructor(private readonly socket: Socket) {}
  send(value: string): void { this.socket.write(`${value}\n`); }
  close(): void { this.socket.destroy(); }
  onMessage(handler: (value: string) => void): void {
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => {
      this.#buffer += chunk;
      for (;;) { const offset = this.#buffer.indexOf("\n"); if (offset < 0) break; const line = this.#buffer.slice(0, offset).trim(); this.#buffer = this.#buffer.slice(offset + 1); if (line) handler(line); }
    });
  }
  onClose(handler: (error?: Error) => void): void { this.socket.on("close", () => handler()); this.socket.on("error", handler); }
}

async function connectChannel(transport: AcpTransport): Promise<Channel> {
  if (transport.kind === "websocket") {
    const socket = new WebSocket(transport.url, { headers: transport.headers });
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    return new WebSocketChannel(socket);
  }
  const socket = transport.kind === "unix" ? createConnection(transport.path) : createConnection(transport.port, transport.host);
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  return new LineChannel(socket);
}

export class JsonRpcPeer extends EventEmitter {
  #nextId = 1;
  #pending = new Map<JsonRpcId, { resolve(value: unknown): void; reject(error: Error): void }>();
  #requests = new Map<string, RequestHandler>();
  #notifications = new Map<string, NotificationHandler>();

  private constructor(private readonly channel: Channel) { super(); channel.onMessage((value) => void this.#receive(value)); channel.onClose((error) => this.#closed(error)); }
  static async connect(transport: AcpTransport): Promise<JsonRpcPeer> { return new JsonRpcPeer(await connectChannel(transport)); }
  onRequest(method: string, handler: RequestHandler): void { this.#requests.set(method, handler); }
  onNotification(method: string, handler: NotificationHandler): void { this.#notifications.set(method, handler); }
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.#nextId++;
    this.channel.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise<T>((resolve, reject) => this.#pending.set(id, { resolve: (value) => resolve(value as T), reject }));
  }
  notify(method: string, params?: unknown): void { this.channel.send(JSON.stringify({ jsonrpc: "2.0", method, params })); }
  close(): void { this.channel.close(); }

  async #receive(raw: string): Promise<void> {
    let message: JsonRpcMessage;
    try { message = JSON.parse(raw) as JsonRpcMessage; } catch { this.emit("warning", new Error("ACP sent invalid JSON")); return; }
    if (message.method && message.id !== undefined) {
      const handler = this.#requests.get(message.method);
      if (!handler) { this.#sendError(message.id, -32601, `Method not found: ${message.method}`); return; }
      try { const result = await handler(message.params, message.id); this.channel.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result })); }
      catch (error) { this.#sendError(message.id, -32000, error instanceof Error ? error.message : String(error)); }
      return;
    }
    if (message.method) { try { await this.#notifications.get(message.method)?.(message.params); } catch (error) { this.emit("warning", error); } return; }
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id); if (!pending) return; this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    }
  }
  #sendError(id: JsonRpcId, code: number, message: string): void { this.channel.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })); }
  #closed(error?: Error): void { const reason = error ?? new Error("ACP connection closed"); for (const item of this.#pending.values()) item.reject(reason); this.#pending.clear(); this.emit("close", reason); }
}
