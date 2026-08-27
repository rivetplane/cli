import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { OpenCodeExportDiscovery, parseProjectList, parseSessionExport, parseSessionList, resolveOpenCodeExecutable, runBoundedCommand, runBoundedCommandToFile, type CommandRunner } from "./opencode-export-discovery.js";
import { SessionRegistry } from "./registry.js";
import { HarnessControlClient } from "./client.js";

const fixture = (name: string): Promise<string> => readFile(join(process.cwd(), "src", "fixtures", "opencode", name), "utf8");

test("uses export discovery by default and keeps direct HTTP discovery explicit", () => {
  const automatic = new HarnessControlClient({ opencode_executable: process.execPath });
  assert.equal(automatic.opencode, undefined); assert.ok(automatic.opencode_exports);
  const direct = new HarnessControlClient({ opencode_url: "http://127.0.0.1:12345" });
  assert.ok(direct.opencode); assert.equal(direct.opencode_exports, undefined);
});

test("parses the OpenCode list and representative export fixtures", async () => {
  const projects = parseProjectList(await fixture("project-list.json"));
  assert.deepEqual(projects.map((project) => project.id), ["project-a", "project-b", "global"]);
  assert.deepEqual(projects[1]?.sandboxes, ["/projects/b-sandbox"]);
  const sessions = parseSessionList(await fixture("session-list.json"));
  assert.equal(sessions[0]?.id, "ses_question");
  assert.equal(sessions[0]?.directory, "/work/project");
  const exported = parseSessionExport(await fixture("export-question-running.json"));
  assert.equal(exported.info.id, "ses_question");
  assert.equal(exported.messages[1]?.parts[1]?.tool, "question");
});

