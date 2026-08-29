import { EventEmitter } from "node:events";
import type { Machine, Session, UsageSample } from "@rivetplane/shared/model";
import type { ClientToServerMessage, CreateSessionCommand, HarnessCapabilities, ServerToClientMessage } from "@rivetplane/shared/protocol";
import WebSocket from "ws";
import type { Credentials } from "./credentials.js";
import { SessionRegistry } from "./registry.js";

export interface CommandTarget { sendMessage(text: string): Promise<void>; respondToPending(id: string, response: string, scope?: "once" | "always_this_tool" | "always_session"): void | Promise<void>; interrupt(): void | Promise<void> }
interface RelayOptions { createSession?: (command: CreateSessionCommand) => Promise<string>; capabilities?: () => HarnessCapabilities[]; usage?: EventEmitter; replay_delay_ms?: number; replay_interval_ms?: number; heartbeat_interval_ms?: number; session_drain_interval_ms?: number }

const SNAPSHOT_SESSION_LIMIT = 16;
const REPLAY_LIMIT_PER_SESSION = 20;
const REPLAY_EVENT_LIMIT = 40;
const REPLAY_DELAY_MS = 5_000;
// Transcript repair is deliberately slower than live state. The server applies
// relay frames serially, so a fast replay can otherwise put a newly requested
// approval or question behind minutes of database writes.
const REPLAY_INTERVAL_MS = 15_000;
// The hosted store performs durable work for each relay frame. Keep background
// session/transcript traffic below that write path's sustained rate so an
// already-sent pending frame is not trapped behind server-side database work.
// Supabase's hosted connection can take multiple seconds to durably apply one
// session or transcript frame. Stay comfortably below that rate so background
// discovery can never build an ordered server queue in front of a live hook.
const SESSION_DRAIN_INTERVAL_MS = 5_000;

function snapshotSessions(registry: SessionRegistry): Session[] {
  return registry.list().sort((left, right) => {
    const pending = Number(Boolean(right.pending)) - Number(Boolean(left.pending));
    return pending || Date.parse(right.last_activity_at) - Date.parse(left.last_activity_at);
  }).slice(0, SNAPSHOT_SESSION_LIMIT);
}

