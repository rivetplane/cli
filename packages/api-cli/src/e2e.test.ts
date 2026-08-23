import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test, { before, after } from "node:test";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
const requests: Array<{ method: string; url: string; body: unknown; authorization?: string }> = [];

async function body(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return text ? JSON.parse(text) : undefined;
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

before(async () => {
  server = createServer(async (request, response) => {
    const requestBody = await body(request);
    requests.push({ method: request.method ?? "", url: request.url ?? "", body: requestBody, ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}) });
    if (request.url === "/v1/machines") return json(response, [{ id: "m1", name: "Laptop", status: "online" }]);
    if (request.url?.startsWith("/v1/sessions?") && request.method === "GET") return json(response, [{ id: "m1/codex/s1", status: "running" }]);
    if (request.url === "/v1/sessions/m1%2Fcodex%2Fs1" && request.method === "GET") return json(response, { id: "m1/codex/s1", status: "running" });
    if (request.url?.startsWith("/v1/sessions/m1%2Fcodex%2Fs1/transcript?") && request.method === "GET") return json(response, { events: [{ id: "e0", seq: 0 }], next_cursor: null });
    if (request.url === "/v1/sessions/m1%2Fcodex%2Fs1/messages" && request.method === "POST") return json(response, { command_id: "message-1", accepted: true }, 202);
    if (request.url === "/v1/sessions/m1%2Fcodex%2Fs1/pending" && request.method === "GET") return json(response, { pending: { id: "p1", type: "approval", session_id: "m1/codex/s1", tool_name: "shell", tool_input_summary: "test", requested_at: "2026-01-01T00:00:00Z" } });
    if (request.url === "/v1/sessions/m1%2Fcodex%2Fs1/pending/respond") return json(response, { command_id: "c1", accepted: true }, 202);
    if (request.url === "/v1/sessions/m1%2Fcodex%2Fs1/interrupt") return json(response, { command_id: "interrupt-1", accepted: true }, 202);
    if (request.url === "/v1/sessions/m1%2Fcodex%2Fs1/transcript/stream") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"id":"e1","session_id":"m1/codex/s1","seq":1,"ts":"2026-01-01T00:00:00Z","type":"agent_message","payload":{"text":"done"}}\n\n');
      return;
    }
    return json(response, { error: "not found" }, 404);
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not start");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => { server.close(); await once(server, "close"); });

async function cli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./cli.js", import.meta.url)), ...args], {
    env: { ...process.env, RIVETPLANE_SERVER: baseUrl, RIVETPLANE_TOKEN: "test-token" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const [code] = await once(child, "close") as [number | null];
  return { code, stdout, stderr };
}

test("built CLI lists machines through the real SDK", async () => {
  const result = await cli(["--json", "machines", "list"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [{ id: "m1", name: "Laptop", status: "online" }]);
  assert.equal(requests.at(-1)?.authorization, "Bearer test-token");
});

test("built CLI covers session, transcript, message, pending, and interrupt REST operations", async () => {
  const list = await cli(["--json", "sessions", "list", "--status", "running"]);
  assert.equal(list.code, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout)[0].id, "m1/codex/s1");
  assert.match(requests.at(-1)?.url ?? "", /status=running/);

  const detail = await cli(["--json", "sessions", "get", "m1/codex/s1"]);
  assert.equal(detail.code, 0, detail.stderr);
  assert.equal(JSON.parse(detail.stdout).status, "running");

  const transcript = await cli(["--json", "transcript", "get", "m1/codex/s1", "--limit", "10"]);
  assert.equal(transcript.code, 0, transcript.stderr);
  assert.equal(JSON.parse(transcript.stdout).events[0].id, "e0");

  const message = await cli(["--json", "message", "send", "m1/codex/s1", "--text", "Continue"]);
  assert.equal(message.code, 0, message.stderr);
  assert.deepEqual(requests.at(-1)?.body, { text: "Continue" });

  const pending = await cli(["--json", "pending", "get", "m1/codex/s1"]);
  assert.equal(pending.code, 0, pending.stderr);
  assert.equal(JSON.parse(pending.stdout).id, "p1");

  const interrupt = await cli(["--json", "interrupt", "m1/codex/s1", "--yes"]);
  assert.equal(interrupt.code, 0, interrupt.stderr);
  assert.equal(JSON.parse(interrupt.stdout).accepted, true);
});

test("built CLI protects and sends a pending response through the real SDK", async () => {
  const result = await cli(["--json", "pending", "respond", "m1/codex/s1", "--pending-id", "p1", "--response", "approve", "--scope", "once"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { command_id: "c1", accepted: true });
  assert.deepEqual(requests.at(-1)?.body, { pending_id: "p1", response: "approve", scope: "once" });
});

test("built CLI tails SSE as NDJSON through the real SDK", async () => {
  const result = await cli(["--json", "transcript", "tail", "m1/codex/s1"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).payload.text, "done");
});
