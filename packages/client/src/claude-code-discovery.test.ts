import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { ClaudeCodeDiscovery, parseClaudeAgents, resolveClaudeExecutable, type ClaudeAgent, type ClaudeCodeDiscoveryOptions } from "./claude-code-discovery.js";
import { SessionRegistry } from "./registry.js";

const sessionId = "11111111-2222-4333-8444-555555555555";
const fixture = (name: string): Promise<string> => readFile(join(process.cwd(), "src", "fixtures", "claude", name), "utf8");

async function setup(): Promise<{ root: string; config: string; transcript: string; state: string }> {
  const root = await mkdtemp(join(tmpdir(), "rivetplane-claude-test-")); const config = join(root, ".claude");
  const project = join(config, "projects", "-private-tmp-claude-project"); const job = join(config, "jobs", "11111111");
  await mkdir(project, { recursive: true }); await mkdir(job, { recursive: true });
  const transcript = join(project, `${sessionId}.jsonl`); const state = join(job, "state.json");
  await writeFile(transcript, await fixture("transcript-question.jsonl")); await writeFile(state, await fixture("state-question.json"));
  return { root, config, transcript, state };
}

function runner(agents: () => ClaudeAgent[]): NonNullable<ClaudeCodeDiscoveryOptions["runner"]> {
  return async (_program, args) => args.includes("--version") ? { stdout: "2.1.245 (Claude Code)\n", stderr: "" } : { stdout: JSON.stringify(agents()), stderr: "" };
}

test("parses machine-wide agents and keeps stable Claude session IDs", async () => {
  const agents = parseClaudeAgents(await fixture("agents-question.json"));
  assert.equal(agents[0]?.sessionId, sessionId); assert.equal(agents[0]?.cwd, "/private/tmp/claude-project"); assert.equal(agents[0]?.waitingFor, "input needed");
});

test("discovers outside the client cwd, hides subagents, tails once, and reports a safe question", async () => {
  const env = await setup(); let agents = parseClaudeAgents(await fixture("agents-question.json")); const registry = new SessionRegistry();
  try {
    const manager = new ClaudeCodeDiscovery("machine-1", registry, { executable: process.execPath, directory: join(env.root, "different-start-directory"), config_dir: env.config, checkpoint_path: join(env.root, "checkpoint.json"), runner: runner(() => agents) });
    await manager.poll(); const session = registry.get(sessionId); const pending = session?.pending?.type === "question" ? session.pending : undefined;
    assert.equal(registry.list().length, 1); assert.equal(session?.cwd, "/private/tmp/claude-project"); assert.equal(session?.title, "Disposable test"); assert.equal(session?.status, "waiting_input"); assert.equal(session?.read_only, true);
    assert.equal(pending?.id, "toolu_exact_question"); assert.equal(pending?.tool_call_id, "toolu_exact_question"); assert.equal(pending?.read_only, true); assert.deepEqual(pending?.options, ["Blue", "Green"]);
    assert.deepEqual(registry.transcript(sessionId).map((event) => event.type), ["user_message", "agent_message", "tool_call"]);
    await manager.poll(); assert.equal(registry.transcript(sessionId).length, 3);
    const health = manager.harnesses()[0]; assert.equal(health?.capabilities?.discovery.supported, true); assert.equal(health?.capabilities?.messaging.supported, false); assert.match(health?.capabilities?.messaging.reason ?? "", /cc-socks/);
    agents = []; await manager.poll(); assert.equal(registry.get(sessionId)?.status, "completed"); assert.equal(registry.transcript(sessionId).length, 4); assert.equal(registry.get(sessionId)?.pending, null); manager.stop();
  } finally { await rm(env.root, { recursive: true, force: true }); }
});

test("fails closed for an observed permission wait without an exact request ID", async () => {
  const env = await setup(); const agents = parseClaudeAgents(await fixture("agents-question.json")); agents[0] = { ...agents[0]!, waitingFor: "permission prompt" };
  await writeFile(env.state, JSON.stringify({ sessionId, state: "working", detail: "Creating a file", updatedAt: "2026-08-25T15:41:40.233Z" }));
  await writeFile(env.transcript, `${await fixture("transcript-question.jsonl")}\n${JSON.stringify({ type: "assistant", uuid: "bash-message", timestamp: "2026-08-25T15:41:40.000Z", sessionId, isSidechain: false, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "touch proof" } }] } })}\n`);
  try {
    const registry = new SessionRegistry(); const manager = new ClaudeCodeDiscovery("machine-1", registry, { executable: process.execPath, config_dir: env.config, checkpoint_path: join(env.root, "cp.json"), runner: runner(() => agents) });
    await manager.poll(); assert.equal(registry.get(sessionId)?.status, "waiting_approval"); assert.equal(registry.get(sessionId)?.pending, null);
    const target = manager.target(sessionId); assert.ok(target); await assert.rejects(async () => target.sendMessage("test"), /read-only/); await assert.rejects(async () => target.respondToPending("toolu_bash", "approve"), /read-only/); manager.stop();
  } finally { await rm(env.root, { recursive: true, force: true }); }
});

