import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { WebSocketServer } from "ws";
import { OutboundRelay } from "./relay.js";
import { SessionRegistry } from "./registry.js";

async function until(check: () => boolean, timeout = 2_000): Promise<void> { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw new Error("Timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); } }

test("authenticates outbound relay, sends state, and applies inbound commands", async () => {
  const server = createServer(); const wss = new WebSocketServer({ server }); const received: Array<Record<string, unknown>> = []; let authorization = ""; let sentText = "";
  wss.on("connection", (socket, request) => {
    authorization = request.headers.authorization ?? "";
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>; received.push(message);
      if (message.type === "session.upsert") socket.send(JSON.stringify({ type: "command.send_message", command_id: "c1", session_id: (message.session as { id: string }).id, text: "go" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as AddressInfo).port;
  const registry = new SessionRegistry(); registry.upsert({ id: "s1", machine_id: "m1", harness_type: "test", cwd: "/tmp", status: "waiting_input", created_at: "2026-01-01T00:00:00Z", last_activity_at: "2026-01-01T00:00:00Z", pending: null });
  registry.append("s1", "agent_message", { text: "existing transcript" });
  const relay = new OutboundRelay({ server_url: `http://127.0.0.1:${port}`, machine_id: "m1", machine_name: "test", device_id: "00000000-0000-4000-8000-000000000001", owner_account_id: "a1", token: "secret" }, registry, () => ({ sendMessage: async (text) => { sentText = text; }, respondToPending: () => {}, interrupt: () => {} }));
  try {
    relay.start(); await until(() => received.some((message) => message.type === "command.result"));
    assert.equal(authorization, "Bearer secret"); assert.equal(received[0]?.type, "machine.hello"); assert.equal(sentText, "go");
    assert.equal(received.some((message) => message.type === "session.upsert"), true);
    assert.equal((received.find((message) => message.type === "session.upsert")?.session as { id: string }).id, "m1/test/s1");
    const replayed = received.find((message) => message.type === "transcript.append")?.event as { session_id: string; payload: { text: string } };
    assert.equal(replayed.session_id, "m1/test/s1"); assert.equal(replayed.payload.text, "existing transcript");
  } finally { relay.stop(); for (const client of wss.clients) client.terminate(); await new Promise<void>((resolve) => wss.close(() => resolve())); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("sends snapshots and capabilities before bounded round-robin replay", async () => {
  const server = createServer(); const wss = new WebSocketServer({ server }); const received: Array<Record<string, unknown>> = [];
  wss.on("connection", (socket) => socket.on("message", (raw) => received.push(JSON.parse(raw.toString()) as Record<string, unknown>)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as AddressInfo).port;
  const registry = new SessionRegistry();
  for (const id of ["s1", "s2"]) {
    registry.upsert({ id, machine_id: "m1", harness_type: id === "s1" ? "codex" : "opencode", cwd: "/tmp", status: "waiting_input", created_at: "2026-01-01T00:00:00Z", last_activity_at: "2026-01-01T00:00:00Z", pending: null });
    for (let index = 0; index < 510; index++) registry.append(id, "agent_message", { text: `${id}-${index}` }, { id: `${id}-${index}` });
  }
  const relay = new OutboundRelay({ server_url: `http://127.0.0.1:${port}`, machine_id: "m1", machine_name: "test", device_id: "00000000-0000-4000-8000-000000000001", owner_account_id: "a1", token: "secret" }, registry, () => undefined, {
    capabilities: () => [{ machine_id: "m1", harness_type: "opencode", can_create_session: false, directories: ["/tmp"], models: [], reported_at: new Date().toISOString() }],
  });
  try {
    relay.start(); await until(() => received.filter((message) => message.type === "transcript.append").length === 1_000);
    const firstTranscript = received.findIndex((message) => message.type === "transcript.append");
    assert.ok(received.slice(0, firstTranscript).filter((message) => message.type === "session.upsert").length === 2);
    assert.ok(received.slice(0, firstTranscript).some((message) => message.type === "harness.capabilities"));
    const firstFour = received.filter((message) => message.type === "transcript.append").slice(0, 4).map((message) => ((message.event as { payload: { text: string } }).payload.text));
    assert.deepEqual(firstFour, ["s1-10", "s2-10", "s1-11", "s2-11"]);
    assert.equal(received.filter((message) => message.type === "transcript.append").length, 1_000);
  } finally { relay.stop(); for (const client of wss.clients) client.terminate(); await new Promise<void>((resolve) => wss.close(() => resolve())); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
