import { EventEmitter } from "node:events";
import type { Machine, Session } from "@rivetplane/shared/model";
import type { ClientToServerMessage, CreateSessionCommand, HarnessCapabilities, ServerToClientMessage } from "@rivetplane/shared/protocol";
import WebSocket from "ws";
import type { Credentials } from "./credentials.js";
import { SessionRegistry } from "./registry.js";

export interface CommandTarget { sendMessage(text: string): Promise<void>; respondToPending(id: string, response: string, scope?: "once" | "always_this_tool" | "always_session"): void | Promise<void>; interrupt(): void | Promise<void> }
interface RelayOptions { createSession?: (command: CreateSessionCommand) => Promise<string>; capabilities?: () => HarnessCapabilities[] }

const REPLAY_LIMIT_PER_SESSION = 500;

function relayUrl(server: string): string {
  const url = new URL(server); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/relay`; return url.toString();
}

export class OutboundRelay extends EventEmitter {
  #socket: WebSocket | undefined;
  #retry: NodeJS.Timeout | undefined;
  #heartbeat: NodeJS.Timeout | undefined;
  #stopped = true;
  #attempt = 0;
  #queue: ClientToServerMessage[] = [];
  #externalToLocal = new Map<string, string>();

  constructor(private readonly credentials: Credentials, private readonly registry: SessionRegistry, private readonly target: (id: string) => CommandTarget | undefined, private readonly options: RelayOptions = {}) {
    super();
    registry.on("session", (session: Session) => this.send({ type: "session.upsert", session: this.#namespace(session) }));
    registry.on("transcript", (event) => {
      const session = registry.get(event.session_id); if (!session) return;
      this.send({ type: "transcript.append", event: { ...event, session_id: this.#externalId(session) } });
    });
    registry.on("removed", (session_id: string) => {
      const external = [...this.#externalToLocal].find(([, local]) => local === session_id)?.[0] ?? session_id;
      this.send({ type: "session.removed", session_id: external, removed_at: new Date().toISOString() }); this.#externalToLocal.delete(external);
    });
  }

  start(): void { if (!this.#stopped) return; this.#stopped = false; this.#connect(); }
  stop(): void { this.#stopped = true; if (this.#retry) clearTimeout(this.#retry); if (this.#heartbeat) clearInterval(this.#heartbeat); this.#socket?.close(); }
  send(message: ClientToServerMessage): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
    else { this.#queue.push(message); if (this.#queue.length > 10_000) this.#queue.shift(); }
  }

  #connect(): void {
    if (this.#stopped) return;
    const socket = new WebSocket(relayUrl(this.credentials.server_url), { headers: { authorization: `Bearer ${this.credentials.token}` } });
    this.#socket = socket;
    socket.on("open", () => {
      this.#attempt = 0;
      const now = new Date().toISOString();
      const machine: Machine = { id: this.credentials.machine_id, name: this.credentials.machine_name, owner_account_id: this.credentials.owner_account_id, last_seen_at: now, status: "online" };
      socket.send(JSON.stringify({ type: "machine.hello", protocol_version: 1, machine } satisfies ClientToServerMessage));
      const sessions = this.registry.list();
      for (const session of sessions) {
        socket.send(JSON.stringify({ type: "session.upsert", session: this.#namespace(session) } satisfies ClientToServerMessage));
      }
      for (const capabilities of this.options.capabilities?.() ?? []) socket.send(JSON.stringify({ type: "harness.capabilities", capabilities } satisfies ClientToServerMessage));
      // Deliver live state that accumulated during reconnect before historical
      // transcript repair. This keeps new pending requests actionable.
      for (const message of this.#queue.splice(0)) socket.send(JSON.stringify(message));
      // Replay a bounded, round-robin tail. The server deduplicates event IDs.
      // A large backlog from one harness cannot delay all other sessions.
      const replays = sessions.map((session) => ({ session, events: this.registry.transcriptTail(session.id, REPLAY_LIMIT_PER_SESSION), offset: 0 }));
      let pending = true;
      while (pending) {
        pending = false;
        for (const replay of replays) {
          const event = replay.events[replay.offset++];
          if (!event) continue;
          pending = true;
          socket.send(JSON.stringify({ type: "transcript.append", event: { ...event, session_id: this.#externalId(replay.session) } } satisfies ClientToServerMessage));
        }
      }
      this.#heartbeat = setInterval(() => { this.send({ type: "machine.heartbeat", machine_id: machine.id, sent_at: new Date().toISOString() });
        for (const capabilities of this.options.capabilities?.() ?? []) this.send({ type: "harness.capabilities", capabilities }); }, 15_000);
      this.#heartbeat.unref(); this.emit("online");
    });
    socket.on("message", (data) => void this.#command(data.toString()));
    socket.on("error", (error) => this.emit("warning", error));
    socket.on("close", () => {
      if (this.#heartbeat) clearInterval(this.#heartbeat); this.#heartbeat = undefined; this.#socket = undefined; this.emit("offline");
      if (!this.#stopped) { const delay = Math.min(30_000, 500 * 2 ** this.#attempt++); this.#retry = setTimeout(() => this.#connect(), delay); this.#retry.unref(); }
    });
  }

  async #command(raw: string): Promise<void> {
    let command: ServerToClientMessage;
    try { command = JSON.parse(raw) as ServerToClientMessage; } catch { this.emit("warning", new Error("Relay sent invalid JSON")); return; }
    if (command.type !== "command.send_message" && command.type !== "command.respond_to_pending" && command.type !== "command.interrupt_session" && command.type !== "command.create_session") return;
    if (command.type === "command.create_session") {
      try { const session_id = await this.options.createSession?.(command); if (!session_id) throw new Error("Harness cannot create sessions");
        this.send({ type: "command.result", command_id: command.command_id, ok: true, result: { session_id } });
      } catch (error) { this.send({ type: "command.result", command_id: command.command_id, ok: false, error: error instanceof Error ? error.message : String(error) }); }
      return;
    }
    const session = this.target(this.#externalToLocal.get(command.session_id) ?? command.session_id);
    if (!session) { this.send({ type: "command.result", command_id: command.command_id, ok: false, error: "Session is not attached" }); return; }
    try {
      if (command.type === "command.send_message") await session.sendMessage(command.text);
      else if (command.type === "command.respond_to_pending") await session.respondToPending(command.pending_id, command.response, command.scope);
      else if (command.type === "command.interrupt_session") await session.interrupt();
      else throw new Error("Unknown command type");
      this.send({ type: "command.result", command_id: command.command_id, ok: true });
    } catch (error) { this.send({ type: "command.result", command_id: command.command_id, ok: false, error: error instanceof Error ? error.message : String(error) }); }
  }

  #externalId(session: Session): string {
    const value = `${this.credentials.machine_id}/${session.harness_type}/${session.id}`;
    this.#externalToLocal.set(value, session.id); return value;
  }

  #namespace(session: Session): Session {
    const id = this.#externalId(session);
    return { ...session, id, pending: session.pending ? { ...session.pending, session_id: id } : null };
  }
}
