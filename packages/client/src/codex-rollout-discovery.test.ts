import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexRolloutDiscovery, parseCodexRolloutLine } from "./codex-rollout-discovery.js";
import { SessionRegistry } from "./registry.js";

const fixture = join(process.cwd(), "src", "fixtures", "codex", "rollout-basic.jsonl");

test("parses supported rollout lines and ignores malformed or unknown schemas", async () => {
  const lines = (await readFile(fixture, "utf8")).trim().split("\n");
  assert.equal(parseCodexRolloutLine(lines[0]!, "fallback").meta?.id, "019c-test-thread");
  assert.equal(parseCodexRolloutLine(lines[1]!, "019c-test-thread").event?.type, "user_message");
  assert.equal(parseCodexRolloutLine(lines[2]!, "019c-test-thread").event, undefined);
  assert.deepEqual(parseCodexRolloutLine("{partial", "fallback"), {});
  assert.deepEqual(parseCodexRolloutLine(lines.at(-1)!, "fallback"), {});
});

test("detects and resolves explicit escalated Codex custom tool approvals", async () => {
  const root = await mkdtemp(join(tmpdir(), "rivetplane-codex-approval-")); const sessions = join(root, "sessions"); const checkpoint = join(root, "checkpoint.json");
  await mkdir(sessions, { recursive: true }); const path = join(sessions, "rollout-approval.jsonl");
  const meta = { timestamp: "2026-08-27T03:16:40.000Z", type: "session_meta", payload: { id: "codex-approval", timestamp: "2026-08-27T03:16:40.000Z", cwd: "/tmp/repo", cli_version: "0.149.1", model_provider: "openai" } };
  const request = { timestamp: "2026-08-27T03:16:47.000Z", type: "response_item", payload: { type: "custom_tool_call", call_id: "call-approval", name: "exec", input: 'const r = await tools.exec_command({ cmd: "open .", sandbox_permissions: "require_escalated", justification: "Open the workspace?" });' } };
  await writeFile(path, `${JSON.stringify(meta)}\n${JSON.stringify(request)}\n`);
  const registry = new SessionRegistry(); const discovery = new CodexRolloutDiscovery("machine-1", registry, { sessions_directory: sessions, checkpoint_path: checkpoint, scan_interval_ms: 1 });
  try {
    await discovery.poll(); const pending = registry.get("codex-approval")?.pending;
    assert.equal(pending?.type, "approval"); assert.equal(pending?.id, "call-approval"); assert.equal(pending?.read_only, true);
    assert.equal(registry.get("codex-approval")?.status, "waiting_approval"); assert.match(pending?.type === "approval" ? pending.tool_input_summary : "", /Open the workspace/);
    assert.deepEqual(registry.transcript("codex-approval").map((event) => event.type), ["tool_call", "status_change", "permission_request"]);
    const output = { timestamp: "2026-08-27T03:18:55.000Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-approval", output: "aborted by user after 127.8s" } };
    await writeFile(path, `${JSON.stringify(meta)}\n${JSON.stringify(request)}\n${JSON.stringify(output)}\n`); await discovery.poll();
    assert.equal(registry.get("codex-approval")?.pending, null); assert.equal(registry.get("codex-approval")?.status, "completed");
    assert.deepEqual(registry.transcript("codex-approval").map((event) => event.type), ["tool_call", "status_change", "permission_request", "tool_result", "status_change", "permission_response"]);
  } finally { discovery.stop(); await rm(root, { recursive: true, force: true }); }
});

