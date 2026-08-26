import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { claudeHookSettings, HARNESS_HOOKS, installHooks, uninstallHooks } from "./hook-install.js";

test("matches the checked official Claude settings fixture", async () => {
  const expected = JSON.parse(await readFile(join(process.cwd(), "src", "fixtures", "hooks", "claude-code", "settings.json"), "utf8"));
  assert.deepEqual(claudeHookSettings(), expected);
});

test("merges and uninstalls only owned Claude hook entries", async () => {
  const home = await mkdtemp(join(tmpdir(), "rivetplane-hooks-")); const config = join(home, ".claude", "settings.json"); await mkdir(join(home, ".claude"));
  await writeFile(config, JSON.stringify({ theme: "dark", hooks: { PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "user-script" }] }] } }));
  const executable = async () => true;
  const installed = await installHooks({ home, env: {}, only: ["claude-code"], executable }); assert.equal(installed[0]?.status, "updated");
  const value = JSON.parse(await readFile(config, "utf8")) as { theme: string; hooks: Record<string, unknown[]> };
  assert.equal(value.theme, "dark"); assert.equal(value.hooks.PostToolUse!.length, 2);
  await uninstallHooks({ home, env: {}, only: ["claude-code"], executable });
  const clean = JSON.parse(await readFile(config, "utf8")) as { theme: string; hooks: Record<string, unknown[]> };
  assert.equal(clean.theme, "dark"); assert.equal(clean.hooks.PostToolUse!.length, 1); assert.equal(JSON.stringify(clean).includes("user-script"), true);
});

test("installs only harnesses with checked official configuration and event fixtures", async () => {
  const home = await mkdtemp(join(tmpdir(), "rivetplane-hooks-")); const results = await installHooks({ home, executable: async () => true, env: {} });
  assert.equal(HARNESS_HOOKS.length, 17); assert.equal(results.length, 17);
  assert.deepEqual(HARNESS_HOOKS.filter((item) => item.verified).map((item) => item.harness), ["claude-code", "opencode"]);
  assert.deepEqual(results.filter((item) => item.status === "installed" || item.status === "updated").map((item) => item.harness), ["claude-code", "opencode"]);
  for (const definition of HARNESS_HOOKS.filter((item) => item.verified)) { assert.ok(definition.official_source); assert.ok(definition.fixture); await readFile(join(process.cwd(), "src", definition.fixture!, definition.harness === "claude-code" ? "settings.json" : "plugin-contract.json")); }
  for (const result of results.filter((item) => item.status === "skipped")) assert.match(result.reason ?? "", /Unsupported/);
  const plugin = await readFile(join(home, ".config", "opencode", "plugins", "rivetplane.ts"), "utf8");
  assert.match(plugin, /export const Rivetplane/); assert.match(plugin, /updated_input\?\.answers/); assert.match(plugin, /--owner/); assert.doesNotMatch(plugin, /http:\/\/127\.0\.0\.1:41737/);
});

test("refuses unmarked files and symbolic-link configuration targets", async () => {
  const home = await mkdtemp(join(tmpdir(), "rivetplane-hooks-")); const plugin = join(home, ".config", "opencode", "plugins", "rivetplane.ts"); await mkdir(join(home, ".config", "opencode", "plugins"), { recursive: true }); await writeFile(plugin, "user content\n");
  const unmarked = await installHooks({ home, env: {}, only: ["opencode"], executable: async () => true });
  assert.equal(unmarked[0]?.status, "skipped"); assert.match(unmarked[0]?.reason ?? "", /unmarked/); assert.equal(await readFile(plugin, "utf8"), "user content\n");
  const claude = join(home, ".claude"); await mkdir(claude); const target = join(home, "user-settings.json"); await writeFile(target, "{}\n"); await symlink(target, join(claude, "settings.json"));
  const linked = await installHooks({ home, env: {}, only: ["claude-code"], executable: async () => true });
  assert.equal(linked[0]?.status, "skipped"); assert.match(linked[0]?.reason ?? "", /symbolic link/); assert.equal(await readFile(target, "utf8"), "{}\n");
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
  const questionReplies: unknown[] = []; const permissionReplies: unknown[] = [];
  try {
    const plugin = await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`) as { Rivetplane(context: unknown): Promise<{ event(input: unknown): Promise<void> }> };
    const hook = await plugin.Rivetplane({ directory: "/repo", client: { question: { reply(input: unknown) { questionReplies.push(input); } }, permission: { reply(input: unknown) { permissionReplies.push(input); } } } });
    const question = JSON.parse(await readFile(join(process.cwd(), "src", "fixtures", "hooks", "opencode", "question-asked.json"), "utf8"));
    await hook.event({ event: question });
    assert.deepEqual(questionReplies, [{ requestID: "question-full", directory: "/repo", answers: [["Safe"], ["Tests", "Lint"]] }]);
    assert.deepEqual(JSON.parse(writes[0]!), question.properties); assert.equal(commands[0]?.includes("--owner"), true); assert.equal(commands[0]?.includes("rivetplane-hook-v1"), true);
    bridge = { decision: "answer", updated_input: { answers: [["free text"], []] } }; await hook.event({ event: question });
    assert.deepEqual((questionReplies[1] as { answers: unknown }).answers, [["free text"], []]); assert.equal(permissionReplies.length, 0);
  } finally { (globalThis as { Bun?: unknown }).Bun = priorBun; }
});
