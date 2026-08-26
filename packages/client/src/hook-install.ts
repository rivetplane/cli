import { access, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";
import { HOOK_OWNER } from "./hook-discovery.js";

export { HOOK_OWNER } from "./hook-discovery.js";

export type HarnessOperation = "actionable" | "telemetry" | "lifecycle" | "unsupported";
export interface HarnessHookDefinition { harness: string; binary: string; config: string; events: string[]; operation: HarnessOperation; restore?: string; format: "nested-json" | "owned-extension" | "none"; env_home?: string; verified: boolean; official_source?: string; fixture?: string }

export const HARNESS_HOOKS: readonly HarnessHookDefinition[] = [
  { harness: "claude-code", binary: "claude", config: ".claude/settings.json", env_home: "CLAUDE_CONFIG_DIR", events: ["PermissionRequest", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"], operation: "actionable", restore: "claude --resume <id>", format: "nested-json", verified: true, official_source: "https://code.claude.com/docs/en/hooks", fixture: "fixtures/hooks/claude-code" },
  { harness: "codex", binary: "codex", config: ".codex/config.toml", events: [], operation: "unsupported", format: "none", verified: false },
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

export function claudeHookSettings(): Record<string, unknown> {
  const definition = HARNESS_HOOKS.find((item) => item.harness === "claude-code")!; const hooks: Record<string, unknown[]> = {};
  for (const event of definition.events) hooks[event] = [{ matcher: "*", hooks: [{ type: "command", command: `rivetplane hook emit --owner ${HOOK_OWNER} --harness claude-code --event ${event}`, timeout: 125 }] }];
  return { hooks };
}

async function applyHooks(action: "install" | "uninstall", options: InstallerOptions): Promise<InstallResult[]> {
  const env = options.env ?? process.env; const home = options.home ?? homedir(); const results: InstallResult[] = [];
  for (const definition of HARNESS_HOOKS) {
    if (options.only && !options.only.includes(definition.harness)) continue;
    if (!definition.verified || definition.format === "none") { results.push({ harness: definition.harness, status: "skipped", reason: "Unsupported: no checked official configuration and event fixture" }); continue; }
    const present = await (options.executable ?? ((name) => executableExists(name, options.path ?? env.PATH)))(definition.binary);
    if (!present) { results.push({ harness: definition.harness, status: "absent", reason: `${definition.binary} was not found` }); continue; }
    const root = definition.env_home && env[definition.env_home] ? env[definition.env_home]! : home;
    const relative = definition.env_home && env[definition.env_home] ? definition.env_home === "PI_CODING_AGENT_DIR" ? definition.config.replace(/^\.pi\/agent\//, "") : definition.config.replace(/^\.[^/]+\//, "") : definition.config;
    const path = join(root, relative);
    try {
      const status = definition.format === "owned-extension" ? await ownedFile(action, path, extensionSource(definition)) : await jsonConfig(action, path, definition);
      results.push({ harness: definition.harness, status, path });
    } catch (error) { results.push({ harness: definition.harness, status: "skipped", path, reason: error instanceof Error ? error.message : String(error) }); }
  }
  return results;
}

async function jsonConfig(action: "install" | "uninstall", path: string, definition: HarnessHookDefinition): Promise<"installed" | "updated" | "removed"> {
  let root: Record<string, unknown> = {}; let existed = false;
  try { root = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>; existed = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Configuration is not valid JSON"); }
  const hooksRoot = definition.format === "nested-json" ? object(root.hooks) : root;
  if (definition.harness === "cursor" && root.version === undefined) root.version = 1;
  let changed = false;
  for (const event of definition.events) {
    const entries = Array.isArray(hooksRoot[event]) ? hooksRoot[event] as Array<Record<string, unknown>> : [];
    const filtered = entries.filter((entry) => !JSON.stringify(entry).includes(HOOK_OWNER));
    if (action === "install") {
      const command = `rivetplane hook emit --owner ${HOOK_OWNER} --harness ${definition.harness} --event ${event}`;
      const entry = definition.harness === "cursor" ? { command } : { matcher: "*", hooks: [{ type: "command", command, timeout: 125 }] };
      filtered.push(entry); changed = true;
    } else if (filtered.length !== entries.length) changed = true;
    if (filtered.length) hooksRoot[event] = filtered; else delete hooksRoot[event];
  }
  if (definition.format === "nested-json") root.hooks = hooksRoot;
  if (!changed) return action === "install" ? (existed ? "updated" : "installed") : "removed";
  await atomicJson(path, root); return action === "install" ? (existed ? "updated" : "installed") : "removed";
}

async function ownedFile(action: "install" | "uninstall", path: string, source: string): Promise<"installed" | "updated" | "removed"> {
  let prior: string | undefined;
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error("Refused to replace a symbolic link"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try { prior = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (prior !== undefined && !prior.includes(HOOK_OWNER)) throw new Error("Refused to overwrite an unmarked file");
  if (action === "uninstall") {
    if (prior === undefined) return "removed";
    await rename(path, `${path}.removed-${Date.now()}`); return "removed";
  }
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, source, { encoding: "utf8", mode: 0o600 }); return prior === undefined ? "installed" : "updated";
}

function extensionSource(definition: HarnessHookDefinition): string {
  if (definition.harness === "opencode") return openCodePluginSource();
  throw new Error(`No verified extension generator for ${definition.harness}`);
}

function openCodePluginSource(): string {
  return `// ${HOOK_OWNER}\n// Generated from https://opencode.ai/docs/plugins/ and the official SDK event types.\nexport const Rivetplane = async (ctx) => ({\n  event: async ({ event }) => {\n    if (process.env.RIVETPLANE_HOOKS_DISABLED === "1") return;\n    const props = event?.properties || {};\n    const session_id = props.sessionID || props.info?.id;\n    if (!session_id) return;\n    const request_id = props.id || props.requestID;\n    let result = { decision: "neutral" };\n    try {\n      const child = Bun.spawn(["rivetplane", "hook", "emit", "--owner", ${JSON.stringify(HOOK_OWNER)}, "--harness", "opencode", "--event", event.type], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: process.env });\n      child.stdin.write(JSON.stringify(props)); child.stdin.end();\n      const output = await new Response(child.stdout).text(); await child.exited;\n      if (output) result = JSON.parse(output);\n    } catch {}\n    if (!request_id || result.decision === "neutral") return;\n    if (event.type === "permission.asked") {\n      const reply = result.decision === "deny" ? "reject" : result.scope && result.scope !== "once" ? "always" : "once";\n      try { await ctx.client.permission.reply({ requestID: request_id, directory: ctx.directory, reply }); } catch {}\n    } else if (event.type === "question.asked" && result.decision === "answer") {\n      const count = Array.isArray(props.questions) ? props.questions.length : 1;\n      const supplied = result.updated_input?.answers;\n      const answers = Array.isArray(supplied) ? Array.from({ length: count }, (_, index) => Array.isArray(supplied[index]) ? supplied[index] : []) : Array.from({ length: count }, (_, index) => index === 0 ? [result.response || ""] : []);\n      try { await ctx.client.question.reply({ requestID: request_id, directory: ctx.directory, answers }); } catch {}\n    }\n  },\n});\n`;
}

async function atomicJson(path: string, value: unknown): Promise<void> { try { if ((await lstat(path)).isSymbolicLink()) throw new Error("Refused to replace a symbolic link"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } await mkdir(dirname(path), { recursive: true }); const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); await rename(temp, path); }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
async function executableExists(name: string, pathValue = ""): Promise<boolean> { const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""]; for (const directory of pathValue.split(delimiter)) for (const extension of extensions) try { await access(join(directory, `${name}${extension}`)); return true; } catch {} return false; }
