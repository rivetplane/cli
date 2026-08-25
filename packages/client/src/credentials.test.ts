import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { login, resolveServerUrl } from "./credentials.js";

test("uses Rivetplane by default and preserves self-hosted overrides", () => {
  assert.equal(resolveServerUrl(), "https://rivetplane.com");
  assert.equal(resolveServerUrl(undefined, "https://self-hosted.example"), "https://self-hosted.example");
  assert.equal(resolveServerUrl("https://explicit.example", "https://environment.example"), "https://explicit.example");
});

test("completes browser callback pairing and stores a scoped machine token", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ access_token: "machine-secret", machine_id: "m1", owner_account_id: "a1" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const path = join(await mkdtemp(join(tmpdir(), "harness-cp-login-")), "credentials"); let opened = "";
  try {
    const credentials = await login({ server_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, machine_name: "laptop", credentials_path: path, open_browser: async (value) => {
      opened = value; const authorize = new URL(value); const callback = new URL(authorize.searchParams.get("redirect_uri")!);
      callback.searchParams.set("code", "one-time-code"); callback.searchParams.set("state", authorize.searchParams.get("state")!); await fetch(callback);
    } });
    const firstDeviceId = new URL(opened).searchParams.get("device_id");
    assert.equal(new URL(opened).pathname, "/authorize"); assert.equal(new URL(opened).searchParams.get("code_challenge")?.length, 43); assert.match(firstDeviceId ?? "", /^[a-f0-9-]{36}$/i); assert.equal(credentials.device_id, firstDeviceId); assert.equal(credentials.machine_id, "m1");
    assert.equal((JSON.parse(await readFile(path, "utf8")) as { token: string }).token, "machine-secret");
    await login({ server_url: credentials.server_url, machine_name: "laptop", credentials_path: path, open_browser: async (value) => {
      const authorize = new URL(value); assert.equal(authorize.searchParams.get("device_id"), firstDeviceId); assert.equal(authorize.searchParams.get("previous_machine_id"), "m1");
      const callback = new URL(authorize.searchParams.get("redirect_uri")!); callback.searchParams.set("code", "second-code"); callback.searchParams.set("state", authorize.searchParams.get("state")!); await fetch(callback);
    } });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
