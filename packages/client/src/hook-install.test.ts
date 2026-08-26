import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HARNESS_HOOKS, installHooks, uninstallHooks } from "./hook-install.js";

test("merges and uninstalls only owned JSON hook entries", async () => {
  const home = await mkdtemp(join(tmpdir(), "rivetplane-hooks-")); const config = join(home, ".claude", "settings.json"); await mkdir(join(home, ".claude"));
  await writeFile(config, JSON.stringify({ theme: "dark", hooks: { PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "user-script" }] }] } }));
  const executable = async () => true;
  const installed = await installHooks({ home, only: ["claude-code"], executable }); assert.equal(installed[0]?.status, "updated");
  const value = JSON.parse(await readFile(config, "utf8")) as { theme: string; hooks: Record<string, unknown[]> };
  assert.equal(value.theme, "dark"); assert.equal(value.hooks.PostToolUse!.length, 2);
  await uninstallHooks({ home, only: ["claude-code"], executable });
  const clean = JSON.parse(await readFile(config, "utf8")) as { theme: string; hooks: Record<string, unknown[]> };
  assert.equal(clean.theme, "dark"); assert.equal(clean.hooks.PostToolUse!.length, 1); assert.equal(JSON.stringify(clean).includes("user-script"), true);
});

test("has a checked adapter fixture for every requested harness", async () => {
  const home = await mkdtemp(join(tmpdir(), "rivetplane-hooks-")); const results = await installHooks({ home, executable: async () => true, env: {} });
  assert.equal(HARNESS_HOOKS.length, 17); assert.equal(results.length, 17);
  assert.deepEqual(results.map((item) => item.harness), HARNESS_HOOKS.map((item) => item.harness));
  assert.equal(results.find((item) => item.harness === "rovo-dev")?.status, "skipped");
  for (const result of results.filter((item) => item.status === "installed" || item.status === "updated")) {
    assert.ok(result.path); assert.equal((await readFile(result.path!, "utf8")).includes("rivetplane-hook-v1"), true, result.harness);
  }
});

test("refuses to overwrite an unmarked extension file", async () => {
  const home = await mkdtemp(join(tmpdir(), "rivetplane-hooks-")); const path = join(home, ".pi", "agent", "extensions", "rivetplane.ts"); await mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true }); await writeFile(path, "user content\n");
  const result = await installHooks({ home, only: ["pi"], executable: async () => true });
  assert.equal(result[0]?.status, "skipped"); assert.match(result[0]?.reason ?? "", /unmarked/); assert.equal(await readFile(path, "utf8"), "user content\n");
});

test("uses a harness config-directory override and reports absent binaries", async () => {
  const home = await mkdtemp(join(tmpdir(), "rivetplane-hooks-")); const override = join(home, "custom-claude");
  const installed = await installHooks({ home, env: { CLAUDE_CONFIG_DIR: override }, only: ["claude-code"], executable: async () => true });
  assert.equal(installed[0]?.path, join(override, "settings.json"));
  const absent = await installHooks({ home, only: ["qoder"], executable: async () => false }); assert.equal(absent[0]?.status, "absent");
  const piRoot = join(home, "pi-root"); const pi = await installHooks({ home, env: { PI_CODING_AGENT_DIR: piRoot }, only: ["pi"], executable: async () => true }); assert.equal(pi[0]?.path, join(piRoot, "extensions", "rivetplane.ts"));
});
