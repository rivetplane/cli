import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ApiClient } from "./api.js";
import { FileConfigStore, type ConfigStore, type StoredConfig } from "./config.js";
import { ExitCode, runCli, type CliIo } from "./run.js";

class MemoryStore implements ConfigStore {
  readonly path = "/memory/api-cli.json";
  value: StoredConfig | undefined;
  async load(): Promise<StoredConfig | undefined> { return this.value; }
  async save(value: StoredConfig): Promise<void> { this.value = value; }
  async remove(): Promise<boolean> { const found = Boolean(this.value); this.value = undefined; return found; }
}

function fakeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    listMachines: async () => [],
    listSessions: async () => [],
    getSession: async () => ({}),
    getTranscript: async () => ({ events: [], next_cursor: null }),
    subscribeToTranscript: async function* () {},
    sendMessage: async () => ({ accepted: true }),
    getPending: async () => ({ pending: null }),
    respondToPending: async () => ({ accepted: true }),
    interruptSession: async () => ({ accepted: true }),
    ...overrides,
  };
}

function harness(input = ""): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      readStdin: async () => input,
      readSecret: async () => input,
      isTty: false,
    },
  };
}

const configured = (): MemoryStore => {
  const store = new MemoryStore();
  store.value = { server: "https://control.example.com", token: "secret" };
  return store;
};

test("login reads a token from stdin and does not print it", async () => {
  const store = new MemoryStore();
  const output = harness("top-secret\n");
  let checked = false;
  const code = await runCli(["login", "--server", "https://control.example.com/v1", "--token-stdin", "--json"], { createClient: () => fakeClient({ listMachines: async () => { checked = true; return []; } }), configStore: store, io: output.io, env: {} });
  assert.equal(code, ExitCode.Success);
  assert.equal(checked, true);
  assert.deepEqual(store.value, { server: "https://control.example.com", token: "top-secret" });
  assert.doesNotMatch(output.stdout.join(""), /top-secret/);
});

test("file configuration has owner-only permissions", async () => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(join(tmpdir(), "rivetplane-cli-"));
  const store = new FileConfigStore(join(directory, "nested", "config.json"));
  await store.save({ server: "https://control.example.com", token: "secret" });
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, "nested"))).mode & 0o777, 0o700);
});

test("sessions list passes filters to the SDK", async () => {
  let received: Record<string, string> | undefined;
  const output = harness();
  const code = await runCli(["--json", "sessions", "list", "--status", "waiting_approval", "--machine", "m1"], {
    createClient: () => fakeClient({ listSessions: async (filter) => { received = filter; return [{ id: "s1" }]; } }),
    configStore: configured(), io: output.io, env: {},
  });
  assert.equal(code, ExitCode.Success);
  assert.deepEqual(received, { machine: "m1", status: "waiting_approval" });
  assert.deepEqual(JSON.parse(output.stdout.join("")), [{ id: "s1" }]);
});

test("transcript --all follows SDK cursors", async () => {
  const cursors: Array<string | undefined> = [];
  const output = harness();
  const client = fakeClient({ getTranscript: async (_id, options) => {
    cursors.push(options?.cursor);
    return options?.cursor ? { events: [{ seq: 2 }], next_cursor: null } : { events: [{ seq: 1 }], next_cursor: "one" };
  } });
  const code = await runCli(["transcript", "get", "s1", "--all", "--json"], { createClient: () => client, configStore: configured(), io: output.io, env: {} });
  assert.equal(code, ExitCode.Success);
  assert.deepEqual(cursors, [undefined, "one"]);
  assert.deepEqual(JSON.parse(output.stdout.join("")), { events: [{ seq: 1 }, { seq: 2 }], next_cursor: null });
});

test("pending response checks the exact current ID before the SDK mutation", async () => {
  let called = false;
  const output = harness();
  const code = await runCli(["pending", "respond", "s1", "--pending-id", "stale", "--response", "approve"], {
    createClient: () => fakeClient({ getPending: async () => ({ pending: { id: "current", type: "approval" } }), respondToPending: async () => { called = true; return {}; } }),
    configStore: configured(), io: output.io, env: {},
  });
  assert.equal(code, ExitCode.Conflict);
  assert.equal(called, false);
});

test("interrupt requires explicit confirmation", async () => {
  const output = harness();
  const code = await runCli(["interrupt", "s1"], { createClient: () => fakeClient(), configStore: configured(), io: output.io, env: {} });
  assert.equal(code, ExitCode.Usage);
});

test("HTTP errors have stable exit codes and JSON error output", async () => {
  const output = harness();
  const code = await runCli(["--json", "sessions", "get", "missing"], {
    createClient: () => fakeClient({ getSession: async () => { throw Object.assign(new Error("not found"), { status: 404 }); } }),
    configStore: configured(), io: output.io, env: {},
  });
  assert.equal(code, ExitCode.NotFound);
  assert.deepEqual(JSON.parse(output.stderr.join("")), { error: { message: "not found", exit_code: 4 } });
});

test("tail writes one JSON object per line", async () => {
  const output = harness();
  const code = await runCli(["transcript", "tail", "s1", "--json"], {
    createClient: () => fakeClient({ subscribeToTranscript: async function* () { yield { seq: 1 }; yield { seq: 2 }; } }),
    configStore: configured(), io: output.io, env: {},
  });
  assert.equal(code, ExitCode.Success);
  assert.deepEqual(output.stdout.map((line) => JSON.parse(line)), [{ seq: 1 }, { seq: 2 }]);
});

test("environment credentials take precedence and are not persisted", async () => {
  const store = configured();
  let options: { baseUrl: string; token: string } | undefined;
  const output = harness();
  const code = await runCli(["machines", "list"], {
    createClient: (input) => { options = input; return fakeClient(); }, configStore: store, io: output.io,
    env: { RIVETPLANE_SERVER: "https://ci.example.com/v1", RIVETPLANE_TOKEN: "ci-token" },
  });
  assert.equal(code, ExitCode.Success);
  assert.deepEqual(options, { baseUrl: "https://ci.example.com", token: "ci-token" });
  assert.equal(store.value?.token, "secret");
});
