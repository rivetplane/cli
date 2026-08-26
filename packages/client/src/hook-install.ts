import { access, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";

export const HOOK_OWNER = "rivetplane-hook-v1";

export type HarnessOperation = "actionable" | "telemetry" | "lifecycle" | "unsupported";
export interface HarnessHookDefinition { harness: string; binary: string; config: string; events: string[]; operation: HarnessOperation; restore?: string; format: "nested-json" | "direct-json" | "owned-extension" | "none"; env_home?: string }

export const HARNESS_HOOKS: readonly HarnessHookDefinition[] = [
  { harness: "claude-code", binary: "claude", config: ".claude/settings.json", env_home: "CLAUDE_CONFIG_DIR", events: ["PermissionRequest", "PreToolUse", "PostToolUse", "Stop"], operation: "actionable", restore: "claude --resume <id>", format: "nested-json" },
  { harness: "codex", binary: "codex", config: ".codex/hooks.json", env_home: "CODEX_HOME", events: ["SessionStart", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop"], operation: "telemetry", restore: "codex resume <id>", format: "nested-json" },
  { harness: "grok", binary: "grok", config: ".grok/hooks/rivetplane-session.json", env_home: "GROK_HOME", events: ["PreToolUse", "Notification", "Stop"], operation: "telemetry", restore: "grok -r <id>", format: "nested-json" },
  { harness: "opencode", binary: "opencode", config: ".config/opencode/plugins/rivetplane.ts", env_home: "XDG_CONFIG_HOME", events: ["session.created", "session.updated", "session.idle", "permission.asked", "permission.replied", "question.asked", "question.replied"], operation: "actionable", restore: "opencode --session <id>", format: "owned-extension" },
  { harness: "pi", binary: "pi", config: ".pi/agent/extensions/rivetplane.ts", env_home: "PI_CODING_AGENT_DIR", events: ["session_start", "agent_start", "agent_settled", "session_shutdown", "tool_execution_start", "tool_execution_end"], operation: "telemetry", restore: "pi --session <id>", format: "owned-extension" },
  { harness: "omp", binary: "omp", config: ".pi/agent/extensions/rivetplane-omp.ts", env_home: "PI_CODING_AGENT_DIR", events: ["session_start", "agent_start", "agent_settled", "session_shutdown"], operation: "lifecycle", restore: "omp --session <id>", format: "owned-extension" },
  { harness: "campfire", binary: "campfire", config: ".campfire/agent/extensions/rivetplane.ts", env_home: "CAMPFIRE_HOME", events: ["session_start", "agent_start", "agent_settled", "session_shutdown", "notification"], operation: "lifecycle", format: "owned-extension" },
  { harness: "amp", binary: "amp", config: ".config/amp/plugins/rivetplane.ts", env_home: "XDG_CONFIG_HOME", events: ["session.start", "agent.start", "agent.end"], operation: "lifecycle", restore: "amp threads continue <id>", format: "owned-extension" },
  { harness: "cursor", binary: "cursor-agent", config: ".cursor/hooks.json", env_home: "CURSOR_CONFIG_DIR", events: ["beforeShellExecution"], operation: "telemetry", restore: "cursor-agent --resume <id>", format: "nested-json" },
  { harness: "gemini", binary: "gemini", config: ".gemini/settings.json", env_home: "GEMINI_CLI_HOME", events: ["BeforeTool"], operation: "telemetry", restore: "gemini --resume <id>", format: "nested-json" },
  { harness: "kiro", binary: "kiro-cli", config: ".kiro/hooks/rivetplane.json", env_home: "KIRO_HOME", events: ["SessionStart", "PreToolUse", "PostToolUse", "Stop"], operation: "telemetry", restore: "kiro-cli chat --resume-id <id>", format: "owned-extension" },
  { harness: "rovo-dev", binary: "acli", config: ".rovodev/config.yml", events: [], operation: "lifecycle", restore: "acli rovodev run --restore <id>", format: "none" },
  { harness: "copilot", binary: "copilot", config: ".copilot/config.json", env_home: "COPILOT_HOME", events: ["PreToolUse"], operation: "telemetry", restore: "copilot --resume <id>", format: "nested-json" },
  { harness: "codebuddy", binary: "codebuddy", config: ".codebuddy/settings.json", env_home: "CODEBUDDY_HOME", events: ["PreToolUse"], operation: "telemetry", restore: "codebuddy --resume <id>", format: "nested-json" },
  { harness: "factory", binary: "droid", config: ".factory/settings.json", env_home: "FACTORY_HOME", events: ["PreToolUse"], operation: "telemetry", restore: "droid --resume <id>", format: "nested-json" },
  { harness: "qoder", binary: "qodercli", config: ".qoder/settings.json", env_home: "QODER_HOME", events: ["PreToolUse"], operation: "telemetry", restore: "qodercli --resume <id>", format: "nested-json" },
  { harness: "kimi-code", binary: "kimi", config: ".kimi/config.toml", env_home: "KIMI_CLI_HOME", events: ["PreToolUse", "PostToolUse"], operation: "telemetry", format: "owned-extension" },
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
    const present = await (options.executable ?? ((name) => executableExists(name, options.path ?? env.PATH)))(definition.binary);
    if (!present) { results.push({ harness: definition.harness, status: "absent", reason: `${definition.binary} was not found` }); continue; }
    if (definition.format === "none") { results.push({ harness: definition.harness, status: "skipped", reason: "No verified event installation interface" }); continue; }
    const root = definition.env_home && env[definition.env_home] ? env[definition.env_home]! : home;
    const relative = definition.env_home && env[definition.env_home] ? definition.env_home === "PI_CODING_AGENT_DIR" ? definition.config.replace(/^\.pi\/agent\//, "") : definition.config.replace(/^\.[^/]+\//, "") : definition.config;
    const path = join(root, relative);
    try {
      const status = definition.harness === "kimi-code" ? await markedToml(action, path, kimiHooks()) : definition.format === "owned-extension" ? await ownedFile(action, path, extensionSource(definition)) : await jsonConfig(action, path, definition);
      if (definition.harness === "codex") await markedToml(action, join(root, relative.replace(/hooks\.json$/, "config.toml")), codexNotify());
      results.push({ harness: definition.harness, status, path });
    } catch (error) { results.push({ harness: definition.harness, status: "skipped", path, reason: error instanceof Error ? error.message : String(error) }); }
  }
  return results;
}

async function markedToml(action: "install" | "uninstall", path: string, owned: string): Promise<"installed" | "updated" | "removed"> {
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error("Refused to replace a symbolic link"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const begin = `# ${HOOK_OWNER} begin`; const end = `# ${HOOK_OWNER} end`; let prior = ""; let existed = false;
  try { prior = await readFile(path, "utf8"); existed = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const start = prior.indexOf(begin); const finish = prior.indexOf(end);
  if ((start >= 0) !== (finish >= 0) || (start >= 0 && finish < start)) throw new Error("Rivetplane ownership marker is incomplete");
  let next = prior;
  if (start < 0 && owned.startsWith("notify =") && /^\s*notify\s*=/m.test(prior)) return action === "install" ? "updated" : "removed";
  if (start >= 0) next = `${prior.slice(0, start)}${prior.slice(finish + end.length)}`.replace(/\n{3,}/g, "\n\n").trimEnd();
  if (action === "install") next = `${next}${next ? "\n\n" : ""}${begin}\n${owned.trim()}\n${end}\n`;
  else next = next ? `${next}\n` : "";
  await mkdir(dirname(path), { recursive: true }); const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, next, { encoding: "utf8", mode: 0o600 }); await rename(temp, path);
  return action === "install" ? (existed ? "updated" : "installed") : "removed";
}

function kimiHooks(): string { return ["PreToolUse", "PostToolUse"].map((event) => `[[hooks]]\nevent = ${JSON.stringify(event)}\nmatcher = ".*"\ncommand = ${JSON.stringify(`rivetplane hook emit --owner ${HOOK_OWNER} --harness kimi-code --event ${event}`)}\ntimeout = 125`).join("\n\n"); }
function codexNotify(): string { return `notify = ["rivetplane", "hook", "emit", "--owner", "${HOOK_OWNER}", "--harness", "codex", "--event", "Notification"]`; }

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
  if (definition.harness === "kiro") return `${JSON.stringify({ version: "v1", owner: HOOK_OWNER, hooks: definition.events.map((event) => ({ name: `${HOOK_OWNER}-${event}`, trigger: event, matcher: ".*", action: { type: "command", command: `rivetplane hook emit --owner ${HOOK_OWNER} --harness kiro --event ${event}` }, timeout: 125, enabled: true })) }, null, 2)}\n`;
  return `// ${HOOK_OWNER}\n// Generated by Rivetplane. This file sends only native event metadata to the local client.\nexport default async function rivetplaneExtension(api) {\n  const events = ${JSON.stringify(definition.events)};\n  for (const name of events) api.on(name, async (event, ctx) => {\n    if (process.env.RIVETPLANE_HOOKS_DISABLED === "1") return;\n    const session_id = event.session_id || event.sessionId || ctx?.sessionManager?.getSessionId?.();\n    if (!session_id) return;\n    const body = { version: 1, harness: ${JSON.stringify(definition.harness)}, event: name, session_id, cwd: ctx?.cwd || process.cwd(), transport: ${JSON.stringify(`${definition.harness}-extension`)}, request_id: event.request_id || event.id || event.toolCallId, payload: event };\n    try { await fetch(process.env.RIVETPLANE_HOOK_ENDPOINT || "http://127.0.0.1:41737/v1/hooks/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) }); } catch {}\n  });\n}\n`;
}

function openCodePluginSource(): string {
  return `// ${HOOK_OWNER}\n// Generated by Rivetplane from the public OpenCode plugin interface.\nexport const Rivetplane = async (ctx) => ({\n  event: async ({ event }) => {\n    if (process.env.RIVETPLANE_HOOKS_DISABLED === "1") return;\n    const props = event?.properties || {};\n    const session_id = props.sessionID || props.info?.id;\n    if (!session_id) return;\n    const request_id = props.id || props.requestID;\n    const actionable = event.type === "permission.asked" || event.type === "question.asked";\n    const body = { version: 1, harness: "opencode", event: event.type, session_id, request_id, cwd: props.info?.directory || ctx.directory || process.cwd(), transport: "opencode-plugin", payload: props };\n    let result = { decision: "neutral" };\n    try {\n      const response = await fetch(process.env.RIVETPLANE_HOOK_ENDPOINT || "http://127.0.0.1:41737/v1/hooks/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(actionable ? 125000 : 3000) });\n      if (response.ok) result = await response.json();\n    } catch {}\n    if (!request_id || result.decision === "neutral") return;\n    if (event.type === "permission.asked") {\n      const reply = result.decision === "deny" ? "reject" : result.scope && result.scope !== "once" ? "always" : "once";\n      try { await ctx.client.permission.reply({ requestID: request_id, directory: body.cwd, reply }); } catch {}\n    } else if (event.type === "question.asked" && result.decision === "answer") {\n      const count = Array.isArray(props.questions) ? props.questions.length : 1;\n      const answers = Array.from({ length: count }, (_, index) => index === 0 ? [result.response || ""] : []);\n      try { await ctx.client.question.reply({ requestID: request_id, directory: body.cwd, answers }); } catch {}\n    }\n  },\n});\n`;
}

async function atomicJson(path: string, value: unknown): Promise<void> { try { if ((await lstat(path)).isSymbolicLink()) throw new Error("Refused to replace a symbolic link"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } await mkdir(dirname(path), { recursive: true }); const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); await rename(temp, path); }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
async function executableExists(name: string, pathValue = ""): Promise<boolean> { const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""]; for (const directory of pathValue.split(delimiter)) for (const extension of extensions) try { await access(join(directory, `${name}${extension}`)); return true; } catch {} return false; }
