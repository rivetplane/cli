import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionDiscovery, parseDescriptor } from "./discovery.js";

test("parses WebSocket and socket discovery records", () => {
  assert.equal(parseDescriptor({ session_id: "s1", harness_type: "codex", cwd: "/tmp", endpoint: "ws://127.0.0.1:9999/acp" }).transport.kind, "websocket");
  assert.deepEqual(parseDescriptor({ id: "s2", harness: "claude", cwd: "/tmp", socket_path: "/tmp/acp.sock" }).transport, { kind: "unix", path: "/tmp/acp.sock" });
});

test("scans valid records and reports invalid records without failing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-cp-discovery-"));
  await writeFile(join(directory, "good.json"), JSON.stringify({ session_id: "s1", harness_type: "codex", cwd: directory, endpoint: "tcp://127.0.0.1:4000" }));
  await writeFile(join(directory, "bad.json"), "{");
  const discovery = new SessionDiscovery({ directory });
  let warnings = 0; discovery.on("warning", () => warnings++);
  const sessions = await discovery.scan();
  assert.equal(sessions.length, 1); assert.equal(sessions[0]?.session_id, "s1"); assert.equal(warnings, 1);
});
