import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface Credentials {
  server_url: string;
  machine_id: string;
  machine_name: string;
  device_id: string;
  owner_account_id: string;
  token: string;
}

export function credentialsPath(): string { return join(homedir(), ".config", "harness-cp", "credentials"); }
export function deviceIdentityPath(credentials = credentialsPath()): string { return join(dirname(credentials), "device-id"); }

export async function readOrCreateDeviceIdentity(path = deviceIdentityPath()): Promise<string> {
  try {
    const value = (await readFile(path, "utf8")).trim();
    if (/^[a-f0-9-]{36}$/i.test(value)) return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const value = randomUUID();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${value}\n`, { mode: 0o600 });
  return value;
}

export async function readCredentials(path = credentialsPath()): Promise<Credentials | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as Credentials; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export async function writeCredentials(credentials: Credentials, path = credentialsPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export interface LoginOptions { server_url: string; machine_name?: string; open_browser?: (url: string) => Promise<void>; timeout_ms?: number; credentials_path?: string; device_identity_path?: string }

export function browserLaunch(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "explorer.exe", args: [url] };
  return { command: "xdg-open", args: [url] };
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const { command, args } = browserLaunch(process.platform, url);
  const child = spawn(command, args, { detached: true, stdio: "ignore" }); child.unref();
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `Pairing request failed (${response.status})`);
  return body;
}

export async function login(options: LoginOptions): Promise<Credentials> {
  const server = options.server_url.replace(/\/$/, "");
  const machine_name = options.machine_name ?? hostname();
  const credentialPath = options.credentials_path ?? credentialsPath();
  const existing = await readCredentials(credentialPath);
  const device_id = await readOrCreateDeviceIdentity(options.device_identity_path ?? deviceIdentityPath(credentialPath));
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let resolveCallback!: (value: { code: string; redirect_uri: string }) => void;
  let rejectCallback!: (error: Error) => void;
  const callback = new Promise<{ code: string; redirect_uri: string }>((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
  const callbackServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") { response.writeHead(404); response.end(); return; }
    if (url.searchParams.get("state") !== state || !url.searchParams.get("code")) {
      response.writeHead(400, { "content-type": "text/plain" }); response.end("Authorization failed. You can close this window."); rejectCallback(new Error("The authorization callback is not valid")); return;
    }
    const address = callbackServer.address() as AddressInfo;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
    response.end("<!doctype html><meta charset=utf-8><title>Connected</title><style>body{font:18px system-ui;padding:48px;background:#0b111b;color:#edf3ff}h1{color:#70e1b2}</style><h1>Client connected</h1><p>You can close this window and return to the terminal.</p>");
    resolveCallback({ code: url.searchParams.get("code")!, redirect_uri: `http://127.0.0.1:${address.port}/callback` });
  });
  await new Promise<void>((resolve, reject) => { callbackServer.once("error", reject); callbackServer.listen(0, "127.0.0.1", resolve); });
  const redirect_uri = `http://127.0.0.1:${(callbackServer.address() as AddressInfo).port}/callback`;
  const authorize = new URL(`${server}/authorize`); authorize.searchParams.set("redirect_uri", redirect_uri); authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge); authorize.searchParams.set("code_challenge_method", "S256"); authorize.searchParams.set("machine_name", machine_name);
  authorize.searchParams.set("device_id", device_id);
  if (existing?.server_url === server) authorize.searchParams.set("previous_machine_id", existing.machine_id);
  const timeout = setTimeout(() => rejectCallback(new Error("Browser authorization timed out")), options.timeout_ms ?? 10 * 60_000); timeout.unref();
  try {
    await (options.open_browser ?? defaultOpenBrowser)(authorize.toString());
    const result = await callback;
    const issued = await responseJson(await fetch(`${server}/v1/auth/token`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", code: result.code, redirect_uri: result.redirect_uri, code_verifier: verifier }) }));
    const credentials: Credentials = { server_url: server, machine_id: String(issued.machine_id ?? randomUUID()), machine_name, device_id,
      owner_account_id: String(issued.owner_account_id ?? "paired"), token: String(issued.access_token ?? "") };
    if (!credentials.token) throw new Error("The authorization server did not return a token");
    await writeCredentials(credentials, credentialPath); return credentials;
  } finally { clearTimeout(timeout); await new Promise<void>((resolve) => callbackServer.close(() => resolve())); }
}
