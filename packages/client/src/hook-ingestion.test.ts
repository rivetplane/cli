import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatNativeResult, toHookEnvelope } from "./hook-bridge.js";
import { HookIngestor } from "./hook-ingestion.js";
import { SessionRegistry } from "./registry.js";

const fixture = async <T>(...parts: string[]): Promise<T> => JSON.parse(await readFile(join(process.cwd(), "src", "fixtures", "hooks", ...parts), "utf8")) as T;
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const eventually = async (condition: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Condition was not met before the test timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test("validates the official Claude PermissionRequest shape and exact bridge identity", async () => {
  const payload = await fixture<Record<string, unknown>>("claude-code", "permission-request.json");
  const envelope = toHookEnvelope("claude-code", "PermissionRequest", payload);
  assert.match(envelope.request_id ?? "", /^rivetplane-[0-9a-f-]{36}$/);
  const registry = new SessionRegistry(); const hooks = new HookIngestor("machine-1", registry, 1_000);
  const pending = hooks.ingest(envelope); await eventually(() => registry.get(envelope.session_id)?.pending?.id === envelope.request_id);
  assert.equal(registry.get(envelope.session_id)?.pending?.id, envelope.request_id);
  assert.throws(() => hooks.respond(envelope.session_id, "wrong-id", "approve"), /no longer active/);
  hooks.respond(envelope.session_id, envelope.request_id!, "approve", "once");
  const result = await pending;
  assert.deepEqual(result, { decision: "approve", scope: "once" });
  assert.deepEqual(formatNativeResult("claude-code", "PermissionRequest", payload, result), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: payload.tool_input } } });
});

