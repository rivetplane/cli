import assert from "node:assert/strict";
import test from "node:test";
import { LocalApi } from "./local-api.js";
import { SessionRegistry } from "./registry.js";

test("serves the localhost session and transcript API", async () => {
  const registry = new SessionRegistry();
  registry.upsert({ id: "s1", machine_id: "m1", harness_type: "codex", cwd: "/tmp", status: "waiting_input", created_at: "2026-01-01T00:00:00Z", last_activity_at: "2026-01-01T00:00:00Z", pending: null });
  registry.append("s1", "agent_message", { text: "ready" });
  const api = new LocalApi(registry, { port: 0, target: () => undefined, harnesses: () => [{ harness_type: "codex", discovered_sessions: 1, attached_sessions: 1 }], discovery_directory: "/tmp/acp" });
  const port = await api.start();
  try {
    const sessions = await fetch(`http://127.0.0.1:${port}/v1/sessions`).then((response) => response.json()) as { sessions: unknown[] };
    const harnesses = await fetch(`http://127.0.0.1:${port}/v1/harnesses`).then((response) => response.json()) as { harnesses: Array<{ harness_type: string }>; discovery_directory: string };
    const transcript = await fetch(`http://127.0.0.1:${port}/v1/sessions/s1/transcript`).then((response) => response.json()) as { events: Array<{ payload: { text: string } }> };
    assert.equal(sessions.sessions.length, 1); assert.equal(transcript.events[0]?.payload.text, "ready");
    assert.equal(harnesses.harnesses[0]?.harness_type, "codex"); assert.equal(harnesses.discovery_directory, "/tmp/acp");
  } finally { await api.stop(); }
});
