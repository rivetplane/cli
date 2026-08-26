import assert from "node:assert/strict";
import { access, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emitHook } from "./hook-bridge.js";
import { HOOK_OWNER, type HookDiscoveryRecord } from "./hook-discovery.js";
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

test("authenticates hook events through a private port-zero discovery record", async () => {
  const registry = new SessionRegistry(); const hooks = new HookIngestor("m1", registry, 5);
  const root = await mkdtemp(join(tmpdir(), "rivetplane-hook-api-")); const discovery = join(root, "private", "hook-endpoint.json");
  const api = new LocalApi(registry, { port: 0, target: (id) => hooks.target(id), hooks, hook_discovery_path: discovery }); const port = await api.start();
  try {
    const record = JSON.parse(await readFile(discovery, "utf8")) as HookDiscoveryRecord;
    assert.equal(record.endpoint, `http://127.0.0.1:${port}/v1/hooks/events`); assert.equal(record.owner, HOOK_OWNER); assert.equal(record.pid, process.pid);
    if (process.platform !== "win32") assert.equal((await stat(discovery)).mode & 0o077, 0);
    const payload = { session_id: "claude-full", transcript_path: "/tmp/t.jsonl", cwd: "/repo", hook_event_name: "Stop", stop_hook_active: false };
    const unauthenticated = await fetch(record.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }); assert.equal(unauthenticated.status, 401);
    const wrongOwner = await fetch(record.endpoint, { method: "POST", headers: { "content-type": "application/json", "x-rivetplane-hook-owner": "other", "x-rivetplane-hook-token": record.token }, body: JSON.stringify({}) }); assert.equal(wrongOwner.status, 401);
    assert.deepEqual(await emitHook("claude-code", "Stop", { owner: HOOK_OWNER, discovery_path: discovery, payload }), {});
    assert.equal(registry.get("claude-full")?.harness_type, "claude-code"); assert.equal(registry.get("claude-full")?.status, "waiting_input");
  } finally { await api.stop(); }
  await assert.rejects(access(discovery), /ENOENT/);
});
