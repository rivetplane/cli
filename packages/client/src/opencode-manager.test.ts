import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { OpenCodeManager } from "./opencode-manager.js";
import { SessionRegistry } from "./registry.js";

test("controls OpenCode sessions through the native SDK", async () => {
  let pending: "approval" | "question" | "none" = "approval";
  const requests: Array<{ method: string; path: string; body: string }> = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    requests.push({ method: request.method ?? "GET", path, body });
    response.setHeader("content-type", "application/json");
    const session = { id: "open-1", slug: "one", projectID: "p1", directory: "/repo", title: "Test", version: "1", time: { created: 1_700_000_000_000, updated: 1_700_000_001_000 } };
    const created = { ...session, id: "open-2", title: "Created" };
    if (path === "/global/health") response.end(JSON.stringify({ healthy: true, version: "test" }));
    else if (path === "/provider") response.end(JSON.stringify({ connected: ["provider-1"], default: { "provider-1": "model-1" }, all: [{ id: "provider-1", name: "Provider", source: "config", env: [], options: {}, models: { "model-1": { id: "model-1", providerID: "provider-1", name: "Model One", status: "active", limit: { context: 1000, output: 100 }, capabilities: {}, cost: {}, options: {}, headers: {}, api: {}, release_date: "2026-01-01" } } }] }));
    else if (path === "/session" && request.method === "POST") response.end(JSON.stringify(created));
    else if (path === "/session") response.end(JSON.stringify([session]));
    else if (path === "/session/status") response.end(JSON.stringify({ "open-1": { type: "idle" } }));
    else if (path === "/session/open-1/message") response.end(JSON.stringify([
      { info: { id: "m1", sessionID: "open-1", role: "user", time: { created: 1 } }, parts: [{ id: "p1", sessionID: "open-1", messageID: "m1", type: "text", text: "hello" }] },
      { info: { id: "m2", sessionID: "open-1", role: "assistant", time: { created: 2 } }, parts: [{ id: "p2", sessionID: "open-1", messageID: "m2", type: "text", text: "hi" }] },
    ]));
    else if (path === "/session/open-2/message") response.end("[]");
    else if (path === "/permission") response.end(JSON.stringify(pending === "approval" ? [{ id: "perm-1", sessionID: "open-1", permission: "bash", patterns: ["npm test"], metadata: {}, always: [] }] : []));
    else if (path === "/question") response.end(JSON.stringify(pending === "question" ? [{ id: "question-1", sessionID: "open-1", questions: [{ header: "Mode", question: "Which mode?", options: [{ label: "Safe", description: "Use safe mode" }] }] }] : []));
    else if (path === "/permission/perm-1/reply" || path === "/question/question-1/reply" || path === "/session/open-1/prompt_async" || path === "/session/open-1/abort") response.end("true");
    else { response.statusCode = 404; response.end(JSON.stringify({ error: "not found" })); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const registry = new SessionRegistry(); const manager = new OpenCodeManager("machine-1", registry, { url, directory: "/repo" });
  try {
    await manager.poll();
    assert.equal(manager.harnesses()[0]?.attached_sessions, 1);
    assert.equal(manager.capabilities()?.models[0]?.model_id, "model-1");
    assert.equal(registry.get("open-1")?.pending?.id, "perm-1");
    assert.deepEqual(registry.transcript("open-1").filter((event) => event.type.endsWith("message")).map((event) => event.payload), [{ text: "hello" }, { text: "hi" }]);
    await manager.target("open-1")?.respondToPending("perm-1", "approve", "once");
    assert.equal(JSON.parse(requests.find((item) => item.path === "/permission/perm-1/reply")?.body ?? "{}" as string).reply, "once");

    pending = "question"; await manager.poll();
    assert.equal(registry.get("open-1")?.pending?.id, "question-1");
    await manager.target("open-1")?.respondToPending("question-1", "Safe");
    assert.deepEqual(JSON.parse(requests.find((item) => item.path === "/question/question-1/reply")?.body ?? "{}" as string).answers, [["Safe"]]);

    await manager.target("open-1")?.sendMessage("continue");
    assert.equal(JSON.parse(requests.find((item) => item.path === "/session/open-1/prompt_async")?.body ?? "{}" as string).parts[0].text, "continue");
    await manager.target("open-1")?.interrupt();
    assert.equal(requests.some((item) => item.path === "/session/open-1/abort"), true);
    const createdId = await manager.createSession({ type: "command.create_session", command_id: "create-1", machine_id: "machine-1", harness_type: "opencode", cwd: "/repo", title: "Created", model: { provider_id: "provider-1", model_id: "model-1" } });
    assert.equal(createdId, "open-2");
    const createBody = JSON.parse(requests.find((item) => item.path === "/session" && item.method === "POST")?.body ?? "{}");
    assert.deepEqual(createBody.model, { providerID: "provider-1", id: "model-1" });
  } finally { manager.stop(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
