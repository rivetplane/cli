import { Rivetplane, type ApprovalScope, type SessionListFilter, type TranscriptPageOptions } from "@rivetplane/sdk";
import type { ApiClient, ApiClientFactory } from "./api.js";

class SdkApiClient implements ApiClient {
  constructor(private readonly sdk: Rivetplane) {}

  listMachines(): Promise<unknown> { return this.sdk.machines.list(); }
  listSessions(filter: Record<string, string> = {}): Promise<unknown> { return this.sdk.sessions.list(filter as SessionListFilter); }
  getSession(sessionId: string): Promise<unknown> { return this.sdk.sessions.get(sessionId); }
  getTranscript(sessionId: string, options: TranscriptPageOptions = {}): Promise<unknown> { return this.sdk.sessions.transcript(sessionId, options); }
  subscribeToTranscript(sessionId: string, options: { signal?: AbortSignal } = {}): AsyncIterable<unknown> { return this.sdk.sessions.streamTranscript(sessionId, options); }
  sendMessage(sessionId: string, text: string): Promise<unknown> { return this.sdk.sessions.sendMessage(sessionId, text); }
  getPending(sessionId: string): Promise<unknown> { return this.sdk.sessions.pending(sessionId); }
  respondToPending(sessionId: string, pendingId: string, response: string, scope?: string): Promise<unknown> {
    return this.sdk.sessions.respondToPending(sessionId, { pending_id: pendingId, response, ...(scope ? { scope: scope as ApprovalScope } : {}) });
  }
  interruptSession(sessionId: string): Promise<unknown> { return this.sdk.sessions.interrupt(sessionId); }
}

export const createSdkClient: ApiClientFactory = ({ baseUrl, token }) => new SdkApiClient(new Rivetplane({ baseUrl, authentication: token }));
