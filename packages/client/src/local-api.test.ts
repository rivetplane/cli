import assert from "node:assert/strict";
import test from "node:test";
import { LocalApi } from "./local-api.js";
import { SessionRegistry } from "./registry.js";
import { HookIngestor } from "./hook-ingestion.js";

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

test("accepts native hook events through the loopback ingestion protocol", async () => {
  const registry = new SessionRegistry(); const hooks = new HookIngestor("m1", registry, 5);
  const api = new LocalApi(registry, { port: 0, target: (id) => hooks.target(id), hooks }); const port = await api.start();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/hooks/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 1, harness: "codex", event: "PreToolUse", session_id: "codex-full", request_id: "call-full", cwd: "/repo", transport: "codex-hook", payload: { tool_name: "shell", tool_input: { command: "pwd" } } }) });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { decision: "neutral" }); assert.equal(registry.get("codex-full")?.harness_type, "codex");
  } finally { await api.stop(); }
});
