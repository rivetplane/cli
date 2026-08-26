import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type { CommandTarget } from "./relay.js";
import { SessionRegistry } from "./registry.js";
import type { HarnessDiscoveryStatus } from "./session-manager.js";
import type { HookIngestor } from "./hook-ingestion.js";
import { createHookToken, defaultHookDiscoveryPath, HOOK_OWNER, removeHookDiscovery, secretEquals, writeHookDiscovery } from "./hook-discovery.js";

interface LocalApiOptions { port?: number; host?: "127.0.0.1" | "::1"; target(id: string): CommandTarget | undefined; harnesses?: () => HarnessDiscoveryStatus[]; discovery_directory?: string; hooks?: HookIngestor; hook_discovery_path?: string; hook_token?: string }

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(`${JSON.stringify(value)}\n`);
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let value = ""; for await (const chunk of request) { value += chunk; if (value.length > 1_000_000) throw new Error("Request body is too large"); }
  return value ? JSON.parse(value) as Record<string, unknown> : {};
}

export class LocalApi {
  #clients = new Set<WebSocket>();
  #server = createServer((request, response) => void this.#handle(request, response));
  #websockets = new WebSocketServer({ noServer: true });
  #hookToken: string | undefined;
  #hookDiscoveryPath: string | undefined;
  constructor(private readonly registry: SessionRegistry, private readonly options: LocalApiOptions) {
    this.#server.on("upgrade", (request, socket, head) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path !== "/v1/events/stream" && !/^\/v1\/sessions\/[^/]+\/transcript\/stream$/.test(path)) { socket.destroy(); return; }
      this.#websockets.handleUpgrade(request, socket, head, (client) => {
        const session = /^\/v1\/sessions\/([^/]+)\/transcript\/stream$/.exec(path)?.[1];
        (client as WebSocket & { session_id: string | undefined }).session_id = session ? decodeURIComponent(session) : undefined;
        this.#clients.add(client); client.once("close", () => this.#clients.delete(client));
      });
    });
    registry.on("session", (session) => this.#broadcast({ type: "session.upsert", session }));
    registry.on("transcript", (event) => this.#broadcast({ type: "transcript.append", event }, event.session_id));
    registry.on("removed", (session_id) => this.#broadcast({ type: "session.removed", session_id, removed_at: new Date().toISOString() }));
  }

  async start(): Promise<number> {
    await new Promise<void>((resolve, reject) => { this.#server.once("error", reject); this.#server.listen(this.options.port ?? 0, this.options.host ?? "127.0.0.1", resolve); });
    const port = (this.#server.address() as AddressInfo).port;
    if (this.options.hooks) {
      this.#hookToken = this.options.hook_token ?? createHookToken();
      this.#hookDiscoveryPath = this.options.hook_discovery_path ?? defaultHookDiscoveryPath();
      try {
        await writeHookDiscovery(this.#hookDiscoveryPath, { version: 1, owner: HOOK_OWNER, endpoint: `http://127.0.0.1:${port}/v1/hooks/events`, token: this.#hookToken, pid: process.pid, started_at: new Date().toISOString() });
      } catch (error) {
        await new Promise<void>((resolve) => this.#server.close(() => resolve()));
        throw error;
      }
    }
    return port;
  }
  async stop(): Promise<void> {
    for (const client of this.#clients) client.close();
    this.options.hooks?.stop();
    if (this.#hookDiscoveryPath && this.#hookToken) await removeHookDiscovery(this.#hookDiscoveryPath, this.#hookToken);
    await new Promise<void>((resolve, reject) => this.#server.close((error) => error ? reject(error) : resolve()));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const method = request.method ?? "GET";
      if (method === "POST" && url.pathname === "/v1/hooks/events") {
        if (!this.options.hooks) { send(response, 404, { error: "Hook ingestion is disabled" }); return; }
        if (request.headers["x-rivetplane-hook-owner"] !== HOOK_OWNER || !this.#hookToken || !secretEquals(request.headers["x-rivetplane-hook-token"], this.#hookToken)) { send(response, 401, { error: "Hook ownership or token is invalid" }); return; }
        send(response, 200, await this.options.hooks.ingest(await body(request))); return;
      }
      if (method === "GET" && url.pathname === "/v1/harnesses") {
        send(response, 200, { harnesses: this.options.harnesses?.() ?? [], discovery_directory: this.options.discovery_directory ?? null }); return;
      }
      if (method === "GET" && url.pathname === "/v1/sessions") {
        const sessions = this.registry.list().filter((session) => (!url.searchParams.get("machine") || session.machine_id === url.searchParams.get("machine")) && (!url.searchParams.get("harness") || session.harness_type === url.searchParams.get("harness")) && (!url.searchParams.get("status") || session.status === url.searchParams.get("status")) && (!url.searchParams.get("cwd") || session.cwd === url.searchParams.get("cwd")));
        send(response, 200, { sessions }); return;
      }
      const match = /^\/v1\/sessions\/([^/]+)(.*)$/.exec(url.pathname);
      if (!match) { send(response, 404, { error: "Not found" }); return; }
      const id = decodeURIComponent(match[1]!); const suffix = match[2] ?? ""; const session = this.registry.get(id);
      if (!session) { send(response, 404, { error: "Session not found" }); return; }
      if (method === "GET" && suffix === "") { send(response, 200, session); return; }
      if (method === "GET" && suffix === "/transcript") {
        const since = Number(url.searchParams.get("since") ?? url.searchParams.get("cursor") ?? 0); const limit = Math.min(1_000, Number(url.searchParams.get("limit") ?? 100)); const events = this.registry.transcript(id, since, limit);
        send(response, 200, { events, next_cursor: events.length === limit ? String(events.at(-1)?.seq) : null }); return;
      }
      if (method === "GET" && suffix === "/pending") { send(response, 200, { pending: session.pending }); return; }
      const target = this.options.target(id); if (!target) { send(response, 409, { error: "Session is not attached" }); return; }
      if (method === "POST" && suffix === "/messages") { const input = await body(request); if (typeof input.text !== "string") throw new Error("text is required"); await target.sendMessage(input.text); send(response, 202, { ok: true }); return; }
      if (method === "POST" && suffix === "/pending/respond") {
        const input = await body(request); if (typeof input.pending_id !== "string" || typeof input.response !== "string") throw new Error("pending_id and response are required");
        const scope = input.scope; if (scope !== undefined && scope !== "once" && scope !== "always_this_tool" && scope !== "always_session") throw new Error("scope is invalid");
        await target.respondToPending(input.pending_id, input.response, scope); send(response, 200, { ok: true }); return;
      }
      if (method === "POST" && suffix === "/interrupt") { await target.interrupt(); send(response, 202, { ok: true }); return; }
      send(response, 404, { error: "Not found" });
    } catch (error) { send(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
  }

  #broadcast(message: unknown, session_id?: string): void {
    const value = JSON.stringify(message);
    for (const client of this.#clients) {
      const filter = (client as WebSocket & { session_id: string | undefined }).session_id;
      if (client.readyState === client.OPEN && (!filter || filter === session_id)) client.send(value);
    }
  }
}
