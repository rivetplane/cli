import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import test from "node:test";
import { claudeHookSettings, codexHookSettings, HARNESS_HOOKS, installHooks, refreshInstalledHooks, uninstallHooks } from "./hook-install.js";
import { defaultHookBridgePath } from "./hook-bridge-install.js";
import { defaultHookDiscoveryPath } from "./hook-discovery.js";
import { LocalApi } from "./local-api.js";
import { SessionRegistry } from "./registry.js";
import { HookIngestor } from "./hook-ingestion.js";

test("matches the checked official Claude settings fixture", async () => {
  const expected = JSON.parse(await readFile(join(process.cwd(), "src", "fixtures", "hooks", "claude-code", "settings.json"), "utf8"));
  const fixtureBridge = { node: "node", bridge: "bridge", statusline: "statusline", statusLineCommand: () => "statusline", command: (harness: string, event: string) => `rivetplane hook emit --owner rivetplane-hook-v1 --harness ${harness} --event ${event}` };
  assert.deepEqual(claudeHookSettings(fixtureBridge), expected);
});

test("matches the checked official Codex hooks fixture", async () => {
  const expected = JSON.parse(await readFile(join(process.cwd(), "src", "fixtures", "hooks", "codex", "hooks.json"), "utf8"));
  const fixtureBridge = { node: "node", bridge: "bridge", statusline: "statusline", statusLineCommand: () => "statusline", command: (harness: string, event: string) => `rivetplane hook emit --owner rivetplane-hook-v1 --harness ${harness} --event ${event}` };
  assert.deepEqual(codexHookSettings(fixtureBridge), expected);
});

test("merges Codex hooks, preserves config.toml, honors CODEX_HOME, and removes only owned entries", async () => {
  const home = await mkdtemp(join(tmpdir(), "rivetplane-codex-hooks-")); const codexHome = join(home, "custom-codex"); await mkdir(codexHome);
  const config = join(codexHome, "config.toml"); const configSource = 'model = "gpt-user"\n[features]\nhooks = true\n'; await writeFile(config, configSource);
  const hooksPath = join(codexHome, "hooks.json"); const foreign = { matcher: "^shell$", hooks: [{ type: "command", command: "user-hook", async: true }] };
  await writeFile(hooksPath, JSON.stringify({ description: "User hooks", custom: { keep: true }, hooks: { PreToolUse: [foreign] } }));
  const installed = await installHooks({ home, env: { CODEX_HOME: codexHome }, only: ["codex"], executable: async () => true });
  assert.equal(installed[0]?.status, "updated"); assert.match(installed[0]?.reason ?? "", /Review hooks/); assert.match(installed[0]?.reason ?? "", /Do not use --dangerously-bypass-hook-trust/);
  const value = JSON.parse(await readFile(hooksPath, "utf8")) as { description: string; custom: unknown; hooks: Record<string, unknown[]> };
  assert.equal(value.description, "User hooks"); assert.deepEqual(value.custom, { keep: true }); assert.equal(value.hooks.PreToolUse?.length, 2);
  assert.equal(await readFile(config, "utf8"), configSource);
  await uninstallHooks({ home, env: { CODEX_HOME: codexHome }, only: ["codex"], executable: async () => true });
  const clean = JSON.parse(await readFile(hooksPath, "utf8")) as { description: string; custom: unknown; hooks: Record<string, unknown[]> };
  assert.equal(clean.description, "User hooks"); assert.deepEqual(clean.custom, { keep: true }); assert.deepEqual(clean.hooks.PreToolUse, [foreign]); assert.equal(await readFile(config, "utf8"), configSource);
});