function relayUrl(server: string): string {
  const url = new URL(server); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/relay`; return url.toString();
}

export class OutboundRelay extends EventEmitter {
  #socket: WebSocket | undefined;
  #retry: NodeJS.Timeout | undefined;
  #heartbeat: NodeJS.Timeout | undefined;
  #replay: NodeJS.Timeout | undefined;
  #stopped = true;
  #attempt = 0;
  #queue: ClientToServerMessage[] = [];
  #sessionQueue = new Map<string, Session>();
  #transcriptQueue: ClientToServerMessage[] = [];
  #drainTranscriptNext = false;
  #sessionDrain: NodeJS.Timeout | undefined;
  #externalToLocal = new Map<string, string>();
  #capabilityFingerprints = new Map<string, string>();
  #pendingUsage = new Map<string, UsageSample[]>();

  constructor(private readonly credentials: Credentials, private readonly registry: SessionRegistry, private readonly target: (id: string) => CommandTarget | undefined, private readonly options: RelayOptions = {}) {
    super();
    registry.on("session", (session: Session) => this.#sendSession(session));
    registry.on("transcript", (event) => {
      const session = registry.get(event.session_id); if (!session) return;
      // Transcript repair is lower priority than a live approval or question.
      // Queue and throttle it so a busy rollout cannot fill the ordered socket
      // ahead of a time-limited pending interaction.
      if (this.#stopped) return;
      this.#transcriptQueue.push({ type: "transcript.append", event: { ...event, session_id: this.#externalId(session) } });
      if (this.#transcriptQueue.length > 10_000) this.#transcriptQueue.shift();
      this.#scheduleSessionDrain();
    });
    registry.on("removed", (session_id: string) => {
      const external = [...this.#externalToLocal].find(([, local]) => local === session_id)?.[0] ?? session_id;
      this.send({ type: "session.removed", session_id: external, removed_at: new Date().toISOString() }); this.#externalToLocal.delete(external); this.#pendingUsage.delete(session_id);
    });
    options.usage?.on("usage", (sample: UsageSample) => this.#sendUsage(sample));
  }

  start(): void { if (!this.#stopped) return; this.#stopped = false; this.#connect(); }
  stop(): void { this.#stopped = true; if (this.#retry) clearTimeout(this.#retry); if (this.#heartbeat) clearInterval(this.#heartbeat); if (this.#replay) clearTimeout(this.#replay); if (this.#sessionDrain) clearTimeout(this.#sessionDrain); this.#socket?.close(); }
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
      const sessions = snapshotSessions(this.registry);
      for (const session of sessions.filter((candidate) => candidate.pending)) {
        socket.send(JSON.stringify({ type: "session.upsert", session: this.#namespace(session) } satisfies ClientToServerMessage));
      }
      this.#sendCapabilities(socket, true);
      // Discovery can populate thousands of sessions before the first socket
      // opens. Never replay that raw startup queue: snapshots and bounded repair
      // already cover it, while flooding it can delay a new question by minutes.
      // Preserve every pending item plus control results/removals that cannot be
      // reconstructed from the registry.
      const queued = this.#queue.splice(0);
      const requiredSessions = new Set(queued.filter((message) => message.type === "usage.sample" && message.sample.session_id).map((message) => message.type === "usage.sample" ? message.sample.session_id : null));
      const pending = new Map<string, ClientToServerMessage>(); const essential: ClientToServerMessage[] = [];
      for (const message of queued) {
        if (message.type === "session.upsert") {
          if (message.session.pending || requiredSessions.has(message.session.id)) pending.set(message.session.id, message);
        } else if (message.type === "command.result" || message.type === "session.removed" || message.type === "usage.sample") essential.push(message);
      }
      for (const message of [...pending.values(), ...essential]) socket.send(JSON.stringify(message));
      // Session changes discovered before the socket opened are already
      // represented by the bounded snapshot and repair pass above. Draining
      // thousands of stale startup records here creates an ordered server-side
      // backlog that can delay a live Claude question for over a minute.
      this.#sessionQueue.clear();
      this.#scheduleSessionDrain();
      // Repair transcript history after live state has had time to settle. One
      // frame per tick keeps new approvals and questions ahead of old events.
      this.#scheduleReplay(socket, sessions);
      this.#heartbeat = setInterval(() => {
        this.send({ type: "machine.heartbeat", machine_id: machine.id, sent_at: new Date().toISOString() });
        // Hook-backed adapters become actionable only after the first native
        // event arrives. Re-advertise a capability report when its semantics
        // change so a read-only discovery report cannot remain authoritative
        // for the lifetime of the relay connection.
        this.#sendCapabilities(socket);
        // A socket can appear open briefly while a proxy restart drops a frame.
        // Pending state is tiny and time-sensitive, so re-announce it until the
        // harness resolves it. This repairs a lost question without replaying
        // the full session or transcript backlog.
        for (const session of snapshotSessions(this.registry).filter((candidate) => candidate.pending)) this.send({ type: "session.upsert", session: this.#namespace(session) });
      }, this.options.heartbeat_interval_ms ?? 15_000);
      this.#heartbeat.unref(); this.emit("online");
    });
    socket.on("message", (data) => void this.#command(data.toString()));
    socket.on("error", (error) => this.emit("warning", error));
    socket.on("close", () => {
      if (this.#heartbeat) clearInterval(this.#heartbeat); if (this.#replay) clearTimeout(this.#replay); if (this.#sessionDrain) clearTimeout(this.#sessionDrain); this.#heartbeat = undefined; this.#replay = undefined; this.#sessionDrain = undefined; this.#socket = undefined; this.emit("offline");
      if (!this.#stopped) { const delay = Math.min(30_000, 500 * 2 ** this.#attempt++); this.#retry = setTimeout(() => this.#connect(), delay); this.#retry.unref(); }
    });
  }

  #sendSession(session: Session): void {
    const id = this.#externalId(session);
    const usage = this.#pendingUsage.get(session.id);
    if (usage?.length) {
      this.#pendingUsage.delete(session.id); this.#sessionQueue.delete(id);
      this.send({ type: "session.upsert", session: this.#namespace(session) });
      for (const sample of usage) this.send({ type: "usage.sample", sample: { ...sample, session_id: id } });
      return;
    }
    if (session.pending) {
      // Pending interactions are latency-sensitive. Remove any older ordinary
      // snapshot for this session and put the actionable state straight onto
      // the wire instead of behind a large discovery refresh.
      this.#sessionQueue.delete(id);
      this.send({ type: "session.upsert", session: this.#namespace(session) });
      return;
    }
    this.#sessionQueue.set(id, session);
    this.#scheduleSessionDrain();
  }

  #scheduleSessionDrain(): void {
    if (this.#sessionDrain || this.#stopped || (this.#sessionQueue.size === 0 && this.#transcriptQueue.length === 0)) return;
    this.#sessionDrain = setTimeout(() => {
      this.#sessionDrain = undefined;
      if (this.#socket?.readyState === WebSocket.OPEN) {
        const next = this.#sessionQueue.entries().next().value as [string, Session] | undefined;
        if (this.#drainTranscriptNext && this.#transcriptQueue.length > 0) this.send(this.#transcriptQueue.shift()!);
        else if (next) { this.#sessionQueue.delete(next[0]); this.send({ type: "session.upsert", session: this.#namespace(next[1]) }); }
        else {
          const fallback = this.#transcriptQueue.shift();
          if (fallback) this.send(fallback);
        }
        this.#drainTranscriptNext = !this.#drainTranscriptNext;
      }
      this.#scheduleSessionDrain();
    }, this.options.session_drain_interval_ms ?? SESSION_DRAIN_INTERVAL_MS);
    this.#sessionDrain.unref();
  }

  #sendCapabilities(socket: WebSocket, force = false): void {
    for (const capabilities of this.options.capabilities?.() ?? []) {
      const { reported_at: _reportedAt, ...semantic } = capabilities;
      const fingerprint = JSON.stringify(semantic);
      if (!force && this.#capabilityFingerprints.get(capabilities.harness_type) === fingerprint) continue;
      this.#capabilityFingerprints.set(capabilities.harness_type, fingerprint);
      socket.send(JSON.stringify({ type: "harness.capabilities", capabilities } satisfies ClientToServerMessage));
    }
  }

  #scheduleReplay(socket: WebSocket, sessions: Session[]): void {
    const snapshots = sessions.filter((session) => !session.pending); let snapshotOffset = 0;
    const replays = sessions.map((session) => ({ session, events: this.registry.transcriptTail(session.id, REPLAY_LIMIT_PER_SESSION), offset: 0 }));
    let cursor = 0; let sent = 0;
    const next = (): void => {
      if (this.#stopped || socket !== this.#socket || socket.readyState !== WebSocket.OPEN || sent >= REPLAY_EVENT_LIMIT) { this.#replay = undefined; return; }
      const snapshot = snapshots[snapshotOffset++];
      if (snapshot) {
        socket.send(JSON.stringify({ type: "session.upsert", session: this.#namespace(snapshot) } satisfies ClientToServerMessage));
        this.#replay = setTimeout(next, this.options.replay_interval_ms ?? REPLAY_INTERVAL_MS); this.#replay.unref(); return;
      }
      let event: ReturnType<SessionRegistry["transcriptTail"]>[number] | undefined; let session: Session | undefined;
      for (let checked = 0; checked < replays.length; checked++) {
        const replay = replays[cursor++ % replays.length]!; const candidate = replay.events[replay.offset++];
        if (candidate) { event = candidate; session = replay.session; break; }
      }
      if (!event || !session) { this.#replay = undefined; return; }
      socket.send(JSON.stringify({ type: "transcript.append", event: { ...event, session_id: this.#externalId(session) } } satisfies ClientToServerMessage)); sent++;
      this.#replay = setTimeout(next, this.options.replay_interval_ms ?? REPLAY_INTERVAL_MS); this.#replay.unref();
    };
    this.#replay = setTimeout(next, this.options.replay_delay_ms ?? REPLAY_DELAY_MS); this.#replay.unref();
  }

  async #command(raw: string): Promise<void> {
    let command: ServerToClientMessage;
    try { command = JSON.parse(raw) as ServerToClientMessage; } catch { this.emit("warning", new Error("Relay sent invalid JSON")); return; }
    if (command.type === "relay.error") { this.emit("warning", new Error(`Relay rejected a frame: ${command.error}`)); return; }
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
  #sendUsage(sample: UsageSample): void {
    if (!sample.session_id) { this.send({ type: "usage.sample", sample }); return; }
    const session = this.registry.get(sample.session_id);
    if (!session) {
      const pending = this.#pendingUsage.get(sample.session_id) ?? [];
      pending.push(sample); if (pending.length > 100) pending.shift(); this.#pendingUsage.set(sample.session_id, pending); return;
    }
    const session_id = this.#externalId(session);
    // Session validation happens before usage storage. Keep these frames next
    // to each other so a new or reconnected server always sees the session first.
    this.send({ type: "session.upsert", session: this.#namespace(session) });
    this.send({ type: "usage.sample", sample: { ...sample, session_id } });
  }
}
