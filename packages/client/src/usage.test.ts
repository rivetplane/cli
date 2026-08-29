import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acpUsageSample } from "./acp-attach.js";
import { claudeMessageUsage, claudeStatusUsage } from "./claude-code-discovery.js";
import { codexAccountUsage, codexRateLimits, codexThreadUsage } from "./codex-app-server.js";
import { openCodeMessageUsage } from "./opencode-manager.js";
import { UsageCollector } from "./usage.js";
import { HookIngestor } from "./hook-ingestion.js";
import { SessionRegistry } from "./registry.js";
import type { UsageSample } from "@rivetplane/shared/model";

test("normalizes cumulative counters, deduplicates replay, and keeps a restart baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "rivetplane-usage-")); const checkpoint = join(root, "usage.json");
  const raw = (input: number) => ({ session_id: "s1", harness: "codex", provider: "openai", source: "fixture", source_counter_mode: "cumulative" as const, counter_key: "s1", tokens: { input }, cost: { status: "unavailable" as const } });
  try {
    const first = new UsageCollector("m1", { checkpoint_path: checkpoint, now: () => 1_700_000_000_000 }); await first.start();
    assert.equal(first.ingest(raw(100))?.tokens.input, 100);
    assert.equal(first.ingest(raw(100)), undefined, "same snapshot has the same event ID");
    assert.equal(first.ingest(raw(130))?.tokens.input, 30);
    assert.equal(first.ingest(raw(10))?.tokens.input, 0, "counter reset is not counted");
    assert.equal(first.ingest(raw(15))?.tokens.input, 5, "the reset value becomes the new baseline");
    await first.flush();
    const restarted = new UsageCollector("m1", { checkpoint_path: checkpoint }); await restarted.start();
    assert.equal(restarted.ingest(raw(20))?.tokens.input, 5, "restart uses the durable reset baseline");
    await restarted.flush();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stable event IDs include machine identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "rivetplane-usage-machines-"));
  try { const left = new UsageCollector("m1", { checkpoint_path: join(root, "left.json") }); const right = new UsageCollector("m2", { checkpoint_path: join(root, "right.json") }); await Promise.all([left.start(), right.start()]); const raw = { session_id: "s1", harness: "opencode", source: "fixture", source_event_id: "message-1", source_counter_mode: "incremental" as const, tokens: { total: 1 } }; assert.notEqual(left.ingest(raw)?.event_id, right.ingest(raw)?.event_id); await Promise.all([left.flush(), right.flush()]); } finally { await rm(root, { recursive: true, force: true }); }
});

test("ACP usage_update maps context state without inventing token counts", () => {
  const sample = acpUsageSample("s1", "gemini", { used: 12_000, size: 128_000, cost: { amount: 1.25, currencyCode: "usd" } });
  assert.deepEqual(sample?.tokens, {}); assert.deepEqual(sample?.context, { window_size: 128_000, used_tokens: 12_000 });
  assert.deepEqual(sample?.cost, { status: "reported", amount: 1.25, currency: "usd" }); assert.equal(sample?.source_counter_mode, "cumulative");
});

test("Codex official token and account fields stay separate", () => {
  const sample = codexThreadUsage({ threadId: "t1", turnId: "turn-1", tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 25, cacheWriteInputTokens: 3, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 125 }, last: {}, modelContextWindow: 200_000 } }, "gpt-5");
  assert.deepEqual(sample?.tokens, { input: 100, output: 20, reasoning: 5, cache_read: 25, cache_write: 3, total: 125 }); assert.deepEqual(sample?.context, { window_size: 200_000, used_tokens: 125 });
  const account = codexAccountUsage({ summary: {}, threadUsage: { threadId: "t1", estimatedUsageCreditsMicros: 1_500_000, estimatedUsageUsdMicros: null, groups: [{ model: "gpt-5", netNewInputTokens: 300, cachedInputTokens: 200, outputTokens: 50, totalTokens: 550 }] } });
  assert.equal(account?.session_id, "t1"); assert.deepEqual(account?.cost, { status: "estimated", amount: 1.5, currency: "CREDITS" }); assert.deepEqual(account?.tokens, {}, "overlapping account tokens do not enter additive totals");
  assert.deepEqual(codexRateLimits({ rateLimits: { primary: { usedPercent: 42, resetsAt: 1_700_000_000 }, credits: { balance: 9 } } }), [{ name: "primary", used_percent: 42, resets_at: "2023-11-14T22:13:20.000Z" }, { name: "credits", remaining: 9 }]);
});

test("Claude session records and status-line-shaped state expose only usage metadata", () => {
  const message = claudeMessageUsage("s1", "message-1", { message: { model: "claude-sonnet", usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 6, cache_creation_input_tokens: 2 }, content: [{ type: "text", text: "secret" }] }, costUSD: 0.03 }, "2026-08-29T00:00:00Z");
  assert.deepEqual(message?.tokens, { input: 10, output: 4, cache_read: 6, cache_write: 2, total: 22 }); assert.equal(JSON.stringify(message).includes("secret"), false); assert.equal(message?.cost?.status, "estimated");
  const status = claudeStatusUsage("s1", { context_window: { context_window_size: 200_000, current_usage: { input_tokens: 50, output_tokens: 10 } }, cost: { total_cost_usd: 0.5 }, rate_limits: { five_hour: { used_percentage: 20, resets_at: "2026-08-29T05:00:00Z" } } });
  assert.deepEqual(status?.context, { window_size: 200_000, used_tokens: 60 }); assert.equal(status?.tokens.input, undefined); assert.equal(status?.cost?.status, "estimated");
});

test("Claude StatusLine ingestion emits usage only", async () => {
  const root = await mkdtemp(join(tmpdir(), "rivetplane-status-")); const collector = new UsageCollector("m1", { checkpoint_path: join(root, "usage.json") }); await collector.start();
  const samples: UsageSample[] = []; collector.on("usage", (sample: UsageSample) => samples.push(sample)); const ingestor = new HookIngestor("m1", new SessionRegistry()); ingestor.setUsage(collector);
  try {
    await ingestor.ingest({ version: 1, harness: "claude-code", event: "StatusLine", session_id: "s1", cwd: "/repo", transport: "claude-code-hook-command", payload: { session_id: "s1", cwd: "/repo", model: { id: "claude-sonnet" }, context_window: { context_window_size: 200_000, current_usage: { input_tokens: 80 } }, cost: { total_cost_usd: 0.25 }, rate_limits: { five_hour: { used_percentage: 10 } }, prompt: "must-not-relay", transcript_path: "/private/transcript" } });
    assert.equal(samples.length, 1); assert.equal(samples[0]?.model, "claude-sonnet"); assert.equal(JSON.stringify(samples[0]).includes("must-not-relay"), false); assert.equal(JSON.stringify(samples[0]).includes("transcript"), false);
    await collector.flush();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("OpenCode native message fields are incremental and content-free", () => {
  const sample = openCodeMessageUsage("s1", { id: "m1", providerID: "anthropic", modelID: "claude", tokens: { input: 10, output: 3, reasoning: 2, cache: { read: 5, write: 1 } }, cost: 0.04, parts: [{ text: "private" }], time: { created: 1_700_000_000_000 } }, 100_000);
  assert.deepEqual(sample?.tokens, { input: 10, output: 3, reasoning: 2, cache_read: 5, cache_write: 1, total: 21 }); assert.equal(sample?.cost?.status, "reported"); assert.equal(JSON.stringify(sample).includes("private"), false);
});
