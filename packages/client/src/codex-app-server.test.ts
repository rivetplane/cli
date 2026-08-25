import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { CodexAppServerManager } from "./codex-app-server.js";
import { SessionRegistry } from "./registry.js";

type Message = Record<string, unknown>;
async function eventually(check: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 2_000; while (Date.now() < end) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error(`Timed out: ${label}`);
}

test("uses app-server request IDs exactly and supports messages, questions, approvals, interrupts, and unknown events", async () => {
  const http = createServer(); const server = new WebSocketServer({ server: http }); const received: Message[] = []; let peer: WebSocket | undefined;
  server.on("connection", (socket) => {
    peer = socket; socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Message; received.push(message); if (message.id === undefined || typeof message.method !== "string") return;
      const id = message.id; const method = message.method;
      if (method === "initialize") socket.send(JSON.stringify({ id, result: { userAgent: "codex-cli/0.148.0", platformFamily: "unix", platformOs: "macos" } }));
      else if (method === "model/list") socket.send(JSON.stringify({ id, result: { data: [{ id: "gpt-test", model: "gpt-test", displayName: "GPT Test" }], nextCursor: null } }));
      else if (method === "thread/list") socket.send(JSON.stringify({ id, result: { data: [{ id: "thread-1", sessionId: "thread-1", parentThreadId: null, cwd: "/repo", createdAt: 1, updatedAt: 2, status: { type: "idle" }, preview: "Test", name: null, modelProvider: "openai", cliVersion: "0.148.0", source: "appServer" }], nextCursor: null } }));
      else if (method === "thread/read") socket.send(JSON.stringify({ id, result: { thread: { turns: [{ id: "old-turn", status: "completed", completedAt: 3, items: [{ type: "userMessage", id: "old-user", content: [{ type: "text", text: "old", text_elements: [] }] }, { type: "agentMessage", id: "old-agent", text: "answer" }] }] } } }));
      else if (method === "thread/resume") socket.send(JSON.stringify({ id, result: { thread: { id: "thread-1" } } }));
      else if (method === "turn/start") { socket.send(JSON.stringify({ id, result: { turn: { id: "turn-1", status: "inProgress", items: [] } } })); socket.send(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "agent-live", delta: "stream" } })); }
      else if (method === "turn/interrupt") socket.send(JSON.stringify({ id, result: {} }));
      else socket.send(JSON.stringify({ id, error: { code: -32601, message: "unknown" } }));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve)); const port = (http.address() as AddressInfo).port;
  const registry = new SessionRegistry(); const manager = new CodexAppServerManager("machine-1", registry, { endpoint: `ws://127.0.0.1:${port}`, directory: "/repo", interval_ms: 60_000 });
  try {
    await manager.start(); assert.equal(registry.get("thread-1")?.read_only, false); assert.equal(manager.health().live_attachment.supported, true);
    assert.deepEqual(registry.transcript("thread-1").map((event) => event.type), ["user_message", "agent_message"]);
    await manager.target("thread-1")!.sendMessage("continue"); await eventually(() => registry.transcript("thread-1").some((event) => event.type === "agent_message" && event.payload.text === "stream"), "streamed delta");
    await manager.target("thread-1")!.interrupt(); assert.equal(received.some((message) => message.method === "turn/interrupt" && (message.params as Message).turnId === "turn-1"), true);

    peer!.send(JSON.stringify({ method: "item/commandExecution/requestApproval", id: 42, params: { threadId: "thread-1", turnId: "turn-2", itemId: "cmd-1", startedAtMs: 1_000, command: "echo test" } }));
    await eventually(() => registry.get("thread-1")?.pending?.id === "42", "approval request"); await manager.target("thread-1")!.respondToPending("42", "approve", "once");
    await eventually(() => received.some((message) => message.id === 42 && (message.result as Message)?.decision === "accept"), "exact numeric approval response ID");

    peer!.send(JSON.stringify({ method: "item/tool/requestUserInput", id: "question-7", params: { threadId: "thread-1", turnId: "turn-3", itemId: "question-item", questions: [{ id: "mode", header: "Mode", question: "Which mode?", isOther: true, isSecret: false, options: [{ label: "Safe", description: "Use safe mode" }] }], isBlocking: true } }));
    await eventually(() => registry.get("thread-1")?.pending?.id === "question-7", "question request"); await manager.target("thread-1")!.respondToPending("question-7", "Safe");
    await eventually(() => received.some((message) => message.id === "question-7" && ((message.result as Message)?.answers as Message)?.mode !== undefined), "exact string question response ID");

    peer!.send(JSON.stringify({ method: "future/event", params: { value: true } }));
    peer!.send(JSON.stringify({ method: "future/request", id: "future-1", params: {} }));
    await eventually(() => received.some((message) => message.id === "future-1" && (message.error as Message)?.code === -32601), "safe unknown request response");

    peer!.send(JSON.stringify({ method: "item/commandExecution/requestApproval", id: 99, params: { threadId: "thread-1", turnId: "turn-4", itemId: "cmd-stale", command: "echo stale" } }));
    await eventually(() => registry.get("thread-1")?.pending?.id === "99", "pending request before disconnect"); peer!.close();
    await eventually(() => registry.get("thread-1")?.pending === null && manager.health().live_attachment.supported === false, "stale request cleanup after disconnect");
  } finally { await manager.stop(); await new Promise<void>((resolve) => server.close(() => http.close(() => resolve()))); }
});
