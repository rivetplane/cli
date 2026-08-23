import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { SessionManager } from "./session-manager.js";

async function until(check: () => boolean, timeout = 3_000): Promise<void> { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw new Error("Timed out"); await new Promise((resolve) => setTimeout(resolve, 15)); } }

async function agent(port = 0): Promise<{ server: Server; wss: WebSocketServer; port: number; stop(): Promise<void> }> {
  const server = createServer(); const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as { id?: number; method?: string };
    if (message.method === "initialize") socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }));
    if (message.method === "session/load") socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
  }));
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, wss, port: (server.address() as AddressInfo).port, stop: async () => { for (const client of wss.clients) client.terminate(); await new Promise<void>((resolve) => wss.close(() => resolve())); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

test("re-discovers and re-attaches after a harness restart without losing history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-cp-restart-")); let running = await agent();
  await writeFile(join(directory, "session.json"), JSON.stringify({ session_id: "s1", harness_type: "test", cwd: directory, endpoint: `ws://127.0.0.1:${running.port}` }));
  const manager = new SessionManager("m1", { directory, interval_ms: 25 }); manager.start();
  try {
    await until(() => manager.target("s1")?.connected === true); manager.registry.append("s1", "agent_message", { text: "keep me" });
    await running.stop(); await until(() => manager.target("s1") === undefined);
    running = await agent(running.port); await until(() => manager.target("s1")?.connected === true);
    assert.equal(manager.registry.transcript("s1").some((event) => event.type === "agent_message" && event.payload.text === "keep me"), true);
  } finally { manager.stop(); await running.stop(); }
});