test("combines two project scopes and the global bucket when started from another repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "rivetplane-opencode-projects-")); const projectA = join(root, "project-a"); const projectB = join(root, "project-b"); const globalBucket = join(root, "global");
  await Promise.all([mkdir(projectA), mkdir(projectB), mkdir(globalBucket)]); const questionExport = await fixture("export-question-running.json"); const listCalls: Array<{ cwd: string; args: readonly string[] }> = [];
  const projects = [{ id: "a", worktree: projectA, sandboxes: [] }, { id: "b", worktree: projectB, sandboxes: [] }, { id: "global", worktree: globalBucket, sandboxes: [] }];
  const scopedFixture = async (name: string, directory: string): Promise<unknown[]> => (JSON.parse(await fixture(name)) as Array<Record<string, unknown>>).map((session) => ({ ...session, directory }));
  const sessionsByDirectory: Record<string, unknown[]> = {
    [projectA]: await scopedFixture("session-list-project-a.json", projectA),
    [projectB]: await scopedFixture("session-list-project-b.json", projectB),
    [globalBucket]: await scopedFixture("session-list-global.json", globalBucket),
  };
  const runner: CommandRunner = async (_program, args, options) => {
    if (args[0] === "debug") return { stdout: JSON.stringify(projects), stderr: "" };
    if (args.includes("list")) { listCalls.push({ cwd: options.cwd, args }); return { stdout: JSON.stringify(sessionsByDirectory[options.cwd] ?? []), stderr: "" }; }
    const id = args.at(-1); if (id === "ses_question") return { stdout: questionExport, stderr: "" };
    return { stdout: JSON.stringify({ info: { id, directory: sessionsByDirectory[projectB]?.some((item) => (item as { id?: string }).id === id) ? projectB : globalBucket, time: { created: 1, updated: 2 } }, messages: [] }), stderr: "" };
  };
  try {
    const registry = new SessionRegistry(); const manager = new OpenCodeExportDiscovery("machine-1", registry, { executable: process.execPath, directory: projectB, checkpoint_path: join(root, "cp.json"), runner });
    await manager.poll();
    assert.deepEqual(registry.list().map((session) => session.id).sort(), ["ses_b", "ses_global", "ses_question"]);
    assert.equal(registry.get("ses_question")?.pending?.id, "call_question_1");
    assert.equal(sessionsByDirectory[projectA]?.some((left) => sessionsByDirectory[projectB]?.some((right) => (left as { id: string }).id === (right as { id: string }).id)), false);
    assert.deepEqual(new Set(listCalls.map((call) => call.cwd)), new Set([projectA, projectB, globalBucket]));
    assert.equal(listCalls.every((call) => call.args.includes("--max-count") && call.args.includes("200")), true); manager.stop();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("discovers one full pending question, deduplicates polls and restart, then clears it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rivetplane-opencode-checkpoint-"));
  const checkpoint = join(directory, "checkpoint.json");
  let updated = 1_787_659_205_000; let complete = false;
  const running = await fixture("export-question-running.json"); const completed = await fixture("export-question-completed.json");
  const runner: CommandRunner = async (_program, args) => args.includes("list")
    ? { stdout: JSON.stringify([{ id: "ses_question", title: "Question session", directory: "/work/project", created: 1_787_659_200_000, updated }]), stderr: "" }
    : { stdout: complete ? completed : running, stderr: "Exporting session\n" };
  try {
    const registry = new SessionRegistry(); const manager = new OpenCodeExportDiscovery("machine-1", registry, { executable: process.execPath, checkpoint_path: checkpoint, runner, recent_window_ms: Number.MAX_SAFE_INTEGER });
    await manager.poll();
    const session = registry.get("ses_question"); const question = session?.pending?.type === "question" ? session.pending : undefined;
    assert.equal(session?.status, "waiting_input"); assert.equal(session?.cwd, "/work/project"); assert.equal(session?.model?.model_id, "claude-sonnet"); assert.equal(session?.agent, "build"); assert.equal(session?.read_only, true);
    assert.equal(question?.id, "call_question_1"); assert.equal(question?.tool_call_id, "call_question_1"); assert.equal(question?.header, "Deploy mode"); assert.equal(question?.prompt, "Which deployment mode should I use?");
    assert.deepEqual(question?.option_details, [{ label: "Safe", description: "Run checks before deployment." }, { label: "Fast", description: "Deploy without the extra checks." }]);
    assert.equal(question?.read_only, true); assert.equal(registry.transcript("ses_question", 0, 100).length, 3);
    await manager.poll(); assert.equal(registry.transcript("ses_question", 0, 100).length, 3);
    manager.stop();

    const restartedRegistry = new SessionRegistry(); const restarted = new OpenCodeExportDiscovery("machine-1", restartedRegistry, { executable: process.execPath, checkpoint_path: checkpoint, runner, recent_window_ms: Number.MAX_SAFE_INTEGER });
    await restarted.poll(); assert.equal(restartedRegistry.get("ses_question")?.pending?.id, "call_question_1"); assert.equal(restartedRegistry.transcript("ses_question", 0, 100).length, 0);
    complete = true; updated = 1_787_659_210_000; await restarted.poll();
    assert.equal(restartedRegistry.get("ses_question")?.pending, null); assert.equal(restartedRegistry.get("ses_question")?.status, "waiting_input");
    assert.deepEqual(restartedRegistry.transcript("ses_question", 0, 100).map((event) => event.type), ["tool_result"]);
    restarted.stop();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("does not replace a live plugin question with its read-only export alias", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rivetplane-opencode-live-plugin-"));
  const running = await fixture("export-question-running.json");
  const runner: CommandRunner = async (_program, args) => args.includes("list")
    ? { stdout: JSON.stringify([{ id: "ses_question", directory, created: 1, updated: 2 }]), stderr: "" }
    : { stdout: running, stderr: "" };
  try {
    const registry = new SessionRegistry();
    registry.upsert({
      id: "ses_question", machine_id: "machine-1", harness_type: "opencode", cwd: directory,
      status: "waiting_input", created_at: new Date(1).toISOString(), last_activity_at: new Date(2).toISOString(),
      pending: { type: "question", id: "que_native_1", session_id: "ses_question", prompt: "Which deployment mode should I use?", requested_at: new Date(2).toISOString(), read_only: false },
      read_only: false, metadata: { transport: "opencode-plugin", hook_mode: "actionable", hook_pending: { id: "que_native_1" } },
    }, { authority: 80 });
    const manager = new OpenCodeExportDiscovery("machine-1", registry, { executable: process.execPath, checkpoint_path: join(directory, "cp.json"), runner, recent_window_ms: Number.MAX_SAFE_INTEGER });
    await manager.poll();
    assert.equal(registry.get("ses_question")?.pending?.id, "que_native_1");
    assert.equal(registry.get("ses_question")?.pending?.read_only, false);
    assert.equal(registry.get("ses_question")?.read_only, false);
    manager.stop();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("does not infer an approval from an unrelated running tool", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rivetplane-opencode-no-approval-"));
  const exportValue = { info: { id: "ses_bash", directory, time: { created: 1, updated: 2 } }, messages: [{ info: { id: "m1", role: "assistant", time: { created: 1 } }, parts: [{ id: "p1", type: "tool", callID: "bash-1", tool: "bash", state: { status: "running", input: { command: "npm test" }, time: { start: 1 } } }] }] };
  const runner: CommandRunner = async (_program, args) => ({ stdout: args.includes("list") ? JSON.stringify([{ id: "ses_bash", directory, created: 1, updated: 2 }]) : JSON.stringify(exportValue), stderr: "" });
  try {
    const registry = new SessionRegistry(); const manager = new OpenCodeExportDiscovery("machine-1", registry, { executable: process.execPath, checkpoint_path: join(directory, "cp.json"), runner, recent_window_ms: Number.MAX_SAFE_INTEGER });
    await manager.poll(); assert.equal(registry.get("ses_bash")?.pending, null); assert.equal(registry.get("ses_bash")?.status, "running"); manager.stop();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("detects only an explicit running permission request and clears its exact request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rivetplane-opencode-approval-")); let completed = false;
  const permission = () => ({ info: { id: "ses_permission", directory, time: { created: 1, updated: 2 } }, messages: [{ info: { id: "m1", role: "assistant", time: { created: 1 } }, parts: [{ id: "p1", type: "tool", callID: "tool-1", tool: "bash", state: completed
    ? { status: "completed", input: { command: "npm test" }, output: "ok", time: { start: 1, end: 2 }, metadata: { permission: { id: "perm-1", status: "completed", permission: "bash" } } }
    : { status: "running", input: { command: "npm test" }, time: { start: 1 }, metadata: { permission: { id: "perm-1", status: "pending", permission: "bash", patterns: ["npm test"] } } } }] }] });
  const runner: CommandRunner = async (_program, args) => ({ stdout: args.includes("list") ? JSON.stringify([{ id: "ses_permission", directory, updated: 2 }]) : JSON.stringify(permission()), stderr: "" });
  try {
    const registry = new SessionRegistry(); const manager = new OpenCodeExportDiscovery("machine-1", registry, { executable: process.execPath, checkpoint_path: join(directory, "cp.json"), runner, recent_window_ms: Number.MAX_SAFE_INTEGER });
    await manager.poll(); assert.equal(registry.get("ses_permission")?.status, "waiting_approval"); assert.equal(registry.get("ses_permission")?.pending?.id, "perm-1"); assert.equal(registry.get("ses_permission")?.pending?.read_only, true);
    assert.equal(registry.transcript("ses_permission").filter((event) => event.type === "permission_request").length, 1);
    completed = true; await manager.poll(); assert.equal(registry.get("ses_permission")?.pending, null); assert.equal(registry.transcript("ses_permission").filter((event) => event.type === "permission_request").length, 1); manager.stop();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("keeps polling after a malformed export and a command timeout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rivetplane-opencode-errors-")); let exportAttempt = 0; let now = 1_800_000_000_000; const warnings: string[] = []; const exportTimeouts: number[] = [];
  const valid = await fixture("export-question-running.json");
  const runner: CommandRunner = async (_program, args, options) => {
    if (args[0] === "debug") return { stdout: JSON.stringify([{ id: "project", worktree: directory, sandboxes: [] }]), stderr: "" };
    if (args.includes("list")) return { stdout: JSON.stringify([{ id: "ses_question", directory, updated: 1 }]), stderr: "" };
    exportTimeouts.push(options.timeout_ms);
    exportAttempt++;
    if (exportAttempt === 1) return { stdout: "{ partial", stderr: "" };
    if (exportAttempt === 2) throw new Error("OpenCode command timed out after 5 ms");
    return { stdout: valid, stderr: "" };
  };
  try {
    const registry = new SessionRegistry(); registry.on("warning", (error) => warnings.push(String(error)));
    const manager = new OpenCodeExportDiscovery("machine-1", registry, { executable: process.execPath, checkpoint_path: join(directory, "cp.json"), runner, now: () => now, recent_window_ms: Number.MAX_SAFE_INTEGER });
    await manager.poll(); await manager.poll(); assert.equal(exportAttempt, 1);
    now += 30_000; await manager.poll(); assert.equal(exportAttempt, 2);
    now += 59_999; await manager.poll(); assert.equal(exportAttempt, 2);
    now += 1; await manager.poll(); assert.equal(exportAttempt, 3);
    assert.equal(warnings.some((value) => value.includes("malformed or partial JSON")), true); assert.equal(warnings.some((value) => value.includes("timed out")), true);
    assert.equal(warnings.some((value) => value.includes("retrying in 30000 ms")), true); assert.equal(warnings.some((value) => value.includes("retrying in 60000 ms")), true);
    assert.deepEqual(exportTimeouts, [30_000, 30_000, 30_000]);
    assert.equal(registry.get("ses_question")?.pending?.id, "call_question_1"); manager.stop();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("limits concurrent OpenCode exports independently from index scans", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rivetplane-opencode-export-concurrency-")); let active = 0; let peak = 0;
  const sessions = Array.from({ length: 5 }, (_, index) => ({ id: `ses_${index}`, directory, updated: 10 - index }));
  const runner: CommandRunner = async (_program, args) => {
    if (args[0] === "debug") return { stdout: JSON.stringify([{ id: "project", worktree: directory, sandboxes: [] }]), stderr: "" };
    if (args.includes("list")) return { stdout: JSON.stringify(sessions), stderr: "" };
    active++; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 5)); active--;
    const id = String(args.at(-1)); return { stdout: JSON.stringify({ info: { id, directory, time: { created: 1, updated: 2 } }, messages: [] }), stderr: "" };
  };
  try {
    const registry = new SessionRegistry(); const manager = new OpenCodeExportDiscovery("machine-1", registry, { executable: process.execPath, directory, checkpoint_path: join(directory, "cp.json"), runner, recent_window_ms: Number.MAX_SAFE_INTEGER });
    await manager.poll(); assert.equal(peak, 2); assert.equal(registry.list().length, 5); manager.stop();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("removes a stale non-running OpenCode session from the relay registry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rivetplane-opencode-stale-roster-")); let now = 1_800_000_000_000; const removed: string[] = [];
  const runner: CommandRunner = async (_program, args) => {
    if (args[0] === "debug") return { stdout: JSON.stringify([{ id: "project", worktree: directory, sandboxes: [] }]), stderr: "" };
    if (args.includes("list")) return { stdout: JSON.stringify([{ id: "ses_stale", directory, created: now - 1_000, updated: 1_800_000_000_000 }]), stderr: "" };
    return { stdout: JSON.stringify({ info: { id: "ses_stale", directory, time: { created: now - 1_000, updated: 1_800_000_000_000 } }, messages: [] }), stderr: "" };
  };
  try {
    const registry = new SessionRegistry(); registry.on("removed", (id) => removed.push(String(id)));
    const manager = new OpenCodeExportDiscovery("machine-1", registry, { executable: process.execPath, directory, checkpoint_path: join(directory, "cp.json"), runner, now: () => now });
    await manager.poll(); assert.equal(registry.get("ses_stale")?.id, "ses_stale");
    now += 5 * 60_000 + 1; await manager.poll(); assert.equal(registry.get("ses_stale"), undefined); assert.deepEqual(removed, ["ses_stale"]); manager.stop();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("resolves OpenCode executables with Unix and Windows PATH rules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rivetplane-opencode-resolve-"));
  try {
    const unix = join(directory, "opencode"); const windows = join(directory, "opencode-cli.exe"); await writeFile(unix, "#!/bin/sh\n", "utf8"); await chmod(unix, 0o755); await writeFile(windows, "fake", "utf8");
    assert.equal(await resolveOpenCodeExecutable({ platform: "linux", env: { PATH: directory } }), unix);
    assert.equal(await resolveOpenCodeExecutable({ platform: "win32", env: { PATH: [directory, "unused"].join(delimiter) } }), windows);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("retries empty Windows list output through a fixed safe shell command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rivetplane-opencode-windows-retry-")); const calls: Array<{ program: string; args: readonly string[] }> = [];
  const runner: CommandRunner = async (program, args) => { calls.push({ program, args }); return args[0] === "debug" || calls.length === 3 ? { stdout: "[]", stderr: "" } : { stdout: "", stderr: "" }; };
  try {
    const registry = new SessionRegistry(); const manager = new OpenCodeExportDiscovery("machine-1", registry, { executable: process.execPath, checkpoint_path: join(directory, "cp.json"), runner, platform: "win32", env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" } });
    await manager.poll(); assert.equal(calls.length, 3); assert.equal(calls[2]?.program, "C:\\Windows\\System32\\cmd.exe");
    assert.deepEqual(calls[2]?.args, ["/d", "/s", "/c", "opencode session list --format json --max-count 200"]); manager.stop();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("detects successful output truncated at exactly 64 KiB and retries with file-backed stdout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rivetplane-opencode-file-retry-")); let fileCalls = 0;
  const truncated = ('[{"id":"ses_large"},' + " ".repeat(65_536)).slice(0, 65_536); assert.equal(Buffer.byteLength(truncated), 65_536);
  const runner: CommandRunner = async (_program, args) => args[0] === "debug" ? { stdout: JSON.stringify([{ id: "p1", worktree: directory, sandboxes: [] }]), stderr: "" } : { stdout: truncated, stderr: "" };
  const fileRunner: CommandRunner = async (_program, args) => {
    fileCalls++;
    if (args[0] === "export") return { stdout: JSON.stringify({ info: { id: "ses_large", directory, time: { created: 1, updated: 2 } }, messages: [] }), stderr: "" };
    return { stdout: JSON.stringify([{ id: "ses_large", directory, created: 1, updated: 2 }]), stderr: "" };
  };
  try {
    const registry = new SessionRegistry(); const manager = new OpenCodeExportDiscovery("machine-1", registry, { executable: process.execPath, directory, checkpoint_path: join(directory, "cp.json"), runner, file_runner: fileRunner, recent_window_ms: Number.MAX_SAFE_INTEGER });
    await manager.poll(); assert.equal(registry.get("ses_large")?.id, "ses_large"); assert.equal(fileCalls, 2); manager.stop();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("uses bounded database pages when a project scope reaches its safe list limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rivetplane-opencode-db-pages-")); let databaseCalls = 0; let scopeCalls = 0; const databaseTimeouts: number[] = [];
  const listed = [{ id: "ses_1", directory, created: 1, updated: 3 }, { id: "ses_2", directory, created: 1, updated: 2 }];
  const indexed = [...listed, { id: "ses_3", directory, created: 1, updated: 1 }];
  const runner: CommandRunner = async (_program, args) => { scopeCalls++; return args[0] === "debug" ? { stdout: JSON.stringify([{ id: "p1", worktree: directory, sandboxes: [] }]), stderr: "" } : { stdout: JSON.stringify(listed), stderr: "" }; };
  const fileRunner: CommandRunner = async (_program, args, options) => {
    if (args[0] === "db") {
      databaseTimeouts.push(options.timeout_ms);
      databaseCalls++; const offset = Number(/OFFSET (\d+)/.exec(String(args[1]))?.[1] ?? 0);
      return { stdout: JSON.stringify(indexed.slice(offset, offset + 2)), stderr: "" };
    }
    const id = String(args.at(-1)); return { stdout: JSON.stringify({ info: { id, directory, time: { created: 1, updated: 2 } }, messages: [] }), stderr: "" };
  };
  try {
    const registry = new SessionRegistry(); const manager = new OpenCodeExportDiscovery("machine-1", registry, { executable: process.execPath, directory, checkpoint_path: join(directory, "cp.json"), runner, file_runner: fileRunner, max_sessions_per_project: 2, database_page_size: 2 });
    await manager.poll(); assert.deepEqual(registry.list().map((session) => session.id).sort(), ["ses_1", "ses_2", "ses_3"]); assert.equal(databaseCalls, 2); assert.equal(scopeCalls, 0); assert.deepEqual(databaseTimeouts, [30_000, 30_000]); manager.stop();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("caches thousands of indexed sessions across repeated transcript polls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rivetplane-opencode-large-index-")); let now = 1_800_000_000_000; let projectCalls = 0; let listCalls = 0; let databaseCalls = 0; let exportCalls = 0;
  const indexed = Array.from({ length: 2_501 }, (_, index) => ({ id: `ses_${String(index).padStart(4, "0")}`, directory, created: now - 700_000, updated: now - 600_000 - index }));
  const runner: CommandRunner = async (_program, args) => {
    if (args[0] === "debug") { projectCalls++; return { stdout: JSON.stringify([{ id: "project", worktree: directory, sandboxes: [] }]), stderr: "" }; }
    if (args.includes("list")) { listCalls++; return { stdout: JSON.stringify(indexed.slice(0, 200)), stderr: "" }; }
    throw new Error(`unexpected command ${args.join(" ")}`);
  };
  const fileRunner: CommandRunner = async (_program, args) => {
    if (args[0] === "db") { databaseCalls++; const offset = Number(/OFFSET (\d+)/.exec(String(args[1]))?.[1] ?? 0); return { stdout: JSON.stringify(indexed.slice(offset, offset + 1_000)), stderr: "" }; }
    exportCalls++; const id = String(args.at(-1)); return { stdout: JSON.stringify({ info: { id, directory, time: { created: now - 10_000, updated: now } }, messages: [] }), stderr: "" };
  };
  try {
    const logs: string[] = []; const registry = new SessionRegistry(); registry.on("log", (message) => logs.push(String(message)));
    const manager = new OpenCodeExportDiscovery("machine-1", registry, { executable: process.execPath, directory, checkpoint_path: join(directory, "cp.json"), runner, file_runner: fileRunner, now: () => now, index_interval_ms: 60_000, max_exports_per_poll: 4, max_export_candidates: 16 });
    await manager.poll(); assert.equal(registry.list().length, 4); assert.equal(projectCalls, 0); assert.equal(listCalls, 0); assert.equal(databaseCalls, 3); assert.equal(exportCalls, 4);
    for (let poll = 0; poll < 5; poll++) { now += 2_000; await manager.poll(); }
    assert.equal(projectCalls, 0); assert.equal(listCalls, 0); assert.equal(databaseCalls, 3); assert.equal(exportCalls, 16); assert.equal(registry.list().length, 0);
    assert.deepEqual(manager.harnesses(), [{ harness_type: "opencode", discovered_sessions: 2_501, attached_sessions: 0 }]);
    assert.deepEqual({ harness_type: manager.capabilities()?.harness_type, can_create_session: manager.capabilities()?.can_create_session, transport: manager.capabilities()?.transport }, { harness_type: "opencode", can_create_session: false, transport: "opencode-cli-export" });
    assert.equal(manager.capabilities()?.session_capabilities?.discovery.mode, "read_only");
    assert.equal(logs.some((message) => message.includes("index refresh completed in") && message.includes("2501 cached sessions")), true);
    assert.equal(logs.some((message) => message.includes("16 active, recent, or probe candidates") && message.includes("selected 16") && message.includes("exporting 4")), true);
    assert.equal(logs.some((message) => message.includes("0 active, recent, or probe candidates") && message.includes("exporting 0")), true); manager.stop();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("aggregates project-scope timeouts when the machine index is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "rivetplane-opencode-fallback-warning-")); const directories = [root, join(root, "a"), join(root, "b")];
  await Promise.all(directories.slice(1).map((directory) => mkdir(directory))); const warnings: string[] = [];
  const runner: CommandRunner = async (_program, args) => {
    if (args[0] === "debug") return { stdout: JSON.stringify(directories.map((directory, index) => ({ id: `p${index}`, worktree: directory, sandboxes: [] }))), stderr: "" };
    throw new Error("OpenCode command timed out after 10000 ms");
  };
  const fileRunner: CommandRunner = async (_program, args) => {
    if (args[0] === "db") throw new Error("OpenCode command timed out after 30000 ms");
    throw new Error("unexpected file command");
  };
  try {
    const registry = new SessionRegistry(); registry.on("warning", (warning) => warnings.push(String(warning)));
    const manager = new OpenCodeExportDiscovery("machine-1", registry, { executable: process.execPath, directory: root, checkpoint_path: join(root, "cp.json"), runner, file_runner: fileRunner });
    await manager.poll();
    assert.equal(warnings.filter((warning) => warning.includes("project fallback could not scan")).length, 1);
    assert.equal(warnings.some((warning) => warning.includes("3 of 3 scopes") && warning.includes("cached sessions remain available")), true);
    assert.equal(warnings.some((warning) => warning.includes("Cannot list OpenCode sessions for")), false); manager.stop();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("finds a new pending session within the configured index refresh bound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rivetplane-opencode-refresh-bound-")); let now = 1_800_000_000_000; let visible = false; let listCalls = 0; const questionExport = await fixture("export-question-running.json");
  const runner: CommandRunner = async (_program, args) => {
    if (args[0] === "debug") return { stdout: JSON.stringify([{ id: "project", worktree: directory, sandboxes: [] }]), stderr: "" };
    if (args.includes("list")) { listCalls++; return { stdout: JSON.stringify(visible ? [{ id: "ses_question", directory, created: now, updated: now }] : []), stderr: "" }; }
    return { stdout: questionExport, stderr: "" };
  };
  try {
    const registry = new SessionRegistry(); const manager = new OpenCodeExportDiscovery("machine-1", registry, { executable: process.execPath, directory, checkpoint_path: join(directory, "cp.json"), runner, now: () => now, index_interval_ms: 60_000 });
    await manager.poll(); visible = true; now += 59_999; await manager.poll(); assert.equal(listCalls, 1); assert.equal(registry.get("ses_question"), undefined);
    now += 1; await manager.poll(); assert.equal(listCalls, 2); assert.equal(registry.get("ses_question")?.pending?.id, "call_question_1"); assert.equal(registry.get("ses_question")?.status, "waiting_input"); manager.stop();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("backs off after a partial index refresh", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rivetplane-opencode-index-backoff-")); let now = 1_800_000_000_000; let projectCalls = 0; const warnings: string[] = [];
  const runner: CommandRunner = async (_program, args) => { if (args[0] === "debug") projectCalls++; throw new Error("index command failed"); };
  try {
    const registry = new SessionRegistry(); registry.on("warning", (warning) => warnings.push(String(warning)));
    const manager = new OpenCodeExportDiscovery("machine-1", registry, { executable: process.execPath, directory, checkpoint_path: join(directory, "cp.json"), runner, now: () => now, index_interval_ms: 60_000 });
    await manager.poll(); assert.equal(projectCalls, 1); now += 119_999; await manager.poll(); assert.equal(projectCalls, 1);
    now += 1; await manager.poll(); assert.equal(projectCalls, 2); assert.equal(warnings.some((warning) => warning.includes("index refresh backoff is 120000 ms")), true); manager.stop();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("bounds command time and output and cleans up the subprocess", async () => {
  await assert.rejects(runBoundedCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: process.cwd(), timeout_ms: 30, max_output_bytes: 1_024 }), /timed out/);
  await assert.rejects(runBoundedCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], { cwd: process.cwd(), timeout_ms: 2_000, max_output_bytes: 100 }), /output exceeded/);
  const fileResult = await runBoundedCommandToFile(process.execPath, ["-e", "process.stdout.write('x'.repeat(200000))"], { cwd: process.cwd(), timeout_ms: 2_000, max_output_bytes: 300_000 });
  assert.equal(fileResult.stdout.length, 200_000);
  await assert.rejects(runBoundedCommandToFile(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], { cwd: process.cwd(), timeout_ms: 2_000, max_output_bytes: 100 }), /output exceeded/);
});

test("runs list, export, update, and disappearance through a fake OpenCode executable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rivetplane-opencode-e2e-")); const statePath = join(directory, "state.json"); const fakePath = join(directory, "fake-opencode.mjs"); const checkpoint = join(directory, "cp.json");
  const running = JSON.parse(await fixture("export-question-running.json")) as unknown; const completed = JSON.parse(await fixture("export-question-completed.json")) as unknown;
  const fake = `import { readFileSync } from "node:fs";\nconst state = JSON.parse(readFileSync(process.argv[2], "utf8"));\nconst args = process.argv.slice(3);\nif (args[0] === "debug") process.stdout.write(JSON.stringify(state.projects));\nelse if (args[0] === "session") process.stdout.write(JSON.stringify(state.sessions));\nelse if (args[0] === "export") { const value = state.exports[args[1]]; if (!value) process.exit(2); process.stdout.write(JSON.stringify(value)); }\nelse process.exit(3);\n`;
  try {
    const projects = [{ id: "fake-project", worktree: directory, sandboxes: [] }];
    await writeFile(fakePath, fake, "utf8"); await writeFile(statePath, JSON.stringify({ projects, sessions: [{ id: "ses_question", directory, updated: 1 }], exports: { ses_question: running } }), "utf8");
    const registry = new SessionRegistry(); const removed: string[] = []; registry.on("removed", (id) => removed.push(String(id)));
    const manager = new OpenCodeExportDiscovery("machine-1", registry, { executable: process.execPath, executable_args: [fakePath, statePath], checkpoint_path: checkpoint, directory, timeout_ms: 2_000, index_interval_ms: 0, recent_window_ms: Number.MAX_SAFE_INTEGER });
    await manager.poll(); assert.equal(registry.get("ses_question")?.pending?.id, "call_question_1");
    await writeFile(statePath, JSON.stringify({ projects, sessions: [{ id: "ses_question", directory, updated: 2 }], exports: { ses_question: completed } }), "utf8");
    await manager.poll(); assert.equal(registry.get("ses_question")?.pending, null);
    await writeFile(statePath, JSON.stringify({ projects, sessions: [], exports: {} }), "utf8"); await manager.poll();
    assert.equal(registry.get("ses_question"), undefined); assert.deepEqual(removed, ["ses_question"]); manager.stop();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
