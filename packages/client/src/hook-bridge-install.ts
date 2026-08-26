import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { HOOK_DISCOVERY_VERSION, HOOK_OWNER } from "./hook-discovery.js";

export const HOOK_BRIDGE_VERSION = 1 as const;
const BRIDGE_MARKER = `${HOOK_OWNER}:bridge-v${HOOK_BRIDGE_VERSION}`;

export interface HookBridgeInstallation { node: string; bridge: string; command(harness: string, event: string): string }

export function defaultHookBridgePath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const root = env.XDG_CONFIG_HOME || join(home, ".config");
  return join(root, "harness-cp", "hooks", `v${HOOK_BRIDGE_VERSION}`, "bridge.cjs");
}

export function hookBridgeInstallation(options: { env?: NodeJS.ProcessEnv; home?: string; node?: string; platform?: NodeJS.Platform } = {}): HookBridgeInstallation {
  const env = options.env ?? process.env;
  const bridge = defaultHookBridgePath(env, options.home ?? homedir());
  const node = options.node ?? process.execPath;
  const platform = options.platform ?? process.platform;
  return { node, bridge, command: (harness, event) => [node, bridge, "--owner", HOOK_OWNER, "--harness", harness, "--event", event].map((value) => shellQuote(value, platform)).join(" ") };
}

export async function installHookBridge(options: { env?: NodeJS.ProcessEnv; home?: string; node?: string; platform?: NodeJS.Platform } = {}): Promise<HookBridgeInstallation> {
  const installation = hookBridgeInstallation(options);
  const parent = dirname(installation.bridge);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error("Hook bridge directory must be a regular directory");
  assertCurrentUser(parentInfo, "Hook bridge directory");
  if (process.platform !== "win32") await chmod(parent, 0o700);
  let prior: string | undefined;
  try {
    const info = await lstat(installation.bridge);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Refused to replace a non-regular hook bridge");
    assertCurrentUser(info, "Hook bridge");
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("Hook bridge permissions are not private");
    prior = await readFile(installation.bridge, "utf8");
    if (!prior.includes(BRIDGE_MARKER)) throw new Error("Refused to overwrite an unmarked hook bridge");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const source = durableHookBridgeSource();
  if (prior !== source) {
    const temporary = `${installation.bridge}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, source, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    await rename(temporary, installation.bridge);
  }
  if (process.platform !== "win32") await chmod(installation.bridge, 0o600);
  return installation;
}

export async function uninstallHookBridge(options: { env?: NodeJS.ProcessEnv; home?: string } = {}): Promise<void> {
  const path = defaultHookBridgePath(options.env ?? process.env, options.home ?? homedir());
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Refused to remove a non-regular hook bridge");
    assertCurrentUser(info, "Hook bridge");
    const source = await readFile(path, "utf8");
    if (!source.includes(BRIDGE_MARKER)) throw new Error("Refused to remove an unmarked hook bridge");
    await rm(path);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function shellQuote(value: string, platform: NodeJS.Platform): string {
  if (/[\0\r\n]/.test(value)) throw new Error("Hook command path contains an invalid character");
  if (platform === "win32") return `"${value.replace(/%/g, "%%").replace(/"/g, '""')}"`;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function assertCurrentUser(info: { uid: number }, label: string): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && info.uid !== uid) throw new Error(`${label} is not owned by the current user`);
}

