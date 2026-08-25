import assert from "node:assert/strict";
import test from "node:test";
import { SessionRegistry } from "./registry.js";

test("keeps transcript sequence across session re-attach", () => {
  const registry = new SessionRegistry();
  const session = { id: "s1", machine_id: "m1", harness_type: "codex", cwd: "/tmp", status: "running" as const, created_at: "2026-01-01T00:00:00Z", last_activity_at: "2026-01-01T00:00:00Z", pending: null };
  registry.upsert(session); registry.append("s1", "agent_message", { text: "one" });
  registry.upsert({ ...session, status: "waiting_input" }); registry.append("s1", "agent_message", { text: "two" });
  assert.deepEqual(registry.transcript("s1").map((event) => event.seq), [1, 2]);
});

test("does not emit unchanged session or pending state", () => {
  const registry = new SessionRegistry(); let emitted = 0;
  const session = { id: "s1", machine_id: "m1", harness_type: "opencode", cwd: "/tmp", status: "waiting_input" as const, created_at: "2026-01-01T00:00:00Z", last_activity_at: "2026-01-01T00:00:00Z", pending: null };
  registry.on("session", () => emitted++);
  registry.upsert(session); registry.upsert(structuredClone(session)); registry.setPending("s1", null);
  assert.equal(emitted, 1);
});
