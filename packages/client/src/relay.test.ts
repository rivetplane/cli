import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { WebSocketServer } from "ws";
import type { HarnessCapabilities } from "@rivetplane/shared/protocol";
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
  const relay = new OutboundRelay({ server_url: `http://127.0.0.1:${port}`, machine_id: "m1", machine_name: "test", device_id: "00000000-0000-4000-8000-000000000001", owner_account_id: "a1", token: "secret" }, registry, () => ({ sendMessage: async (text) => { sentText = text; }, respondToPending: () => {}, interrupt: () => {} }), { replay_delay_ms: 0, replay_interval_ms: 0 });
  try {
    relay.start(); await until(() => received.some((message) => message.type === "command.result") && received.some((message) => message.type === "transcript.append"));
    assert.equal(authorization, "Bearer secret"); assert.equal(received[0]?.type, "machine.hello"); assert.equal(sentText, "go");
    assert.equal(received.some((message) => message.type === "session.upsert"), true);
    assert.equal((received.find((message) => message.type === "session.upsert")?.session as { id: string }).id, "m1/test/s1");
    const replayed = received.find((message) => message.type === "transcript.append")?.event as { session_id: string; payload: { text: string } };
    assert.equal(replayed.session_id, "m1/test/s1"); assert.equal(replayed.payload.text, "existing transcript");
  } finally { relay.stop(); for (const client of wss.clients) client.terminate(); await new Promise<void>((resolve) => wss.close(() => resolve())); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("reports relay frame rejections from the server", async () => {
  const server = createServer(); const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as { type?: string };
    if (message.type === "machine.hello") socket.send(JSON.stringify({ type: "relay.error", error: "Session payload is invalid" }));
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as AddressInfo).port;
  const relay = new OutboundRelay({ server_url: `http://127.0.0.1:${port}`, machine_id: "m1", machine_name: "test", device_id: "00000000-0000-4000-8000-000000000001", owner_account_id: "a1", token: "secret" }, new SessionRegistry(), () => undefined);
  let warning = ""; relay.on("warning", (error) => { warning = error instanceof Error ? error.message : String(error); });
  try { relay.start(); await until(() => warning.length > 0); assert.match(warning, /Session payload is invalid/); }
  finally { relay.stop(); for (const client of wss.clients) client.terminate(); await new Promise<void>((resolve) => wss.close(() => resolve())); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("sends recent snapshots and capabilities before bounded round-robin replay", async () => {
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
    replay_delay_ms: 0, replay_interval_ms: 0,
  });
  try {
    relay.start(); await until(() => received.filter((message) => message.type === "transcript.append").length === 40);
    const firstTranscript = received.findIndex((message) => message.type === "transcript.append");
    assert.ok(received.slice(0, firstTranscript).filter((message) => message.type === "session.upsert").length === 2);
    assert.ok(received.slice(0, firstTranscript).some((message) => message.type === "harness.capabilities"));
    const firstFour = received.filter((message) => message.type === "transcript.append").slice(0, 4).map((message) => ((message.event as { payload: { text: string } }).payload.text));
    assert.deepEqual(firstFour, ["s2-490", "s1-490", "s2-491", "s1-491"]);
    assert.equal(received.filter((message) => message.type === "transcript.append").length, 40);
  } finally { relay.stop(); for (const client of wss.clients) client.terminate(); await new Promise<void>((resolve) => wss.close(() => resolve())); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("keeps live pending state ahead of default transcript repair", async () => {
  const server = createServer(); const wss = new WebSocketServer({ server }); const received: Array<Record<string, unknown>> = [];
  wss.on("connection", (socket) => socket.on("message", (raw) => received.push(JSON.parse(raw.toString()) as Record<string, unknown>)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as AddressInfo).port;
  const registry = new SessionRegistry(); const now = new Date().toISOString();
  registry.upsert({ id: "s1", machine_id: "m1", harness_type: "opencode", cwd: "/tmp", status: "running", created_at: now, last_activity_at: now, pending: null });
  registry.append("s1", "agent_message", { text: "repair-1" }); registry.append("s1", "agent_message", { text: "repair-2" });
  const relay = new OutboundRelay({ server_url: `http://127.0.0.1:${port}`, machine_id: "m1", machine_name: "test", device_id: "00000000-0000-4000-8000-000000000001", owner_account_id: "a1", token: "secret" }, registry, () => undefined, { replay_delay_ms: 0, replay_interval_ms: 250 });
  try {
    relay.start(); await until(() => received.filter((message) => message.type === "transcript.append").length === 1);
    registry.setPending("s1", { type: "question", id: "q-live", session_id: "s1", prompt: "Continue?", requested_at: new Date().toISOString() });
    await until(() => received.some((message) => message.type === "session.upsert" && (message.session as { pending?: { id?: string } }).pending?.id === "q-live"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(received.filter((message) => message.type === "transcript.append").length, 1);
  } finally { relay.stop(); for (const client of wss.clients) client.terminate(); await new Promise<void>((resolve) => wss.close(() => resolve())); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("defaults background relay traffic below the durable store write rate", async () => {
  const server = createServer(); const wss = new WebSocketServer({ server }); const received: Array<Record<string, unknown>> = [];
  wss.on("connection", (socket) => socket.on("message", (raw) => received.push(JSON.parse(raw.toString()) as Record<string, unknown>)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as AddressInfo).port;
  const registry = new SessionRegistry(); const now = new Date().toISOString();
  const relay = new OutboundRelay({ server_url: `http://127.0.0.1:${port}`, machine_id: "m1", machine_name: "test", device_id: "00000000-0000-4000-8000-000000000001", owner_account_id: "a1", token: "secret" }, registry, () => undefined, { replay_delay_ms: 60_000 });
  try {
    relay.start(); await until(() => received.some((message) => message.type === "machine.hello"));
    registry.upsert({ id: "background", machine_id: "m1", harness_type: "codex", cwd: "/tmp", status: "completed", created_at: now, last_activity_at: now, pending: null });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(received.some((message) => message.type === "session.upsert"), false);
    registry.upsert({ id: "urgent", machine_id: "m1", harness_type: "claude-code", cwd: "/tmp", status: "waiting_input", created_at: now, last_activity_at: now, pending: { type: "question", id: "q-now", session_id: "urgent", prompt: "Now?", requested_at: now } });
    await until(() => received.some((message) => message.type === "session.upsert" && (message.session as { pending?: { id?: string } }).pending?.id === "q-now"));
  } finally { relay.stop(); for (const client of wss.clients) client.terminate(); await new Promise<void>((resolve) => wss.close(() => resolve())); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("keeps a live pending interaction ahead of a large connected discovery refresh", async () => {
  const server = createServer(); const wss = new WebSocketServer({ server }); const received: Array<Record<string, unknown>> = [];
  wss.on("connection", (socket) => socket.on("message", (raw) => received.push(JSON.parse(raw.toString()) as Record<string, unknown>)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as AddressInfo).port;
  const registry = new SessionRegistry(); const now = new Date().toISOString();
  const relay = new OutboundRelay({ server_url: `http://127.0.0.1:${port}`, machine_id: "m1", machine_name: "test", device_id: "00000000-0000-4000-8000-000000000001", owner_account_id: "a1", token: "secret" }, registry, () => undefined, { replay_delay_ms: 60_000, session_drain_interval_ms: 100 });
  try {
    relay.start(); await until(() => received.some((message) => message.type === "machine.hello"));
    for (let index = 0; index < 500; index++) registry.upsert({ id: `background-${index}`, machine_id: "m1", harness_type: "opencode", cwd: "/tmp", status: "completed", created_at: now, last_activity_at: now, pending: null });
    registry.upsert({ id: "urgent", machine_id: "m1", harness_type: "opencode", cwd: "/tmp", status: "waiting_input", created_at: now, last_activity_at: now, pending: { type: "question", id: "q-urgent", session_id: "urgent", prompt: "Answer now", requested_at: now } });
    await until(() => received.some((message) => message.type === "session.upsert" && (message.session as { pending?: { id?: string } }).pending?.id === "q-urgent"));
    assert.ok(received.filter((message) => message.type === "session.upsert").length < 10);
  } finally { relay.stop(); for (const client of wss.clients) client.terminate(); await new Promise<void>((resolve) => wss.close(() => resolve())); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("keeps a live pending interaction ahead of a connected transcript flood", async () => {
  const server = createServer(); const wss = new WebSocketServer({ server }); const received: Array<Record<string, unknown>> = [];
  wss.on("connection", (socket) => socket.on("message", (raw) => received.push(JSON.parse(raw.toString()) as Record<string, unknown>)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as AddressInfo).port;
  const registry = new SessionRegistry(); const now = new Date().toISOString();
  registry.upsert({ id: "busy", machine_id: "m1", harness_type: "codex", cwd: "/tmp", status: "running", created_at: now, last_activity_at: now, pending: null });
  registry.upsert({ id: "urgent", machine_id: "m1", harness_type: "claude-code", cwd: "/tmp", status: "running", created_at: now, last_activity_at: now, pending: null });
  const relay = new OutboundRelay({ server_url: `http://127.0.0.1:${port}`, machine_id: "m1", machine_name: "test", device_id: "00000000-0000-4000-8000-000000000001", owner_account_id: "a1", token: "secret" }, registry, () => undefined, { replay_delay_ms: 60_000, session_drain_interval_ms: 100 });
  try {
    relay.start(); await until(() => received.some((message) => message.type === "machine.hello"));
    for (let index = 0; index < 500; index++) registry.append("busy", "tool_result", { tool_call_id: `call-${index}`, output_summary: `result-${index}`, is_error: false });
    registry.setPending("urgent", { type: "question", id: "q-urgent", session_id: "urgent", prompt: "Answer now", requested_at: now });
    await until(() => received.some((message) => message.type === "session.upsert" && (message.session as { pending?: { id?: string } }).pending?.id === "q-urgent"));
    const pendingIndex = received.findIndex((message) => message.type === "session.upsert" && (message.session as { pending?: { id?: string } }).pending?.id === "q-urgent");
    assert.ok(pendingIndex < 10); assert.ok(received.slice(0, pendingIndex).filter((message) => message.type === "transcript.append").length < 5);
  } finally { relay.stop(); for (const client of wss.clients) client.terminate(); await new Promise<void>((resolve) => wss.close(() => resolve())); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("caps reconnect snapshots and sends pending sessions first", async () => {
  const server = createServer(); const wss = new WebSocketServer({ server }); const received: Array<Record<string, unknown>> = [];
  wss.on("connection", (socket) => socket.on("message", (raw) => received.push(JSON.parse(raw.toString()) as Record<string, unknown>)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as AddressInfo).port;
  const registry = new SessionRegistry(); const base = Date.parse("2026-01-01T00:00:00Z");
  for (let index = 0; index < 300; index++) {
    const at = new Date(base + index).toISOString(); const pending = index === 0 ? { type: "question" as const, id: "q-old", session_id: "s0", prompt: "Old but pending", requested_at: at } : null;
    registry.upsert({ id: `s${index}`, machine_id: "m1", harness_type: "test", cwd: "/tmp", status: pending ? "waiting_input" : "completed", created_at: at, last_activity_at: at, pending });
  }
  const relay = new OutboundRelay({ server_url: `http://127.0.0.1:${port}`, machine_id: "m1", machine_name: "test", device_id: "00000000-0000-4000-8000-000000000001", owner_account_id: "a1", token: "secret" }, registry, () => undefined, { replay_delay_ms: 0, replay_interval_ms: 0 });
  try {
    relay.start(); await until(() => received.filter((message) => message.type === "session.upsert").length === 16);
    const snapshots = received.filter((message) => message.type === "session.upsert");
    assert.equal((snapshots[0]?.session as { id: string }).id, "m1/test/s0");
    assert.equal(snapshots.some((message) => (message.session as { id: string }).id === "m1/test/s299"), true);
  } finally { relay.stop(); for (const client of wss.clients) client.terminate(); await new Promise<void>((resolve) => wss.close(() => resolve())); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("coalesces the disconnected discovery queue instead of flooding the relay", async () => {
  const server = createServer(); const wss = new WebSocketServer({ server }); const received: Array<Record<string, unknown>> = [];
  wss.on("connection", (socket) => socket.on("message", (raw) => received.push(JSON.parse(raw.toString()) as Record<string, unknown>)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as AddressInfo).port;
  const registry = new SessionRegistry();
  const relay = new OutboundRelay({ server_url: `http://127.0.0.1:${port}`, machine_id: "m1", machine_name: "test", device_id: "00000000-0000-4000-8000-000000000001", owner_account_id: "a1", token: "secret" }, registry, () => undefined, { replay_delay_ms: 60_000, session_drain_interval_ms: 1 });
  const now = new Date().toISOString();
  for (let index = 0; index < 300; index++) registry.upsert({ id: `startup-${index}`, machine_id: "m1", harness_type: "opencode", cwd: "/tmp", status: "completed", created_at: now, last_activity_at: new Date(Date.parse(now) + index).toISOString(), pending: null });
  registry.setPending("startup-0", { type: "question", id: "q-startup", session_id: "startup-0", prompt: "Choose", requested_at: now });
  try {
    relay.start(); await until(() => received.some((message) => message.type === "session.upsert" && (message.session as { pending?: { id?: string } }).pending?.id === "q-startup"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(received.filter((message) => message.type === "session.upsert").length <= 2);
    assert.equal(received.filter((message) => message.type === "transcript.append").length, 0);
  } finally { relay.stop(); for (const client of wss.clients) client.terminate(); await new Promise<void>((resolve) => wss.close(() => resolve())); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("re-announces pending state on heartbeat after a transient lost frame", async () => {
  const server = createServer(); const wss = new WebSocketServer({ server }); const received: Array<Record<string, unknown>> = [];
  wss.on("connection", (socket) => socket.on("message", (raw) => received.push(JSON.parse(raw.toString()) as Record<string, unknown>)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as AddressInfo).port;
  const registry = new SessionRegistry(); const now = new Date().toISOString();
  registry.upsert({ id: "live", machine_id: "m1", harness_type: "opencode", cwd: "/tmp", status: "running", created_at: now, last_activity_at: now, pending: null });
  const relay = new OutboundRelay({ server_url: `http://127.0.0.1:${port}`, machine_id: "m1", machine_name: "test", device_id: "00000000-0000-4000-8000-000000000001", owner_account_id: "a1", token: "secret" }, registry, () => undefined, { replay_delay_ms: 60_000, heartbeat_interval_ms: 25 });
  try {
    relay.start(); await until(() => received.some((message) => message.type === "machine.hello"));
    registry.setPending("live", { type: "question", id: "q-retry", session_id: "live", prompt: "Retry me", requested_at: now });
    await until(() => received.filter((message) => message.type === "session.upsert" && (message.session as { pending?: { id?: string } }).pending?.id === "q-retry").length >= 2);
  } finally { relay.stop(); for (const client of wss.clients) client.terminate(); await new Promise<void>((resolve) => wss.close(() => resolve())); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("re-announces harness capabilities when a live hook becomes actionable", async () => {
  const server = createServer(); const wss = new WebSocketServer({ server }); const received: Array<Record<string, unknown>> = [];
  wss.on("connection", (socket) => socket.on("message", (raw) => received.push(JSON.parse(raw.toString()) as Record<string, unknown>)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as AddressInfo).port;
  const registry = new SessionRegistry(); let actionable = false;
  const capabilities = (): HarnessCapabilities[] => {
    const unsupported = { supported: false, mode: "unsupported" as const, reason: "read-only" };
    const readOnly = { supported: true, mode: "read_only" as const };
    return [{ machine_id: "m1", harness_type: "opencode", can_create_session: false, directories: ["/tmp"], models: [], reported_at: new Date().toISOString(), transport: actionable ? "opencode-plugin" : "opencode-cli-export", session_capabilities: { discovery: readOnly, transcript: readOnly, live_attachment: readOnly, messaging: unsupported, interrupt: unsupported, question_response: actionable ? { supported: true, mode: "read_write" } : unsupported, approval_response: actionable ? { supported: true, mode: "read_write" } : unsupported } }];
  };
  const relay = new OutboundRelay({ server_url: `http://127.0.0.1:${port}`, machine_id: "m1", machine_name: "test", device_id: "00000000-0000-4000-8000-000000000001", owner_account_id: "a1", token: "secret" }, registry, () => undefined, { capabilities, replay_delay_ms: 60_000, heartbeat_interval_ms: 25 });
  try {
    relay.start(); await until(() => received.filter((message) => message.type === "harness.capabilities").length === 1);
    actionable = true;
    await until(() => received.filter((message) => message.type === "harness.capabilities").length === 2);
    const reports = received.filter((message) => message.type === "harness.capabilities").map((message) => message.capabilities as { transport: string });
    assert.deepEqual(reports.map((report) => report.transport), ["opencode-cli-export", "opencode-plugin"]);
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(received.filter((message) => message.type === "harness.capabilities").length, 2);
  } finally { relay.stop(); for (const client of wss.clients) client.terminate(); await new Promise<void>((resolve) => wss.close(() => resolve())); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