test("merges and uninstalls only owned Claude hook entries", async () => {
  const home = await mkdtemp(join(tmpdir(), "rivetplane-hooks-")); const config = join(home, ".claude", "settings.json"); await mkdir(join(home, ".claude"));
  const originalStatusLine = { type: "command", command: `"${process.execPath}" -e "process.stdout.write('user-line')"`, padding: 2 };
  await writeFile(config, JSON.stringify({ theme: "dark", statusLine: originalStatusLine, hooks: { PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "user-script" }] }] } }));
  const executable = async () => true;
  const installed = await installHooks({ home, env: {}, only: ["claude-code"], executable }); assert.equal(installed[0]?.status, "updated");
  const value = JSON.parse(await readFile(config, "utf8")) as { theme: string; statusLine: { command: string; padding: number }; hooks: Record<string, unknown[]> };
  assert.equal(value.theme, "dark"); assert.equal(value.hooks.PostToolUse!.length, 2); assert.equal(value.statusLine.padding, 2); assert.match(value.statusLine.command, /claude-statusline\.cjs/); assert.equal(value.statusLine.command.includes("process.stdout.write"), false, "the original command is encoded, not shell-concatenated");
  const wrapper = join(home, ".config", "harness-cp", "hooks", "v1", "claude-statusline.cjs"); const encoded = Buffer.from(JSON.stringify(originalStatusLine)).toString("base64url");
  const output = await new Promise<string>((resolve, reject) => { const child = spawn(process.execPath, [wrapper, encoded], { env: { ...process.env, RIVETPLANE_HOOKS_DISABLED: "1" } }); let stdout = ""; child.stdout.on("data", (chunk) => { stdout += String(chunk); }); child.once("error", reject); child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`status-line exit ${code}`))); child.stdin.end("{}\n"); });
  assert.equal(output, "user-line", "the wrapper preserves the existing command output");
  await uninstallHooks({ home, env: {}, only: ["claude-code"], executable });
  const clean = JSON.parse(await readFile(config, "utf8")) as { theme: string; statusLine: typeof originalStatusLine; hooks: Record<string, unknown[]> };
  assert.equal(clean.theme, "dark"); assert.equal(clean.hooks.PostToolUse!.length, 1); assert.equal(JSON.stringify(clean).includes("user-script"), true); assert.deepEqual(clean.statusLine, originalStatusLine);
});