test("detects and resolves standalone Codex request_user_input questions as read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "rivetplane-codex-question-")); const sessions = join(root, "sessions"); const checkpoint = join(root, "checkpoint.json");
  await mkdir(sessions, { recursive: true }); const path = join(sessions, "rollout-question.jsonl");
  const meta = { timestamp: "2026-08-27T02:45:20.000Z", type: "session_meta", payload: { id: "codex-question", timestamp: "2026-08-27T02:45:20.000Z", cwd: "/tmp/repo", cli_version: "0.149.1", model_provider: "openai" } };
  const request = { timestamp: "2026-08-27T02:45:29.000Z", type: "response_item", payload: { type: "function_call", name: "request_user_input", call_id: "call-question", arguments: JSON.stringify({ questions: [{ header: "Color", id: "color", question: "Choose a color.", options: [{ label: "Red", description: "Choose Red." }, { label: "Blue", description: "Choose Blue." }] }] }) } };
  await writeFile(path, `${JSON.stringify(meta)}\n${JSON.stringify(request)}\n`);
  const registry = new SessionRegistry(); const discovery = new CodexRolloutDiscovery("machine-1", registry, { sessions_directory: sessions, checkpoint_path: checkpoint, scan_interval_ms: 1 });
  try {
    await discovery.poll(); const pending = registry.get("codex-question")?.pending;
    assert.equal(pending?.type, "question"); assert.equal(pending?.id, "call-question"); assert.equal(pending?.read_only, true); assert.deepEqual(pending?.type === "question" ? pending.options : [], ["Red", "Blue"]);
    assert.equal(registry.get("codex-question")?.status, "waiting_input");
    const output = { timestamp: "2026-08-27T02:46:00.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "call-question", output: JSON.stringify({ color: "Blue" }) } };
    await writeFile(path, `${JSON.stringify(meta)}\n${JSON.stringify(request)}\n${JSON.stringify(output)}\n`); await discovery.poll();
    assert.equal(registry.get("codex-question")?.pending, null); assert.equal(registry.get("codex-question")?.status, "completed");
  } finally { discovery.stop(); await rm(root, { recursive: true, force: true }); }
});

test("treats a missing Codex sessions directory as an inactive harness without warnings", async () => {
  const root = await mkdtemp(join(tmpdir(), "rivetplane-codex-missing-"));
  const registry = new SessionRegistry(); const warnings: unknown[] = [];
  registry.on("warning", (warning) => warnings.push(warning));
  const discovery = new CodexRolloutDiscovery("machine-1", registry, { sessions_directory: join(root, "missing"), checkpoint_path: join(root, "checkpoint.json") });
  try {
    await discovery.poll(); await discovery.poll();
    assert.deepEqual(discovery.harnesses(), []); assert.deepEqual(warnings, []);
  } finally { discovery.stop(); await rm(root, { recursive: true, force: true }); }
});

