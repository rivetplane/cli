import assert from "node:assert/strict";
import test from "node:test";
import { HookIngestor } from "./hook-ingestion.js";
import { SessionRegistry } from "./registry.js";

const base = { version: 1 as const, harness: "claude-code", session_id: "full-session-id", cwd: "/repo", transport: "claude-hook", timestamp: "2026-01-01T00:00:00Z" };

test("normalizes exact approval identity and resolves the matching waiter", async () => {
  const registry = new SessionRegistry(); const hooks = new HookIngestor("machine-1", registry, 1_000);
  const result = hooks.ingest({ ...base, event: "PermissionRequest", request_id: "request-full-123", payload: { tool_name: "Bash", tool_input: { command: "bun test" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registry.get("full-session-id")?.pending?.id, "request-full-123");
  assert.equal(registry.get("full-session-id")?.status, "waiting_approval");
  assert.throws(() => hooks.respond("full-session-id", "wrong-id", "approve"), /no longer active/);
  hooks.respond("full-session-id", "request-full-123", "approve", "once");
  assert.deepEqual(await result, { decision: "approve", scope: "once" });
  assert.equal(registry.get("full-session-id")?.pending, null);
});

test("maps AskUserQuestion options and free text through updated input", async () => {
  const registry = new SessionRegistry(); const hooks = new HookIngestor("machine-1", registry, 1_000);
  const result = hooks.ingest({ ...base, event: "PreToolUse", request_id: "tool-use-full", payload: { tool_name: "AskUserQuestion", tool_use_id: "tool-use-full", tool_input: { questions: [{ header: "Mode", question: "Choose mode", options: [{ label: "Safe", description: "No writes" }] }] } } });
  await new Promise((resolve) => setImmediate(resolve));
  const pending = registry.get("full-session-id")?.pending;
  assert.equal(pending?.type, "question"); assert.equal(pending?.id, "tool-use-full");
  if (pending?.type === "question") { assert.deepEqual(pending.options, ["Safe"]); assert.equal(pending.questions?.[0]?.custom, true); }
  hooks.respond("full-session-id", "tool-use-full", "custom answer");
  assert.deepEqual(await result, { decision: "answer", response: "custom answer", updated_input: { answers: [["custom answer"]] } });
});

test("returns neutral on a bounded timeout and does not block telemetry hooks", async () => {
  const registry = new SessionRegistry(); const hooks = new HookIngestor("machine-1", registry, 10);
  assert.deepEqual(await hooks.ingest({ ...base, event: "PermissionRequest", request_id: "timeout-id", payload: { tool_name: "Bash" } }), { decision: "neutral" });
  assert.deepEqual(await hooks.ingest({ ...base, harness: "codex", event: "PreToolUse", request_id: "codex-call", cursor: 1, payload: { tool_name: "shell", tool_input: { command: "pwd" } } }), { decision: "neutral" });
  assert.equal(registry.transcript("full-session-id").some((event) => event.type === "tool_call"), true);
});

test("preserves option arrays for multi-question replies", async () => {
  const registry = new SessionRegistry(); const hooks = new HookIngestor("machine-1", registry, 1_000);
  const result = hooks.ingest({ ...base, event: "PreToolUse", request_id: "multi", payload: { tool_name: "AskUserQuestion", tool_input: { questions: [{ header: "A", question: "First?", options: [] }, { header: "B", question: "Second?", options: [] }] } } });
  await new Promise((resolve) => setImmediate(resolve)); hooks.respond("full-session-id", "multi", '[["one"],["two","three"]]');
  assert.deepEqual((await result).updated_input, { answers: [["one"], ["two", "three"]] });
});

test("deduplicates native events and ignores non-monotonic cursors", async () => {
  const registry = new SessionRegistry(); const hooks = new HookIngestor("machine-1", registry, 10);
  const event = { ...base, harness: "pi", event: "tool_execution_start", request_id: "call-1", cursor: 3, payload: { tool_name: "bash", tool_input: { command: "pwd" } } };
  await hooks.ingest(event); await hooks.ingest(event); await hooks.ingest({ ...event, cursor: 2 });
  assert.equal(registry.transcript("full-session-id").filter((item) => item.type === "tool_call").length, 1);
});

test("clears pending only for the exact local resolution", async () => {
  const registry = new SessionRegistry(); const hooks = new HookIngestor("machine-1", registry, 10);
  await hooks.ingest({ ...base, harness: "opencode", event: "question.asked", request_id: "q1", payload: { prompt: "Continue?" } });
  await hooks.ingest({ ...base, harness: "opencode", event: "question.replied", request_id: "q2", payload: {} });
  assert.equal(registry.get("full-session-id")?.pending?.id, "q1");
  await hooks.ingest({ ...base, harness: "opencode", event: "question.replied", request_id: "q1", payload: {} });
  assert.equal(registry.get("full-session-id")?.pending, null);
});

test("records only the Campfire host role", async () => {
  const registry = new SessionRegistry(); const hooks = new HookIngestor("machine-1", registry, 10);
  await hooks.ingest({ ...base, harness: "campfire", event: "session_start", session_id: "joiner", payload: { role: "joiner", invite_url: "secret-invite" } });
  assert.equal(registry.get("joiner"), undefined);
  await hooks.ingest({ ...base, harness: "campfire", event: "session_start", session_id: "host", payload: { role: "host" } });
  assert.deepEqual(registry.get("host")?.metadata, { transport: "claude-hook", hook_event: "session_start", hook_mode: "lifecycle", role: "host" });
});
