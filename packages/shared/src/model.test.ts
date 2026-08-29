import assert from "node:assert/strict";
import test from "node:test";

import {
  APPROVAL_SCOPES,
  MACHINE_STATUSES,
  PROTOCOL_VERSION,
  SESSION_STATUSES,
  type TranscriptEvent,
  type ClientToServerMessage,
} from "./index.js";

test("exports the versioned protocol and model status values", () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.deepEqual(MACHINE_STATUSES, ["online", "offline"]);
  assert.deepEqual(SESSION_STATUSES, [
    "running",
    "waiting_input",
    "waiting_approval",
    "completed",
    "error",
  ]);
  assert.deepEqual(APPROVAL_SCOPES, [
    "once",
    "always_this_tool",
    "always_session",
  ]);
});

test("keeps usage samples additive and explicit about missing values", () => {
  const message = { type: "usage.sample", sample: { event_id: "u1", machine_id: "m1", session_id: null, timestamp: "2026-08-29T00:00:00.000Z", harness: "codex", provider: "openai", source: "account/rateLimits/read", source_counter_mode: "cumulative", tokens: { input: null, output: null, reasoning: null, cache_read: null, cache_write: null, total: null }, cost: { status: "unavailable" }, quota: [{ name: "primary", used_percent: 25 }] } } satisfies ClientToServerMessage;
  assert.equal(message.sample.session_id, null); assert.equal(message.sample.cost.status, "unavailable");
});

test("keeps transcript payloads paired with their event type", () => {
  const event = {
    id: "event-1",
    session_id: "session-1",
    seq: 1,
    ts: "2026-08-23T09:00:00.000Z",
    type: "user_message",
    payload: { text: "Continue" },
  } satisfies TranscriptEvent;

  assert.equal(event.payload.text, "Continue");
});
