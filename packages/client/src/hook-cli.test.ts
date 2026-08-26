import assert from "node:assert/strict";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { createHookToken, HOOK_OWNER, writeHookDiscovery } from "./hook-discovery.js";

const cli = join(process.cwd(), "dist", "cli.js");
const payload = { session_id: "session-exact", permission_request_id: "permission-exact", cwd: "/repo", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "pwd" } };

async function runHook(discovery: string, extra: { owner?: string; timeout?: number } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "hook", "emit", "--owner", extra.owner ?? HOOK_OWNER, "--harness", "claude-code", "--event", "PermissionRequest"], {
      env: { ...process.env, PATH: "", RIVETPLANE_HOOK_DISCOVERY: discovery, ...(extra.timeout ? { RIVETPLANE_HOOK_TIMEOUT_MS: String(extra.timeout) } : {}) }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject); child.once("close", (code) => resolve({ code, stdout, stderr })); child.stdin.end(JSON.stringify(payload));
  });
}

async function listen(handler: RequestListener): Promise<{ server: Server; endpoint: string }> {
  const server = createServer(handler); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/hooks/events` };
}
async function close(server: Server): Promise<void> { await new Promise<void>((resolve) => server.close(() => resolve())); }

test("CLI hook emit fails open for offline and malformed discovery paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "rivetplane-hook-cli-")); const discovery = join(root, "config", "hook-endpoint.json");
  let result = await runHook(discovery); assert.equal(result.code, 0); assert.equal(result.stdout.trim(), "{}");

  await mkdir(join(root, "config")); await writeFile(discovery, "{ malformed\n", { mode: 0o600 });
  result = await runHook(discovery); assert.equal(result.code, 0); assert.equal(result.stdout.trim(), "{}"); await rm(discovery);

  await writeHookDiscovery(discovery, { version: 1, owner: HOOK_OWNER, endpoint: "http://127.0.0.1:1/v1/hooks/events", token: createHookToken(), pid: 2_147_483_647, started_at: new Date().toISOString() });
  result = await runHook(discovery); assert.equal(result.code, 0); assert.equal(result.stdout.trim(), "{}");

  await writeHookDiscovery(discovery, { version: 1, owner: HOOK_OWNER, endpoint: "http://127.0.0.1:1/v1/hooks/events", token: createHookToken(), pid: process.pid, started_at: new Date().toISOString() });
  result = await runHook(discovery, { timeout: 50 }); assert.equal(result.code, 0); assert.equal(result.stdout.trim(), "{}");

  const timeoutServer = await listen((_request, _response) => {}); await writeHookDiscovery(discovery, { version: 1, owner: HOOK_OWNER, endpoint: timeoutServer.endpoint, token: createHookToken(), pid: process.pid, started_at: new Date().toISOString() });
  result = await runHook(discovery, { timeout: 50 }); assert.equal(result.code, 0); assert.equal(result.stdout.trim(), "{}"); await close(timeoutServer.server);

  const malformedServer = await listen((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end("not-json"); });
  await writeHookDiscovery(discovery, { version: 1, owner: HOOK_OWNER, endpoint: malformedServer.endpoint, token: createHookToken(), pid: process.pid, started_at: new Date().toISOString() });
  result = await runHook(discovery); assert.equal(result.code, 0); assert.equal(result.stdout.trim(), "{}"); await close(malformedServer.server);
});

test("CLI hook emit preserves an exact native ID response and rejects developer misuse", async () => {
  const root = await mkdtemp(join(tmpdir(), "rivetplane-hook-cli-")); const discovery = join(root, "config", "hook-endpoint.json"); const token = createHookToken(); let requestId: unknown;
  const active = await listen(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk; requestId = (JSON.parse(raw) as { request_id?: unknown }).request_id;
    assert.equal(request.headers["x-rivetplane-hook-token"], token); response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ decision: "allow" }));
  });
  await writeHookDiscovery(discovery, { version: 1, owner: HOOK_OWNER, endpoint: active.endpoint, token, pid: process.pid, started_at: new Date().toISOString() });
  const result = await runHook(discovery); assert.equal(result.code, 0); assert.equal(requestId, "permission-exact");
  assert.deepEqual(JSON.parse(result.stdout), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { command: "pwd" } } } });
  const misuse = await runHook(discovery, { owner: "wrong" }); assert.notEqual(misuse.code, 0); assert.match(misuse.stderr, /ownership/); await close(active.server);
});
