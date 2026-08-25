import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { PendingInteraction, Session, SessionStatus, TranscriptEvent, TranscriptEventPayloadMap, TranscriptEventType } from "@rivetplane/shared/model";

interface Entry { session: Session; transcript: TranscriptEvent[]; next_seq: number }

export class SessionRegistry extends EventEmitter {
  #entries = new Map<string, Entry>();

  list(): Session[] { return [...this.#entries.values()].map(({ session }) => structuredClone(session)); }
  get(id: string): Session | undefined { const value = this.#entries.get(id)?.session; return value ? structuredClone(value) : undefined; }
  transcript(id: string, since = 0, limit = 100): TranscriptEvent[] { return (this.#entries.get(id)?.transcript ?? []).filter((event) => event.seq > since).slice(0, limit).map((event) => structuredClone(event)); }

  upsert(session: Session): Session {
    const prior = this.#entries.get(session.id);
    const entry: Entry = prior ? { ...prior, session: structuredClone(session) } : { session: structuredClone(session), transcript: [], next_seq: 1 };
    this.#entries.set(session.id, entry);
    this.emit("session", structuredClone(entry.session));
    return structuredClone(entry.session);
  }

  setStatus(id: string, status: SessionStatus, reason?: string): void {
    const entry = this.#require(id);
    const from = entry.session.status;
    if (from === status) return;
    entry.session = { ...entry.session, status, last_activity_at: new Date().toISOString() };
    this.append(id, "status_change", { from, to: status, ...(reason ? { reason } : {}) });
    this.emit("session", structuredClone(entry.session));
  }

  setPending(id: string, pending: PendingInteraction | null): void {
    const entry = this.#require(id);
    entry.session = { ...entry.session, pending, last_activity_at: new Date().toISOString() };
    this.emit("session", structuredClone(entry.session));
  }

  append<T extends TranscriptEventType>(id: string, type: T, payload: TranscriptEventPayloadMap[T], source?: { id?: string; ts?: string }): TranscriptEvent {
    const entry = this.#require(id);
    const event = { id: source?.id ?? randomUUID(), session_id: id, seq: entry.next_seq++, ts: source?.ts ?? new Date().toISOString(), type, payload } as TranscriptEvent;
    entry.transcript.push(event);
    entry.session = { ...entry.session, last_activity_at: event.ts };
    this.emit("transcript", structuredClone(event));
    return structuredClone(event);
  }

  remove(id: string): void { if (this.#entries.delete(id)) this.emit("removed", id); }
  #require(id: string): Entry { const entry = this.#entries.get(id); if (!entry) throw new Error(`Unknown session: ${id}`); return entry; }
}