export function durableHookBridgeSource(): string {
  return `// ${BRIDGE_MARKER}\n"use strict";\nconst fs = require("node:fs/promises");\nconst os = require("node:os");\nconst path = require("node:path");\nconst crypto = require("node:crypto");\nconst OWNER = ${JSON.stringify(HOOK_OWNER)};\nconst VERSION = ${HOOK_DISCOVERY_VERSION};\nconst MAX_STDIN = 1000000;\nfunction flag(name) { const offset = process.argv.indexOf(name); return offset >= 0 ? process.argv[offset + 1] : undefined; }\nfunction object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }\nfunction first(input, names) { for (const name of names) if (typeof input[name] === "string" && input[name]) return input[name]; }\nfunction endpoint(value) { const url = new URL(value); if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "::1"].includes(url.hostname) || url.pathname !== "/v1/hooks/events" || url.username || url.password || url.search || url.hash) throw new Error("invalid endpoint"); return url.toString(); }\nasync function input() { let raw = ""; for await (const chunk of process.stdin) { raw += String(chunk); if (raw.length > MAX_STDIN) throw new Error("input too large"); } return object(raw ? JSON.parse(raw) : {}); }\nasync function discovery() { const root = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"); const file = process.env.RIVETPLANE_HOOK_DISCOVERY || path.join(root, "harness-cp", "hook-endpoint.json"); const info = await fs.lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe discovery"); if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("wrong owner"); if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("broad permissions"); const value = JSON.parse(await fs.readFile(file, "utf8")); if (value.version !== VERSION || value.owner !== OWNER || typeof value.token !== "string" || value.token.length < 32 || !Number.isSafeInteger(value.pid) || typeof value.started_at !== "string") throw new Error("invalid discovery"); try { process.kill(value.pid, 0); } catch (error) { if (error.code !== "EPERM") throw new Error("stale discovery"); } return { endpoint: endpoint(value.endpoint), token: value.token }; }\nfunction envelope(harness, configuredEvent, payload) { const session = first(payload, ["session_id", "sessionId", "sessionID", "thread-id", "thread_id", "threadId"]); if (!session) throw new Error("no session"); const event = first(payload, ["hook_event_name", "event", "type"]) || configuredEvent; const request = first(payload, ["request_id", "requestId", "requestID", "permission_request_id", "tool_use_id", "toolUseId", "tool_call_id", "toolCallId"].concat(harness === "opencode" ? ["id"] : [])) || (harness === "claude-code" && event === "PermissionRequest" ? "rivetplane-" + crypto.randomUUID() : undefined); return { version: 1, harness, event, session_id: session, cwd: first(payload, ["cwd", "directory", "working_directory"]) || process.cwd(), transport: harness === "opencode" ? "opencode-plugin" : harness + "-hook-command", payload, ...(request ? { request_id: request } : {}) }; }\nfunction native(harness, event, payload, result) { if (!result || result.decision === "neutral") return {}; if (harness === "claude-code" && event === "PermissionRequest") return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: result.decision === "deny" ? { behavior: "deny", message: "Denied through Rivetplane" } : { behavior: "allow", updatedInput: { ...object(payload.tool_input), ...object(result.updated_input) } } } }; return result; }\nasync function main() { const owner = flag("--owner"); const harness = flag("--harness"); const event = flag("--event"); if (owner !== OWNER) throw new Error("Hook ownership marker is invalid"); if (!harness || !event) throw new Error("--harness and --event are required"); try { if (process.env.RIVETPLANE_HOOKS_DISABLED === "1") return {}; const payload = await input(); const record = await discovery(); const actionable = (harness === "claude-code" && event === "PermissionRequest") || (harness === "opencode" && (event === "permission.asked" || event === "question.asked")); const configuredTimeout = Number(process.env.RIVETPLANE_HOOK_TIMEOUT_MS); const timeout = Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : actionable ? 125000 : 3000; const response = await fetch(record.endpoint, { method: "POST", headers: { "content-type": "application/json", "x-rivetplane-hook-owner": OWNER, "x-rivetplane-hook-token": record.token }, body: JSON.stringify(envelope(harness, event, payload)), signal: AbortSignal.timeout(timeout) }); if (!response.ok) return {}; return native(harness, event, payload, await response.json()); } catch { return {}; } }\nmain().then((value) => process.stdout.write(JSON.stringify(value) + "\\n")).catch((error) => { process.stderr.write("rivetplane hook bridge: " + error.message + "\\n"); process.exitCode = 1; });\n`;
}
