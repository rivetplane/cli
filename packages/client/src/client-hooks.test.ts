import assert from "node:assert/strict";
import test from "node:test";
import { HarnessControlClient } from "./client.js";
import { toHookEnvelope } from "./hook-bridge.js";

test("includes hook-discovered harnesses in the local roster and capability summary", async () => {
  const client = new HarnessControlClient({ relay: false, opencode_url: false, opencode_export: false, codex: false, claude_code: false });
  await client.hooks.ingest(toHookEnvelope("claude-code", "Stop", { session_id: "hook-session", transcript_path: "/tmp/t.jsonl", cwd: "/repo", hook_event_name: "Stop", stop_hook_active: false }));
  assert.deepEqual(client.harnesses(), [{ harness_type: "claude-code", discovered_sessions: 1, attached_sessions: 1 }]);
  const capability = client.capabilityReports().find((item) => item.harness_type === "claude-code");
  assert.equal(capability?.transport, "claude-code-hook-command"); assert.equal(capability?.session_capabilities?.discovery.supported, true);
});
