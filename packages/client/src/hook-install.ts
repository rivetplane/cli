import { access, chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { HOOK_OWNER } from "./hook-discovery.js";
import { hookBridgeInstallation, installHookBridge, uninstallHookBridge, type HookBridgeInstallation } from "./hook-bridge-install.js";

export { HOOK_OWNER } from "./hook-discovery.js";

export type HarnessOperation = "actionable" | "telemetry" | "lifecycle" | "unsupported";
export interface HarnessHookDefinition { harness: string; binary: string; config: string; events: string[]; operation: HarnessOperation; restore?: string; format: "nested-json" | "owned-extension" | "none"; env_home?: string; verified: boolean; official_source?: string; fixture?: string }

export const HARNESS_HOOKS: readonly HarnessHookDefinition[] = [
  { harness: "claude-code", binary: "claude", config: ".claude/settings.json", env_home: "CLAUDE_CONFIG_DIR", events: ["PermissionRequest", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"], operation: "actionable", restore: "claude --resume <id>", format: "nested-json", verified: true, official_source: "https://code.claude.com/docs/en/hooks", fixture: "fixtures/hooks/claude-code" },
  { harness: "codex", binary: "codex", config: ".codex/hooks.json", env_home: "CODEX_HOME", events: ["SessionStart", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop", "SessionEnd"], operation: "telemetry", restore: "codex resume <id>", format: "nested-json", verified: true, official_source: "https://github.com/openai/codex/tree/main/codex-rs/hooks/schema/generated", fixture: "fixtures/hooks/codex" },
  { harness: "grok", binary: "grok", config: ".grok/hooks", events: [], operation: "unsupported", format: "none", verified: false },
  { harness: "opencode", binary: "opencode", config: ".config/opencode/plugins/rivetplane.ts", env_home: "XDG_CONFIG_HOME", events: ["session.created", "session.updated", "session.status", "session.idle", "session.deleted", "session.error", "permission.asked", "permission.replied", "question.asked", "question.replied", "question.rejected"], operation: "actionable", restore: "opencode --session <id>", format: "owned-extension", verified: true, official_source: "https://opencode.ai/docs/plugins/", fixture: "fixtures/hooks/opencode" },
  { harness: "pi", binary: "pi", config: ".pi/agent/extensions", events: [], operation: "unsupported", format: "none", verified: false },
  { harness: "omp", binary: "omp", config: ".pi/agent/extensions", events: [], operation: "unsupported", format: "none", verified: false },
  { harness: "campfire", binary: "campfire", config: ".campfire/agent/extensions", events: [], operation: "unsupported", format: "none", verified: false },
  { harness: "amp", binary: "amp", config: ".config/amp/plugins", events: [], operation: "unsupported", format: "none", verified: false },
  { harness: "cursor", binary: "cursor-agent", config: ".cursor/hooks.json", events: [], operation: "unsupported", format: "none", verified: false },
  { harness: "gemini", binary: "gemini", config: ".gemini/settings.json", events: [], operation: "unsupported", format: "none", verified: false },
  { harness: "kiro", binary: "kiro-cli", config: ".kiro/agents", events: [], operation: "unsupported", format: "none", verified: false },
  { harness: "rovo-dev", binary: "acli", config: ".rovodev/config.yml", events: [], operation: "unsupported", format: "none", verified: false },
  { harness: "copilot", binary: "copilot", config: ".copilot/config.json", events: [], operation: "unsupported", format: "none", verified: false },
  { harness: "codebuddy", binary: "codebuddy", config: ".codebuddy/settings.json", events: [], operation: "unsupported", format: "none", verified: false },
  { harness: "factory", binary: "droid", config: ".factory/settings.json", events: [], operation: "unsupported", format: "none", verified: false },
  { harness: "qoder", binary: "qodercli", config: ".qoder/settings.json", events: [], operation: "unsupported", format: "none", verified: false },
  { harness: "kimi-code", binary: "kimi", config: ".kimi/config.toml", events: [], operation: "unsupported", format: "none", verified: false },
] as const;

export interface InstallResult { harness: string; status: "installed" | "updated" | "removed" | "absent" | "skipped"; path?: string; reason?: string }
interface InstallerOptions { home?: string; env?: NodeJS.ProcessEnv; path?: string; only?: string[]; executable?: (name: string) => Promise<boolean> }

export async function installHooks(options: InstallerOptions = {}): Promise<InstallResult[]> {
  return applyHooks("install", options);
}
export async function uninstallHooks(options: InstallerOptions = {}): Promise<InstallResult[]> {
  return applyHooks("uninstall", options);
}

/**
 * Refresh only hook integrations the user has already installed.
 *
 * npx and version managers place Node in versioned directories. Rewriting the
 * owned hook commands when the long-running client starts keeps their runtime
 * path aligned with the Node executable that is demonstrably working now,
 * without opting the user into any new harness integration.
 */
export async function refreshInstalledHooks(options: InstallerOptions = {}): Promise<InstallResult[]> {
  const env = options.env ?? process.env; const home = options.home ?? homedir(); const only: string[] = [];
  for (const definition of HARNESS_HOOKS.filter((item) => item.verified)) {
    try {
      if ((await readFile(configPath(definition, home, env), "utf8")).includes(HOOK_OWNER)) only.push(definition.harness);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return only.length ? applyHooks("install", { ...options, only }) : [];
}

export function claudeHookSettings(bridge: HookBridgeInstallation = hookBridgeInstallation()): Record<string, unknown> {
  const definition = HARNESS_HOOKS.find((item) => item.harness === "claude-code")!; const hooks: Record<string, unknown[]> = {};
  for (const event of definition.events) hooks[event] = [{ matcher: "*", hooks: [{ type: "command", command: bridge.command("claude-code", event), timeout: 125 }] }];
  return { hooks };
}

export function codexHookSettings(bridge: HookBridgeInstallation = hookBridgeInstallation()): Record<string, unknown> {
  const definition = HARNESS_HOOKS.find((item) => item.harness === "codex")!; const hooks: Record<string, unknown[]> = {};
  for (const event of definition.events) hooks[event] = [{ matcher: "*", hooks: [codexCommandHook(bridge.command("codex", event), event)] }];
  return { description: `Rivetplane standalone telemetry hooks (${HOOK_OWNER})`, hooks };
}

async function applyHooks(action: "install" | "uninstall", options: InstallerOptions): Promise<InstallResult[]> {
  const env = options.env ?? process.env; const home = options.home ?? homedir(); const results: InstallResult[] = []; let bridge: HookBridgeInstallation | undefined;
  for (const definition of HARNESS_HOOKS) {
    if (options.only && !options.only.includes(definition.harness)) continue;
    if (!definition.verified || definition.format === "none") { results.push({ harness: definition.harness, status: "skipped", reason: "Unsupported: no checked official configuration and event fixture" }); continue; }
    const present = action === "uninstall" || await (options.executable ?? ((name) => executableExists(name, options.path ?? env.PATH)))(definition.binary);
    if (!present) { results.push({ harness: definition.harness, status: "absent", reason: `${definition.binary} was not found` }); continue; }
    bridge ??= action === "install" ? await installHookBridge({ env, home }) : hookBridgeInstallation({ env, home });
    const path = configPath(definition, home, env);
    try {
      if (definition.harness === "codex") await inspectCodexConfig(home, env);
      const status = definition.format === "owned-extension" ? await ownedFile(action, path, extensionSource(definition, bridge)) : await jsonConfig(action, path, definition, bridge);
      const reason = definition.harness === "codex" && action === "install"
        ? 'Activation: start codex normally. At "Hooks need review", choose "Review hooks". Trust only the Rivetplane entries with "t", then continue. Do not use --dangerously-bypass-hook-trust.'
        : undefined;
      results.push({ harness: definition.harness, status, path, ...(reason ? { reason } : {}) });
    } catch (error) { results.push({ harness: definition.harness, status: "skipped", path, reason: error instanceof Error ? error.message : String(error) }); }
  }
  if (action === "uninstall" && !await hasOwnedHookConfiguration(home, env)) await uninstallHookBridge({ env, home });
  return results;
}

async function jsonConfig(action: "install" | "uninstall", path: string, definition: HarnessHookDefinition, bridge: HookBridgeInstallation): Promise<"installed" | "updated" | "removed"> {
  let root: Record<string, unknown> = {}; let existed = false;
  try { await assertSafeExistingFile(path); const parsed = JSON.parse(await readFile(path, "utf8")) as unknown; if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Configuration root is not an object"); root = parsed as Record<string, unknown>; existed = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error instanceof SyntaxError ? new Error("Configuration is not valid JSON") : error; }
  const hooksRoot = definition.format === "nested-json" ? object(root.hooks) : root;
  if (definition.harness === "cursor" && root.version === undefined) root.version = 1;
  let changed = false;
  for (const event of definition.events) {
    const entries = Array.isArray(hooksRoot[event]) ? hooksRoot[event] as Array<Record<string, unknown>> : [];
    const filtered = entries.filter((entry) => !JSON.stringify(entry).includes(HOOK_OWNER));
    if (action === "install") {
      const command = bridge.command(definition.harness, event);
      const entry = definition.harness === "cursor" ? { command } : definition.harness === "codex"
        ? { matcher: "*", hooks: [codexCommandHook(command, event)] }
        : { matcher: "*", hooks: [{ type: "command", command, timeout: 125 }] };
      filtered.push(entry); changed = true;
    } else if (filtered.length !== entries.length) changed = true;
    if (filtered.length) hooksRoot[event] = filtered; else delete hooksRoot[event];
  }
  if (definition.format === "nested-json") root.hooks = hooksRoot;
  if (definition.harness === "codex" && action === "install" && root.description === undefined) root.description = `Rivetplane standalone telemetry hooks (${HOOK_OWNER})`;
  if (!changed) return action === "install" ? (existed ? "updated" : "installed") : "removed";
  if (definition.harness === "codex" && action === "uninstall" && root.description === `Rivetplane standalone telemetry hooks (${HOOK_OWNER})` && Object.keys(hooksRoot).length === 0 && Object.keys(root).every((key) => key === "description" || key === "hooks")) { await rm(path); return "removed"; }
  await atomicJson(path, root); return action === "install" ? (existed ? "updated" : "installed") : "removed";
}

async function ownedFile(action: "install" | "uninstall", path: string, source: string): Promise<"installed" | "updated" | "removed"> {
  let prior: string | undefined;
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error("Refused to replace a symbolic link"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try { prior = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (prior !== undefined && !prior.includes(HOOK_OWNER)) throw new Error("Refused to overwrite an unmarked file");
  if (action === "uninstall") {
    if (prior === undefined) return "removed";
    await rm(path); return "removed";
  }
  await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`; await writeFile(temporary, source, { encoding: "utf8", mode: 0o600, flag: "wx" }); if (process.platform !== "win32") await chmod(temporary, 0o600); await rename(temporary, path); if (process.platform !== "win32") await chmod(path, 0o600); return prior === undefined ? "installed" : "updated";
}

function extensionSource(definition: HarnessHookDefinition, bridge: HookBridgeInstallation): string {
  if (definition.harness === "opencode") return openCodePluginSource(bridge);
  throw new Error(`No verified extension generator for ${definition.harness}`);
}

function openCodePluginSource(bridge: HookBridgeInstallation): string {
  return `// ${HOOK_OWNER}
// Generated from https://opencode.ai/docs/plugins/ and the official SDK event types.
export const Rivetplane = async (ctx) => {
  const rawPost = async (url, requestID, body) => {
    const raw = ctx?.client?._client || ctx?.client?.client;
    if (!raw || typeof raw.post !== "function") return false;
    await raw.post({ url, path: { requestID }, body, throwOnError: true, headers: { "Content-Type": "application/json" } });
    return true;
  };
  const replyPermission = async (requestID, reply) => {
    if (await rawPost("/permission/{requestID}/reply", requestID, { reply })) return;
    if (!ctx.client?.permission?.reply) throw new Error("OpenCode plugin client does not expose permission.reply");
    const response = await ctx.client.permission.reply({ requestID, reply }, { throwOnError: true });
    if (response?.error !== undefined) throw new Error("OpenCode permission response was rejected: " + JSON.stringify(response.error));
  };
  const replyQuestion = async (requestID, answers) => {
    if (await rawPost("/question/{requestID}/reply", requestID, { answers })) return;
    if (!ctx.client?.question?.reply) throw new Error("OpenCode plugin client does not expose question.reply");
    const response = await ctx.client.question.reply({ requestID, answers }, { throwOnError: true });
    if (response?.error !== undefined) throw new Error("OpenCode question response was rejected: " + JSON.stringify(response.error));
  };
  return ({
  event: async ({ event }) => {
    if (process.env.RIVETPLANE_HOOKS_DISABLED === "1") return;
    const props = event?.properties || {};
    const session_id = props.sessionID || props.info?.id;
    if (!session_id) return;
    const request_id = props.id || props.requestID;
    let result = { decision: "neutral" };
    try {
      const child = Bun.spawn([${JSON.stringify(bridge.node)}, ${JSON.stringify(bridge.bridge)}, "--owner", ${JSON.stringify(HOOK_OWNER)}, "--harness", "opencode", "--event", event.type], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: process.env });
      child.stdin.write(JSON.stringify(props)); child.stdin.end();
      const output = await new Response(child.stdout).text(); await child.exited;
      if (output) result = JSON.parse(output);
    } catch {}
    if (!request_id || result.decision === "neutral") return;
    if (event.type === "permission.asked") {
      const reply = result.decision === "deny" ? "reject" : result.scope && result.scope !== "once" ? "always" : "once";
      await replyPermission(request_id, reply);
    } else if (event.type === "question.asked" && result.decision === "answer") {
      const count = Array.isArray(props.questions) ? props.questions.length : 1;
      const supplied = result.updated_input?.answers;
      const answers = Array.isArray(supplied) ? Array.from({ length: count }, (_, index) => Array.isArray(supplied[index]) ? supplied[index] : []) : Array.from({ length: count }, (_, index) => index === 0 ? [result.response || ""] : []);
      await replyQuestion(request_id, answers);
    }
  },
  });
};
`;
}

async function atomicJson(path: string, value: unknown): Promise<void> { await assertSafeExistingFile(path, true); await mkdir(dirname(path), { recursive: true }); const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" }); if (process.platform !== "win32") await chmod(temp, 0o600); await rename(temp, path); if (process.platform !== "win32") await chmod(path, 0o600); }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function codexCommandHook(command: string, event: string): Record<string, unknown> { return { type: "command", command, timeout: event === "SessionEnd" ? 1 : 3, async: event !== "SessionEnd", statusMessage: "Reporting telemetry to Rivetplane" }; }
async function executableExists(name: string, pathValue = ""): Promise<boolean> { const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""]; for (const directory of pathValue.split(delimiter)) for (const extension of extensions) try { await access(join(directory, `${name}${extension}`)); return true; } catch {} return false; }

function configPath(definition: HarnessHookDefinition, home: string, env: NodeJS.ProcessEnv): string {
  const root = definition.env_home && env[definition.env_home] ? env[definition.env_home]! : home;
  const relative = definition.env_home && env[definition.env_home] ? definition.config.replace(/^\.[^/]+\//, "") : definition.config;
  return join(root, relative);
}

async function inspectCodexConfig(home: string, env: NodeJS.ProcessEnv): Promise<void> {
  const root = env.CODEX_HOME || join(home, ".codex");
  await assertSafeExistingFile(join(root, "config.toml"), true);
}

async function assertSafeExistingFile(path: string, allowMissing = false): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("Refused to use a symbolic link");
    if (!info.isFile()) throw new Error("Refused to use a non-regular file");
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("Refused to use a file owned by another user");
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function hasOwnedHookConfiguration(home: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  for (const definition of HARNESS_HOOKS.filter((item) => item.verified)) {
    try { if ((await readFile(configPath(definition, home, env), "utf8")).includes(HOOK_OWNER)) return true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return false;
}
