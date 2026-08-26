import assert from "node:assert/strict";
import { access, chmod, mkdtemp, symlink } from "node:fs/promises";
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