test("discovers rollouts independent of cwd, deduplicates, checkpoints, and handles truncation", async () => {
  const root = await mkdtemp(join(tmpdir(), "rivetplane-codex-rollout-")); const sessions = join(root, "sessions", "2026", "08", "25"); const checkpoint = join(root, "config", "checkpoint.json");
  await mkdir(sessions, { recursive: true }); const path = join(sessions, "rollout-test.jsonl"); const original = await readFile(fixture, "utf8"); await writeFile(path, original);
  const registry = new SessionRegistry(); const discovery = new CodexRolloutDiscovery("machine-1", registry, { sessions_directory: join(root, "sessions"), checkpoint_path: checkpoint, now: () => Date.parse("2026-08-25T10:01:00Z") });
  try {
    await discovery.poll(); assert.equal(registry.get("019c-test-thread")?.cwd, "/tmp/disposable-repo"); assert.equal(registry.get("019c-test-thread")?.read_only, true); assert.equal(registry.get("019c-test-thread")?.title, "hello");
    assert.deepEqual({ harness_type: discovery.capabilities()?.harness_type, can_create_session: discovery.capabilities()?.can_create_session, transport: discovery.capabilities()?.transport }, { harness_type: "codex", can_create_session: false, transport: "codex-rollout-jsonl" });
    assert.equal(discovery.capabilities()?.session_capabilities?.discovery.mode, "read_only");
    assert.equal(registry.get("019c-test-thread")?.metadata && (registry.get("019c-test-thread")!.metadata as Record<string, unknown>).live_process_attached, false);
    assert.deepEqual(registry.transcript("019c-test-thread").map((event) => event.type), ["user_message", "agent_message", "tool_call", "tool_result"]);
    await discovery.poll(); assert.equal(registry.transcript("019c-test-thread").length, 4);
    await writeFile(path, `${original}{\"timestamp\":\"2026-08-25T10:00:08.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"partial\"}]}}`);
    await discovery.poll(); assert.equal(registry.transcript("019c-test-thread").length, 4, "partial JSONL is not consumed");
    await writeFile(path, `${original}{\"timestamp\":\"2026-08-25T10:00:08.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"partial\"}]}}\n`);
    await discovery.poll(); assert.equal(registry.transcript("019c-test-thread").length, 5);
    await writeFile(path, original); await discovery.poll(); assert.equal(registry.transcript("019c-test-thread").length, 5, "stable IDs deduplicate after truncation");
    assert.equal(JSON.parse(await readFile(checkpoint, "utf8")).version, 1);
    const recoveredRegistry = new SessionRegistry(); const recovered = new CodexRolloutDiscovery("machine-1", recoveredRegistry, { sessions_directory: join(root, "sessions"), checkpoint_path: checkpoint });
    await recovered.poll(); assert.equal(recoveredRegistry.transcript("019c-test-thread").length, 4, "a new process reconstructs its bounded local transcript from stable events"); recovered.stop();
  } finally { discovery.stop(); await rm(root, { recursive: true, force: true }); }
});

test("skips an over-limit JSONL line and continues at the next complete event", async () => {
  const root = await mkdtemp(join(tmpdir(), "rivetplane-codex-long-line-")); const sessions = join(root, "sessions"); const path = join(sessions, "rollout-test.jsonl");
  await mkdir(sessions, { recursive: true }); const original = await readFile(fixture, "utf8"); await writeFile(path, original);
  const registry = new SessionRegistry(); const discovery = new CodexRolloutDiscovery("machine-1", registry, { sessions_directory: sessions, checkpoint_path: join(root, "checkpoint.json"), max_incremental_bytes: 256 });
  try {
    await discovery.poll(); await writeFile(path, `${original}${"x".repeat(300)}\n{"timestamp":"2026-08-25T10:00:09.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"after long line"}]}}\n`);
    for (let index = 0; index < 4; index += 1) await discovery.poll();
    assert.equal(registry.transcript("019c-test-thread").filter((event) => event.type === "agent_message").at(-1)?.payload.text, "after long line");
  } finally { discovery.stop(); await rm(root, { recursive: true, force: true }); }
});

test("relays only a bounded recent rollout roster and removes stale live entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "rivetplane-codex-bounded-")); const sessions = join(root, "sessions"); await mkdir(sessions, { recursive: true });
  const original = await readFile(fixture, "utf8"); let now = Date.now();
  for (let index = 0; index < 4; index += 1) {
    const id = `thread-${index}`; const content = original.replaceAll("019c-test-thread", id); const path = join(sessions, `rollout-${index}.jsonl`);
    await writeFile(path, content); const time = new Date(now - index * 1_000); await utimes(path, time, time);
  }
  const registry = new SessionRegistry(); const discovery = new CodexRolloutDiscovery("machine-1", registry, { sessions_directory: sessions, checkpoint_path: join(root, "checkpoint.json"), max_sessions: 2, scan_interval_ms: 1, now: () => now });
  try {
    await discovery.poll(); assert.deepEqual(registry.list().map((session) => session.id).sort(), ["thread-0", "thread-1"]);
    const path = join(sessions, "rollout-0.jsonl"); await rm(path); now += 2; await discovery.poll();
    assert.equal(registry.get("thread-0"), undefined); assert.equal(registry.list().length, 2);
  } finally { discovery.stop(); await rm(root, { recursive: true, force: true }); }
});
