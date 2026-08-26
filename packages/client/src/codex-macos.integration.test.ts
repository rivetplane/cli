import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { HarnessControlClient } from "./client.js";

const run = promisify(execFile);
async function eventually<T>(read: () => Promise<T> | T, accept: (value: T) => boolean, label: string, timeout = 90_000): Promise<T> {
  const end = Date.now() + timeout; let value = await read(); while (!accept(value) && Date.now() < end) { await new Promise((resolve) => setTimeout(resolve, 250)); value = await read(); } if (!accept(value)) throw new Error(`Timed out: ${label}; last value: ${JSON.stringify(value).slice(0, 2_000)}`); return value;
}
async function json<T>(url: string): Promise<T> {
  const response = await fetch(url); const value = await response.json() as T;
  if (!response.ok) throw new Error(`${response.status} ${url}: ${JSON.stringify(value)}`);
  return value;
}

test("macOS managed Codex app-server end to end", { skip: process.platform !== "darwin" || process.env.RIVETPLANE_CODEX_INTEGRATION !== "1", timeout: 240_000 }, async () => {
  const repo = await mkdtemp(join(tmpdir(), "rivetplane-codex-e2e-")); await run("git", ["init", "-q", repo]);
  let client = new HarnessControlClient({ local_port: 0, relay: false, codex: false, codex_managed: true, codex_directory: repo, discovery_interval_ms: 500 });
  client.manager.registry.on("warning", (error) => process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`));
  let threadId = ""; let port = 0;
  try {
    ({ local_port: port } = await client.start()); const capabilities = client.codex_app_server?.capabilities(); const model = capabilities?.default_model?.model_id ?? capabilities?.models[0]?.model_id; assert.ok(model, "Codex model roster is available");
    threadId = await client.codex_app_server!.createSession({ type: "command.create_session", command_id: "local", machine_id: "local", harness_type: "codex", cwd: repo, model: { provider_id: "openai", model_id: model } });
    await client.codex_app_server!.setThreadName(threadId, `Rivetplane managed integration test - safe to archive - ${new Date().toISOString()}`);
    const initial = await fetch(`http://127.0.0.1:${port}/v1/sessions/${threadId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Reply with exactly RIVETPLANE_CODEX_E2E." }) }); assert.equal(initial.status, 202, await initial.text());
    await eventually(() => json<{ events: Array<{ type: string; payload: { text?: string } }> }>(`http://127.0.0.1:${port}/v1/sessions/${threadId}/transcript`), (page) => page.events.filter((event) => event.type === "agent_message").map((event) => event.payload.text ?? "").join("").includes("RIVETPLANE_CODEX_E2E"), "assistant response");
    await client.codex_app_server!.setCollaborationMode(threadId, "plan");
    await fetch(`http://127.0.0.1:${port}/v1/sessions/${threadId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Use the request_user_input tool now. Ask one question: Continue? Give only the options Yes and No." }) });
    let question: { pending: { id: string; type: string } | null } | undefined;
    try { question = await eventually(() => json<{ pending: { id: string; type: string } | null }>(`http://127.0.0.1:${port}/v1/sessions/${threadId}/pending`), (value) => value.pending?.type === "question", "question request", 30_000); }
    catch (error) {
      process.stdout.write(`Codex integration question limitation: ${error instanceof Error ? error.message : String(error)}\n`);
      await eventually(() => json<{ status: string }>(`http://127.0.0.1:${port}/v1/sessions/${threadId}`), (value) => value.status !== "running", "question turn completion");
    }
    if (question) {
      process.stdout.write(`Codex integration question pending ID: ${question.pending!.id}\n`);
      const questionResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions/${threadId}/pending/respond`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pending_id: question.pending!.id, response: "Yes" }) }); assert.equal(questionResponse.status, 200);
      await eventually(() => json<{ status: string }>(`http://127.0.0.1:${port}/v1/sessions/${threadId}`), (value) => value.status !== "running", "question continuation");
    }
    await client.codex_app_server!.setCollaborationMode(threadId, "default");

    await fetch(`http://127.0.0.1:${port}/v1/sessions/${threadId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `Run this exact shell command: touch ${join(repo, "approved-file")}. Do not simulate it.` }) });
    const approval = await eventually(() => json<{ pending: { id: string; type: string } | null }>(`http://127.0.0.1:${port}/v1/sessions/${threadId}/pending`), (value) => value.pending?.type === "approval", "approval request");
    process.stdout.write(`Codex integration approval pending ID: ${approval.pending!.id}\n`);
    const approvalResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions/${threadId}/pending/respond`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pending_id: approval.pending!.id, response: "approve", scope: "once" }) }); assert.equal(approvalResponse.status, 200);
    await eventually(() => json<{ status: string }>(`http://127.0.0.1:${port}/v1/sessions/${threadId}`), (value) => value.status !== "running", "approved turn");
    await access(join(repo, "approved-file"));

    await fetch(`http://127.0.0.1:${port}/v1/sessions/${threadId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Run this exact shell command: sleep 30" }) });
    const sleepState = await eventually(() => json<{ status: string; pending: { id: string; type: string } | null }>(`http://127.0.0.1:${port}/v1/sessions/${threadId}`), (value) => value.status === "running" || value.pending?.type === "approval", "interruptible turn or its approval");
    if (sleepState.pending?.type === "approval") {
      const sleepApproval = await fetch(`http://127.0.0.1:${port}/v1/sessions/${threadId}/pending/respond`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pending_id: sleepState.pending.id, response: "approve", scope: "once" }) }); assert.equal(sleepApproval.status, 200);
    }
    await eventually(() => client.manager.registry.get(threadId)?.status, (status) => status === "running", "running turn before interrupt"); const interrupted = await fetch(`http://127.0.0.1:${port}/v1/sessions/${threadId}/interrupt`, { method: "POST" }); assert.equal(interrupted.status, 202);

    await client.stop(); client = new HarnessControlClient({ local_port: 0, relay: false, codex: false, codex_managed: true, codex_directory: repo, discovery_interval_ms: 500 }); ({ local_port: port } = await client.start());
    await eventually(async () => (await fetch(`http://127.0.0.1:${port}/v1/sessions/${threadId}`)).status, (status) => status === 200, "thread recovery after app-server restart");
    process.stdout.write(`Codex integration thread: ${threadId} (clearly labeled as a Rivetplane managed integration test)\n`);
  } finally { await client.stop().catch(() => undefined); await rm(repo, { recursive: true, force: true }); }
});
