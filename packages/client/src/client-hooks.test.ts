import assert from "node:assert/strict";
import test from "node:test";
import { aggregateHarnessStatuses, HarnessControlClient, selectCommandTarget } from "./client.js";
import { toHookEnvelope } from "./hook-bridge.js";

test("includes hook-discovered harnesses in the local roster and capability summary", async () => {
  const client = new HarnessControlClient({ relay: false, opencode_url: false, opencode_export: false, codex: false, claude_code: false });
  await client.hooks.ingest(toHookEnvelope("claude-code", "Stop", { session_id: "hook-session", transcript_path: "/tmp/t.jsonl", cwd: "/repo", hook_event_name: "Stop", stop_hook_active: false }));
  assert.deepEqual(client.harnesses(), [{ harness_type: "claude-code", discovered_sessions: 1, attached_sessions: 1 }]);
  const capability = client.capabilityReports().find((item) => item.harness_type === "claude-code");
  assert.equal(capability?.transport, "claude-code-hook-command"); assert.equal(capability?.session_capabilities?.discovery.supported, true);
});

test("counts unique sessions across overlapping rosters and keeps live capabilities", () => {
  const unsupported = { supported: false, mode: "unsupported" as const, reason: "read-only" };
  const readOnly = { supported: true, mode: "read_only" as const };
  const readWrite = { supported: true, mode: "read_write" as const };
  const rollout = { discovery: readOnly, transcript: readOnly, live_attachment: unsupported, messaging: unsupported, interrupt: unsupported, question_response: unsupported, approval_response: unsupported, transport: "rollout-jsonl", managed: false };
  const live = { discovery: readWrite, transcript: readWrite, live_attachment: readWrite, messaging: readWrite, interrupt: readWrite, question_response: readWrite, approval_response: readWrite, transport: "unix", managed: true };
  const statuses = aggregateHarnessStatuses([
    { harness_type: "codex", discovered_sessions: 2, attached_sessions: 2, discovered_session_ids: ["shared", "live-only"], attached_session_ids: ["shared", "live-only"], capabilities: live },
    { harness_type: "codex", discovered_sessions: 2, attached_sessions: 0, discovered_session_ids: ["shared", "rollout-only"], attached_session_ids: [], capabilities: rollout },
  ]);
  assert.deepEqual(statuses, [{ harness_type: "codex", discovered_sessions: 3, attached_sessions: 2, capabilities: live }]);
});

test("routes a command to an exact live waiter before a read-only compatibility adapter", () => {
  const calls: string[] = [];
  const readOnly = { sendMessage: async () => {}, respondToPending: async () => { calls.push("read-only"); }, interrupt: async () => {} };
  const live = { sendMessage: async () => {}, respondToPending: async () => { calls.push("live"); }, interrupt: async () => {} };
  const target = selectCommandTarget("shared-session", [() => undefined, () => live, () => readOnly]);
  assert.equal(target, live);
});
