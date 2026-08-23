import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { ACPAttach } from "./acp-attach.js";
import { SessionRegistry } from "./registry.js";

async function until(check: () => boolean, timeout = 2_000): Promise<void> {
  const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw new Error("Timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); }
}

test("loads an existing ACP session, streams updates, and keeps approval IDs race-safe", async () => {
  const server = createServer(); const wss = new WebSocketServer({ server }); let socket: WebSocket | undefined; let permissionResult: unknown;
  wss.on("connection", (client) => {
    socket = client;
    client.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { id?: number; method?: string; result?: unknown };
      if (message.method === "initialize") client.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }));
      if (message.method === "session/load") {
        client.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
        setTimeout(() => client.send(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: { sessionId: "s1", toolCall: { toolCallId: "p1", title: "Shell", rawInput: { command: "pwd" } }, options: [{ optionId: "yes", kind: "allow_once", name: "Allow" }, { optionId: "no", kind: "reject_once", name: "Reject" }] } })), 20);
      }
      if (message.method === "session/prompt") {
        client.send(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } }));
        client.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } }));
      }
      if (message.id === 99 && message.result) permissionResult = message.result;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const registry = new SessionRegistry();
  const attach = new ACPAttach({ session_id: "s1", harness_type: "test", cwd: "/tmp", transport: { kind: "websocket", url: `ws://127.0.0.1:${port}` } }, registry, "m1");
  try {
    await attach.connect(); await until(() => registry.get("s1")?.pending?.id === "p1");
    assert.throws(() => attach.respondToPending("stale", "approve"), /no longer active/);
    attach.respondToPending("p1", "approve", "once"); await until(() => permissionResult !== undefined);
    await attach.sendMessage("continue");
    assert.equal(registry.transcript("s1").some((event) => event.type === "agent_message" && event.payload.text === "done"), true);
    assert.deepEqual(permissionResult, { outcome: { outcome: "selected", optionId: "yes" } });
  } finally { attach.close(); socket?.close(); wss.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
