import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

test("discovers rollouts independent of cwd, deduplicates, checkpoints, and handles truncation", async () => {
  const root = await mkdtemp(join(tmpdir(), "rivetplane-codex-rollout-")); const sessions = join(root, "sessions", "2026", "08", "25"); const checkpoint = join(root, "config", "checkpoint.json");
  await mkdir(sessions, { recursive: true }); const path = join(sessions, "rollout-test.jsonl"); const original = await readFile(fixture, "utf8"); await writeFile(path, original);
  const registry = new SessionRegistry(); const discovery = new CodexRolloutDiscovery("machine-1", registry, { sessions_directory: join(root, "sessions"), checkpoint_path: checkpoint, now: () => Date.parse("2026-08-25T10:01:00Z") });
  try {
    await discovery.poll(); assert.equal(registry.get("019c-test-thread")?.cwd, "/tmp/disposable-repo"); assert.equal(registry.get("019c-test-thread")?.read_only, true);
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