test("refreshes only previously installed hooks with the current Node runtime", async () => {
  const home = await mkdtemp(join(tmpdir(), "rivetplane-hook-refresh-")); const executable = async () => true;
  await installHooks({ home, env: {}, only: ["claude-code"], executable });
  const claudePath = join(home, ".claude", "settings.json");
  const stale = (await readFile(claudePath, "utf8")).replaceAll(process.execPath, "/removed/node");
  await writeFile(claudePath, stale);
  const refreshed = await refreshInstalledHooks({ home, env: {}, executable });
  assert.deepEqual(refreshed.map((item) => item.harness), ["claude-code"]);
  const settings = JSON.parse(await readFile(claudePath, "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
  assert.equal(settings.hooks.PermissionRequest?.[0]?.hooks[0]?.command.includes(process.execPath), true);
  await assert.rejects(access(join(home, ".config", "opencode", "plugins", "rivetplane.ts")), /ENOENT/);
});

test("installs only harnesses with checked official configuration and event fixtures", async () => {
  const home = await mkdtemp(join(tmpdir(), "rivetplane-hooks-")); const results = await installHooks({ home, executable: async () => true, env: {} });
  assert.equal(HARNESS_HOOKS.length, 17); assert.equal(results.length, 17);
  assert.deepEqual(HARNESS_HOOKS.filter((item) => item.verified).map((item) => item.harness), ["claude-code", "codex", "opencode"]);
  assert.deepEqual(results.filter((item) => item.status === "installed" || item.status === "updated").map((item) => item.harness), ["claude-code", "codex", "opencode"]);
  for (const definition of HARNESS_HOOKS.filter((item) => item.verified)) { assert.ok(definition.official_source); assert.ok(definition.fixture); await readFile(join(process.cwd(), "src", definition.fixture!, definition.harness === "claude-code" ? "settings.json" : definition.harness === "codex" ? "hooks.json" : "plugin-contract.json")); }
  for (const result of results.filter((item) => item.status === "skipped")) assert.match(result.reason ?? "", /Unsupported/);
  const plugin = await readFile(join(home, ".config", "opencode", "plugins", "rivetplane.ts"), "utf8");
  assert.match(plugin, /export const Rivetplane/); assert.match(plugin, /updated_input\?\.answers/); assert.match(plugin, /--owner/); assert.doesNotMatch(plugin, /http:\/\/127\.0\.0\.1:41737/);
  assert.doesNotMatch(plugin, /\["rivetplane"/); assert.match(plugin, new RegExp(JSON.stringify(defaultHookBridgePath({}, home)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const bridge = defaultHookBridgePath({}, home); const bridgeSource = await readFile(bridge, "utf8");
  assert.match(bridgeSource, /rivetplane-hook-v1:bridge-v1/); assert.match(bridgeSource, /harness === "opencode" && actionable \? 1805000/);
  if (process.platform !== "win32") assert.equal((await stat(bridge)).mode & 0o077, 0);
  await uninstallHooks({ home, executable: async () => true, env: {} }); await assert.rejects(access(bridge), /ENOENT/);
});

test("refuses unmarked files and symbolic-link configuration targets", async () => {
  const home = await mkdtemp(join(tmpdir(), "rivetplane-hooks-")); const plugin = join(home, ".config", "opencode", "plugins", "rivetplane.ts"); await mkdir(join(home, ".config", "opencode", "plugins"), { recursive: true }); await writeFile(plugin, "user content\n");
  const unmarked = await installHooks({ home, env: {}, only: ["opencode"], executable: async () => true });
  assert.equal(unmarked[0]?.status, "skipped"); assert.match(unmarked[0]?.reason ?? "", /unmarked/); assert.equal(await readFile(plugin, "utf8"), "user content\n");
  const claude = join(home, ".claude"); await mkdir(claude); const target = join(home, "user-settings.json"); await writeFile(target, "{}\n"); await symlink(target, join(claude, "settings.json"));
  const linked = await installHooks({ home, env: {}, only: ["claude-code"], executable: async () => true });
  assert.equal(linked[0]?.status, "skipped"); assert.match(linked[0]?.reason ?? "", /symbolic link/); assert.equal(await readFile(target, "utf8"), "{}\n");
  const codexHome = join(home, "codex-home"); await mkdir(codexHome); const tomlTarget = join(home, "user-config.toml"); await writeFile(tomlTarget, 'model = "user"\n'); await symlink(tomlTarget, join(codexHome, "config.toml"));
  const codexLinked = await installHooks({ home, env: { CODEX_HOME: codexHome }, only: ["codex"], executable: async () => true });
  assert.equal(codexLinked[0]?.status, "skipped"); assert.match(codexLinked[0]?.reason ?? "", /symbolic link/); assert.equal(await readFile(tomlTarget, "utf8"), 'model = "user"\n');
});

test("uses verified config-directory overrides and does not probe unsupported binaries", async () => {
  const home = await mkdtemp(join(tmpdir(), "rivetplane-hooks-")); const claudeRoot = join(home, "custom-claude");
  const installed = await installHooks({ home, env: { CLAUDE_CONFIG_DIR: claudeRoot }, only: ["claude-code"], executable: async () => true });
  assert.equal(installed[0]?.path, join(claudeRoot, "settings.json"));
  const xdg = join(home, "xdg"); const opencode = await installHooks({ home, env: { XDG_CONFIG_HOME: xdg }, only: ["opencode"], executable: async () => true });
  assert.equal(opencode[0]?.path, join(xdg, "opencode", "plugins", "rivetplane.ts"));
  let probes = 0; const unsupported = await installHooks({ home, only: ["qoder"], executable: async () => { probes++; return true; } });
  assert.equal(unsupported[0]?.status, "skipped"); assert.equal(probes, 0);
});

test("runs the generated OpenCode plugin with exact owner, payload, and answer arrays", async () => {
  const home = await mkdtemp(join(tmpdir(), "rivetplane-plugin-runtime-")); await installHooks({ home, env: {}, only: ["opencode"], executable: async () => true });
  const pluginPath = join(home, ".config", "opencode", "plugins", "rivetplane.ts"); const modulePath = `${pluginPath.slice(0, -3)}mjs`; await writeFile(modulePath, await readFile(pluginPath, "utf8"));
  const writes: string[] = []; const commands: string[][] = []; let bridge = { decision: "answer", updated_input: { answers: [["Safe"], ["Tests", "Lint"]] } };
  const priorBun = (globalThis as { Bun?: unknown }).Bun;
  (globalThis as { Bun?: unknown }).Bun = { spawn(command: string[]) { commands.push(command); return { stdin: { write(value: string) { writes.push(value); }, end() {} }, stdout: JSON.stringify(bridge), exited: Promise.resolve(0) }; } };
  const nativeRequests: Array<{ kind: string; input: Record<string, unknown> }> = [];
  try {
    const plugin = await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`) as { Rivetplane(context: unknown): Promise<{ event(input: unknown): Promise<void> }> };
    const hook = await plugin.Rivetplane({ directory: "/repo", client: { question: { reply(input: Record<string, unknown>) { nativeRequests.push({ kind: "question", input }); return {}; } }, permission: { reply(input: Record<string, unknown>) { nativeRequests.push({ kind: "permission", input }); return {}; } } } });
    const question = JSON.parse(await readFile(join(process.cwd(), "src", "fixtures", "hooks", "opencode", "question-asked.json"), "utf8"));
    await hook.event({ event: question });
    assert.equal(nativeRequests.length, 1);
    assert.equal(nativeRequests[0]?.kind, "question");
    assert.deepEqual(nativeRequests[0]?.input, { requestID: "question-full", answers: [["Safe"], ["Tests", "Lint"]] });
    assert.deepEqual(JSON.parse(writes[0]!), question.properties); assert.equal(commands[0]?.[0], process.execPath); assert.equal(commands[0]?.[1], defaultHookBridgePath({}, home)); assert.equal(commands[0]?.includes("--owner"), true); assert.equal(commands[0]?.includes("rivetplane-hook-v1"), true);
    bridge = { decision: "answer", updated_input: { answers: [["free text"], []] } }; await hook.event({ event: question });
    assert.deepEqual(nativeRequests[1]?.input, { requestID: "question-full", answers: [["free text"], []] });
  } finally { (globalThis as { Bun?: unknown }).Bun = priorBun; }
});

test("filters unsupported OpenCode events before it spawns the bridge", async () => {
  const home = await mkdtemp(join(tmpdir(), "rivetplane-opencode-filter-")); await installHooks({ home, env: {}, only: ["opencode"], executable: async () => true });
  const source = await readFile(join(home, ".config", "opencode", "plugins", "rivetplane.ts"), "utf8"); const guard = source.indexOf("if (!supportedEvents.has(event?.type)) return;"); const spawnAt = source.indexOf("Bun.spawn");
  assert.ok(guard >= 0); assert.ok(spawnAt > guard, "unsupported high-volume events return before bridge spawn"); await rm(home, { recursive: true, force: true });
});

test("runs installed Claude and OpenCode hooks with no rivetplane binary on PATH", async () => {
  const home = await mkdtemp(join(tmpdir(), "rivetplane clean home with spaces ")); const xdg = join(home, "config with spaces"); const env = { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex"), XDG_CONFIG_HOME: xdg, PATH: "" };
  await installHooks({ home, env, executable: async () => true });
  const registry = new SessionRegistry(); const hooks = new HookIngestor("machine-clean", registry, 5); const discovery = defaultHookDiscoveryPath(env, home);
  const api = new LocalApi(registry, { port: 0, hooks, hook_discovery_path: discovery, target: (id) => hooks.target(id) }); await api.start();
  let claudeCommand = "";
  try {
    const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    claudeCommand = settings.hooks.Stop![0]!.hooks[0]!.command;
    const claude = spawn(claudeCommand, { shell: true, env, stdio: ["pipe", "pipe", "pipe"] }); claude.stdin.end(JSON.stringify({ session_id: "claude-clean", cwd: home, hook_event_name: "Stop" }));
    const claudeOutput = await new Promise<string>((resolve, reject) => { let output = ""; claude.stdout.on("data", (chunk) => { output += chunk; }); claude.once("error", reject); claude.once("close", (code) => code === 0 ? resolve(output) : reject(new Error(`Claude hook exited ${code}`))); });
    assert.equal(claudeOutput.trim(), "{}"); assert.equal(registry.get("claude-clean")?.harness_type, "claude-code");

    const pluginPath = join(xdg, "opencode", "plugins", "rivetplane.ts"); const modulePath = `${pluginPath.slice(0, -3)}mjs`; await writeFile(modulePath, await readFile(pluginPath, "utf8"));
    const priorBun = (globalThis as { Bun?: unknown }).Bun;
    (globalThis as { Bun?: unknown }).Bun = { spawn(command: string[]) { const child = spawn(command[0]!, command.slice(1), { env, stdio: ["pipe", "pipe", "ignore"] }); return { stdin: child.stdin, stdout: Readable.toWeb(child.stdout), exited: new Promise<number>((resolve) => child.once("close", (code) => resolve(code ?? 1))) }; } };
    try {
      const plugin = await import(`${pathToFileURL(modulePath).href}?clean=${Date.now()}`) as { Rivetplane(context: unknown): Promise<{ event(input: unknown): Promise<void> }> };
      const hook = await plugin.Rivetplane({ directory: home, client: { question: { reply() {} }, permission: { reply() {} } } });
      await hook.event({ event: { type: "session.idle", properties: { sessionID: "opencode-clean", directory: home } } });
      assert.equal(registry.get("opencode-clean")?.harness_type, "opencode");
    } finally { (globalThis as { Bun?: unknown }).Bun = priorBun; }
  } finally { await api.stop(); }
  const permissionSettings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
  const offline = spawn(permissionSettings.hooks.PermissionRequest![0]!.hooks[0]!.command, { shell: true, env, stdio: ["pipe", "pipe", "pipe"] }); offline.stdin.end(JSON.stringify({ session_id: "claude-offline", cwd: home, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "pwd" } }));
  const offlineOutput = await new Promise<string>((resolve, reject) => { let output = ""; offline.stdout.on("data", (chunk) => { output += chunk; }); offline.once("error", reject); offline.once("close", (code) => code === 0 ? resolve(output) : reject(new Error(`Offline hook exited ${code}`))); });
  assert.equal(offlineOutput.trim(), "{}");
});
