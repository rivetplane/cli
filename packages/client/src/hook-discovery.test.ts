import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emitHook } from "./hook-bridge.js";
import { createHookToken, HOOK_OWNER, readHookDiscovery, validateHookEndpoint, writeHookDiscovery } from "./hook-discovery.js";

test("rejects stale discovery processes and removes only their owned record", async () => {
  const root = await mkdtemp(join(tmpdir(), "rivetplane-hook-discovery-")); const path = join(root, "config", "hook-endpoint.json"); const token = createHookToken();
  await writeHookDiscovery(path, { version: 1, owner: HOOK_OWNER, endpoint: "http://127.0.0.1:54321/v1/hooks/events", token, pid: 2_147_483_647, started_at: new Date().toISOString() });
  await assert.rejects(readHookDiscovery(path), /not running/); await assert.rejects(access(path), /ENOENT/);
});

test("rejects broad permissions, symbolic links, non-loopback endpoints, and the wrong owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "rivetplane-hook-discovery-")); const path = join(root, "config", "hook-endpoint.json"); const token = createHookToken();
  await writeHookDiscovery(path, { version: 1, owner: HOOK_OWNER, endpoint: "http://127.0.0.1:54321/v1/hooks/events", token, pid: process.pid, started_at: new Date().toISOString() });
  if (process.platform !== "win32") { await chmod(path, 0o644); await assert.rejects(readHookDiscovery(path), /permissions/); await chmod(path, 0o600); }
  const link = join(root, "linked.json"); await symlink(path, link); await assert.rejects(readHookDiscovery(link), /regular file/);
  assert.throws(() => validateHookEndpoint("http://example.com/v1/hooks/events"), /loopback/);
  await assert.rejects(emitHook("claude-code", "Stop", { owner: "wrong", discovery_path: path, payload: {} }), /ownership/);
});

test("refuses an authenticated active owner but replaces a reused unreachable PID", async () => {
  const root = await mkdtemp(join(tmpdir(), "rivetplane-hook-discovery-")); const path = join(root, "config", "hook-endpoint.json"); const token = createHookToken();
  const server = createServer((request, response) => {
    if (request.url === "/v1/hooks/health" && request.headers["x-rivetplane-hook-owner"] === HOOK_OWNER && request.headers["x-rivetplane-hook-token"] === token) {
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ owner: HOOK_OWNER, version: 1, pid: process.pid })); return;
    }
    response.writeHead(401); response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as AddressInfo).port;
  await writeHookDiscovery(path, { version: 1, owner: HOOK_OWNER, endpoint: `http://127.0.0.1:${port}/v1/hooks/events`, token, pid: process.pid, started_at: new Date().toISOString() });
  await assert.rejects(writeHookDiscovery(path, { version: 1, owner: HOOK_OWNER, endpoint: "http://127.0.0.1:1/v1/hooks/events", token: createHookToken(), pid: process.pid, started_at: new Date().toISOString() }), /active/);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const replacement = createHookToken(); await writeHookDiscovery(path, { version: 1, owner: HOOK_OWNER, endpoint: "http://127.0.0.1:1/v1/hooks/events", token: replacement, pid: process.pid, started_at: new Date().toISOString() });
  assert.equal((JSON.parse(await readFile(path, "utf8")) as { token: string }).token, replacement);
});