test("accepts only an explicit exact-ID approval state and handles transcript truncation", async () => {
  const env = await setup(); const agents = parseClaudeAgents(await fixture("agents-question.json")); agents[0] = { ...agents[0]!, waitingFor: "permission prompt" };
  await writeFile(env.state, JSON.stringify({ sessionId, updatedAt: "2026-08-25T15:41:40.233Z", block: { permission: { id: "perm_exact_1", toolName: "Bash", input: { command: "touch proof" }, requestedAt: "2026-08-25T15:41:40.000Z" } } }));
  try {
    const registry = new SessionRegistry(); const manager = new ClaudeCodeDiscovery("machine-1", registry, { executable: process.execPath, config_dir: env.config, checkpoint_path: join(env.root, "cp.json"), runner: runner(() => agents) });
    await manager.poll(); assert.equal(registry.get(sessionId)?.pending?.id, "perm_exact_1"); assert.equal(registry.get(sessionId)?.pending?.read_only, true);
    await writeFile(env.transcript, `${JSON.stringify({ type: "assistant", uuid: "rotated-new", timestamp: "2026-08-25T15:42:00.000Z", sessionId, isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "After rotation" }] } })}\n`);
    await manager.poll(); assert.equal(registry.transcript(sessionId).filter((event) => event.type === "agent_message").at(-1)?.payload.text, "After rotation"); manager.stop();
  } finally { await rm(env.root, { recursive: true, force: true }); }
});

test("continues bounded complete lines without waiting for more file data", async () => {
  const env = await setup(); const agents = parseClaudeAgents(await fixture("agents-question.json"));
  try {
    const registry = new SessionRegistry(); const manager = new ClaudeCodeDiscovery("machine-1", registry, { executable: process.execPath, config_dir: env.config, checkpoint_path: join(env.root, "cp.json"), runner: runner(() => agents), max_lines_per_poll: 1 });
    await manager.poll(); assert.equal(registry.transcript(sessionId).length, 1);
    await manager.poll(); assert.equal(registry.transcript(sessionId).length, 3); assert.equal(registry.get(sessionId)?.pending?.id, "toolu_exact_question"); manager.stop();
  } finally { await rm(env.root, { recursive: true, force: true }); }
});

test("resolves Claude on Unix and Windows PATH rules", async () => {
  const root = await mkdtemp(join(tmpdir(), "rivetplane-claude-resolve-"));
  try {
    const unix = join(root, "claude"); const windows = join(root, "claude.exe"); await writeFile(unix, "#!/bin/sh\n"); await chmod(unix, 0o755); await writeFile(windows, "fake");
    assert.equal(await resolveClaudeExecutable({ platform: "linux", env: { PATH: root } }), unix); assert.equal(await resolveClaudeExecutable({ platform: "win32", env: { PATH: [root, "unused"].join(delimiter) } }), windows);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runs discovery through a fake Claude process", async () => {
  const env = await setup(); const fake = join(env.root, "fake-claude.mjs"); const agentsPath = join(env.root, "agents.json");
  await writeFile(agentsPath, await fixture("agents-question.json")); await writeFile(fake, `import { readFileSync } from "node:fs";\nif (process.argv.includes("--version")) process.stdout.write("2.1.245 (Claude Code)\\n"); else if (process.argv.includes("--json")) process.stdout.write(readFileSync(process.argv[2], "utf8")); else process.exit(2);\n`);
  try {
    const registry = new SessionRegistry(); const manager = new ClaudeCodeDiscovery("machine-1", registry, { executable: process.execPath, executable_args: [fake, agentsPath], config_dir: env.config, checkpoint_path: join(env.root, "cp.json"), timeout_ms: 2_000 });
    await manager.poll(); assert.equal(registry.get(sessionId)?.pending?.id, "toolu_exact_question"); manager.stop();
  } finally { await rm(env.root, { recursive: true, force: true }); }
});