test("passes the Claude question permission preflight, then maps options and a transcript title", async (t) => {
  const payload = await fixture<Record<string, unknown>>("claude-code", "ask-user-question.json");
  const permission = await fixture<Record<string, unknown>>("claude-code", "permission-request.json");
  const directory = await mkdtemp(join(tmpdir(), "rivetplane-claude-title-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const transcript = join(directory, "session.jsonl");
  await writeFile(transcript, [
    JSON.stringify({ type: "mode", sessionId: "claude-session-full" }),
    JSON.stringify({ type: "user", sessionId: "claude-session-full", message: { role: "user", content: "  Plan   the release safely.  " } }),
  ].join("\n"));
  const registry = new SessionRegistry(); const hooks = new HookIngestor("machine-1", registry, 1_000);
  const preflightPayload = { ...permission, tool_name: "AskUserQuestion", tool_input: payload.tool_input, transcript_path: transcript };
  assert.deepEqual(await hooks.ingest(toHookEnvelope("claude-code", "PermissionRequest", preflightPayload)), { decision: "approve" });
  assert.equal(registry.get("claude-session-full"), undefined);
  const now = new Date().toISOString();
  registry.upsert({ id: "claude-session-full", machine_id: "machine-1", harness_type: "claude-code", cwd: "/repo", status: "running", created_at: now, last_activity_at: now, pending: null, title: "repo-a1" });
  const questionPayload = { ...payload, transcript_path: transcript };
  const envelope = toHookEnvelope("claude-code", "PreToolUse", questionPayload); const wait = hooks.ingest(envelope);
  await eventually(() => registry.get(envelope.session_id)?.pending?.type === "question");
  const pending = registry.get(envelope.session_id)?.pending;
  assert.equal(registry.get(envelope.session_id)?.title, "Plan the release safely.");
  assert.equal(pending?.id, "toolu_question_full");
  if (pending?.type === "question") { assert.deepEqual(pending.options, ["Safe", "Tests", "Lint"]); assert.equal(pending.questions?.[1]?.multiple, true); }
  hooks.respond(envelope.session_id, "toolu_question_full", '[["Safe"],["Tests","Lint"]]');
  const result = await wait;
  assert.deepEqual(result.updated_input, { answers: { "Which mode?": "Safe", "Which checks?": "Tests, Lint" } });
  const native = formatNativeResult("claude-code", "PreToolUse", payload, result) as { hookSpecificOutput: { updatedInput: Record<string, unknown> } };
  assert.deepEqual((native.hookSpecificOutput.updatedInput as { answers: unknown }).answers, { "Which mode?": "Safe", "Which checks?": "Tests, Lint" });
});

test("normalizes official OpenCode permission and multi-question event fixtures", async () => {
  const permission = await fixture<{ type: string; properties: Record<string, unknown> }>("opencode", "permission-asked.json");
  const question = await fixture<{ type: string; properties: Record<string, unknown> }>("opencode", "question-asked.json");
  const registry = new SessionRegistry(); const hooks = new HookIngestor("machine-1", registry, 1_000);
  const permissionWait = hooks.ingest(toHookEnvelope("opencode", permission.type, permission.properties)); await tick();
  assert.deepEqual(registry.get("opencode-session-full")?.pending && { id: registry.get("opencode-session-full")?.pending?.id, type: registry.get("opencode-session-full")?.pending?.type }, { id: "permission-full", type: "approval" });
  hooks.respond("opencode-session-full", "permission-full", "deny"); assert.deepEqual(await permissionWait, { decision: "deny" });
  const questionWait = hooks.ingest(toHookEnvelope("opencode", question.type, question.properties)); await tick();
  hooks.respond("opencode-session-full", "question-full", '[["Safe"],["Tests","Lint"]]');
  assert.deepEqual((await questionWait).updated_input, { answers: [["Safe"], ["Tests", "Lint"]] });
  assert.deepEqual(hooks.harnesses(), [{ harness_type: "opencode", discovered_sessions: 1, attached_sessions: 1, discovered_session_ids: ["opencode-session-full"], attached_session_ids: ["opencode-session-full"] }]);
  assert.equal(hooks.capabilities()[0]?.session_capabilities?.question_response.supported, true);
});

test("exact local resolution settles and removes only its matching waiter", async () => {
  const asked = await fixture<{ type: string; properties: Record<string, unknown> }>("opencode", "question-asked.json");
  const replied = await fixture<{ type: string; properties: Record<string, unknown> }>("opencode", "question-replied.json");
  const registry = new SessionRegistry(); const hooks = new HookIngestor("machine-1", registry, 1_000);
  const wait = hooks.ingest(toHookEnvelope("opencode", asked.type, asked.properties)); await tick();
  await hooks.ingest(toHookEnvelope("opencode", replied.type, replied.properties));
  assert.deepEqual(await wait, { decision: "neutral" }); assert.equal(registry.get("opencode-session-full")?.pending, null); assert.equal(hooks.target("opencode-session-full"), undefined);
});

test("replacement, timeout, and stop settle waiters without target leaks", async () => {
  const asked = await fixture<{ type: string; properties: Record<string, unknown> }>("opencode", "question-asked.json");
  const registry = new SessionRegistry(); const hooks = new HookIngestor("machine-1", registry, 20);
  const first = hooks.ingest(toHookEnvelope("opencode", asked.type, asked.properties)); await tick();
  const second = hooks.ingest(toHookEnvelope("opencode", asked.type, asked.properties)); await tick();
  assert.deepEqual(await first, { decision: "neutral" }); hooks.respond("opencode-session-full", "question-full", "free text");
  assert.deepEqual((await second).updated_input, { answers: [["free text"], []] }); assert.equal(hooks.target("opencode-session-full"), undefined);
  const timed = hooks.ingest(toHookEnvelope("opencode", asked.type, asked.properties)); assert.deepEqual(await timed, { decision: "neutral" });
  assert.equal(registry.get("opencode-session-full")?.pending, null); assert.equal(hooks.target("opencode-session-full"), undefined);
  const stopped = hooks.ingest(toHookEnvelope("opencode", asked.type, asked.properties)); await tick(); hooks.stop();
  assert.deepEqual(await stopped, { decision: "neutral" }); assert.equal(hooks.target("opencode-session-full"), undefined);
});

test("a timeout clears only its matching pending record and target", async () => {
  const fixtureEvent = await fixture<{ type: string; properties: Record<string, unknown> }>("opencode", "question-asked.json");
  const registry = new SessionRegistry(); const hooks = new HookIngestor("machine-1", registry, 50);
  const firstProps = { ...fixtureEvent.properties, id: "question-first" }; const first = hooks.ingest(toHookEnvelope("opencode", fixtureEvent.type, firstProps));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const secondProps = { ...fixtureEvent.properties, id: "question-second" }; const second = hooks.ingest(toHookEnvelope("opencode", fixtureEvent.type, secondProps));
  assert.deepEqual(await first, { decision: "neutral" }); assert.equal(registry.get("opencode-session-full")?.pending?.id, "question-second"); assert.ok(hooks.target("opencode-session-full"));
  hooks.respond("opencode-session-full", "question-second", "Safe"); assert.deepEqual((await second).updated_input, { answers: [["Safe"], []] });
});

test("the live OpenCode HTTP/SSE adapter prevents a plugin waiter", async () => {
  const asked = await fixture<{ type: string; properties: Record<string, unknown> }>("opencode", "question-asked.json");
  const registry = new SessionRegistry(); const hooks = new HookIngestor("machine-1", registry, 1_000);
  registry.upsert({ id: "opencode-session-full", machine_id: "machine-1", harness_type: "opencode", cwd: "/repo", status: "waiting_input", created_at: new Date().toISOString(), last_activity_at: new Date().toISOString(), pending: { type: "question", id: "live-question", session_id: "opencode-session-full", prompt: "Live", requested_at: new Date().toISOString() } }, { authority: 100 });
  hooks.setAuthoritativeTarget((harness, id) => harness === "opencode" && id === "opencode-session-full");
  assert.deepEqual(await hooks.ingest(toHookEnvelope("opencode", asked.type, asked.properties)), { decision: "neutral" });
  assert.equal(registry.get("opencode-session-full")?.pending?.id, "live-question"); assert.equal(hooks.target("opencode-session-full"), undefined);
});

test("maps Stop to waiting_input and only explicit session termination to completed", async () => {
  const registry = new SessionRegistry(); const hooks = new HookIngestor("machine-1", registry, 10);
  const stop = await fixture<Record<string, unknown>>("claude-code", "stop.json"); const ended = await fixture<Record<string, unknown>>("claude-code", "session-end.json");
  await hooks.ingest(toHookEnvelope("claude-code", "Stop", stop)); assert.equal(registry.get("claude-session-full")?.status, "waiting_input");
  await hooks.ingest(toHookEnvelope("claude-code", "SessionEnd", ended)); assert.equal(registry.get("claude-session-full")?.status, "completed");
  const idle = await fixture<{ type: string; properties: Record<string, unknown> }>("opencode", "session-idle.json"); await hooks.ingest(toHookEnvelope("opencode", idle.type, idle.properties));
  assert.equal(registry.get("opencode-session-full")?.status, "waiting_input");
});

test("records standalone Codex approval telemetry without a native response and clears it on the matching tool event", async () => {
  const permission = await fixture<Record<string, unknown>>("codex", "permission-request.json");
  const preTool = await fixture<Record<string, unknown>>("codex", "pre-tool-use.json");
  const registry = new SessionRegistry(); const hooks = new HookIngestor("machine-1", registry, 1_000);
  const envelope = toHookEnvelope("codex", "PermissionRequest", permission);
  assert.equal(envelope.request_id_kind, "telemetry"); assert.match(envelope.request_id ?? "", /^codex-telemetry-[a-f0-9]{32}$/);
  assert.deepEqual(await hooks.ingest(envelope), { decision: "neutral" });
  const pending = registry.get(envelope.session_id)?.pending;
  assert.equal(pending?.id, envelope.request_id); assert.equal(pending?.read_only, true); assert.equal(registry.get(envelope.session_id)?.read_only, true);
  assert.equal(hooks.target(envelope.session_id), undefined); assert.equal(hooks.capabilities()[0]?.session_capabilities?.approval_response.supported, false); assert.equal(hooks.capabilities()[0]?.session_capabilities?.question_response.supported, false);
  assert.deepEqual(hooks.harnesses()[0]?.discovered_session_ids, [envelope.session_id]);
  assert.deepEqual(await hooks.ingest(toHookEnvelope("codex", "PreToolUse", preTool)), { decision: "neutral" });
  assert.equal(registry.get(envelope.session_id)?.pending, null); assert.equal(registry.get(envelope.session_id)?.status, "running");
});

test("standalone Codex hooks do not overwrite an actively managed app-server session", async () => {
  const permission = await fixture<Record<string, unknown>>("codex", "permission-request.json"); const registry = new SessionRegistry(); const hooks = new HookIngestor("machine-1", registry, 1_000);
  registry.upsert({ id: "019c-codex-session-full", machine_id: "machine-1", harness_type: "codex", cwd: "/managed", status: "running", created_at: new Date().toISOString(), last_activity_at: new Date().toISOString(), pending: null, read_only: false, metadata: { codex_control: "app-server", transport: "codex-app-server" } });
  hooks.setAuthoritativeTarget((harness, id) => harness === "codex" && id === "019c-codex-session-full");
  assert.deepEqual(await hooks.ingest(toHookEnvelope("codex", "PermissionRequest", permission)), { decision: "neutral" });
  assert.equal(registry.get("019c-codex-session-full")?.cwd, "/managed"); assert.equal(registry.get("019c-codex-session-full")?.read_only, false); assert.equal(registry.get("019c-codex-session-full")?.pending, null);
});

test("rejects unverified harness payloads and malformed verified identities", async () => {
  const registry = new SessionRegistry(); const hooks = new HookIngestor("machine-1", registry, 10);
  await assert.rejects(hooks.ingest({ version: 1, harness: "grok", event: "PreToolUse", session_id: "s", cwd: "/repo", transport: "grok-hook", payload: {} }), /unsupported/);
  await assert.rejects(hooks.ingest({ version: 1, harness: "codex", event: "PreToolUse", session_id: "s", cwd: "/repo", transport: "codex-hook-command", payload: {} }), /identity/);
  const payload = await fixture<Record<string, unknown>>("claude-code", "ask-user-question.json");
  await assert.rejects(hooks.ingest({ ...toHookEnvelope("claude-code", "PreToolUse", payload), session_id: "wrong" }), /identity/);
});
