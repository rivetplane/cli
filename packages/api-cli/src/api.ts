export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ApiClient {
  listMachines(): Promise<unknown>;
  listSessions(filter?: Record<string, string>): Promise<unknown>;
  getSession(sessionId: string): Promise<unknown>;
  getTranscript(sessionId: string, options?: { since?: string; limit?: number; cursor?: string }): Promise<unknown>;
  subscribeToTranscript(sessionId: string, options?: { signal?: AbortSignal }): AsyncIterable<unknown>;
  sendMessage(sessionId: string, text: string): Promise<unknown>;
  getPending(sessionId: string): Promise<unknown>;
  respondToPending(sessionId: string, pendingId: string, response: string, scope?: string): Promise<unknown>;
  interruptSession(sessionId: string): Promise<unknown>;
}

export interface ApiClientFactory {
  (options: { baseUrl: string; token: string }): ApiClient;
}

export function statusFromError(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  for (const key of ["status", "statusCode", "httpStatus"] as const) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === "number") return value;
  }
  return undefined;
}
