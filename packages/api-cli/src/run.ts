import { readFile } from "node:fs/promises";
import { stdin as processStdin, stderr as processStderr, stdout as processStdout } from "node:process";
import { type ApiClient, type ApiClientFactory, statusFromError } from "./api.js";
import { type ConfigStore, FileConfigStore, normalizeServer, type StoredConfig } from "./config.js";
import { commandHelp, EXAMPLES, HELP, VERSION } from "./help.js";

export enum ExitCode {
  Success = 0,
  Usage = 2,
  Auth = 3,
  NotFound = 4,
  Conflict = 5,
  Api = 6,
  Interrupted = 7,
  Config = 8,
  Unexpected = 10,
}

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  readStdin(): Promise<string>;
  readSecret(prompt: string): Promise<string>;
  isTty: boolean;
}

export interface CliDependencies {
  createClient: ApiClientFactory;
  configStore?: ConfigStore;
  env?: NodeJS.ProcessEnv;
  io?: CliIo;
}

class CliError extends Error {
  constructor(message: string, readonly exitCode: ExitCode) { super(message); }
}

interface Parsed {
  positionals: string[];
  options: Map<string, string | true>;
}

const optionAliases: Record<string, string> = { "-h": "--help", "-V": "--version" };
const valueOptions = new Set(["--server", "--token", "--machine", "--harness", "--status", "--cwd", "--since", "--limit", "--cursor", "--text", "--text-file", "--pending-id", "--response", "--scope"]);
const booleanOptions = new Set(["--json", "--no-input", "--token-stdin", "--help", "--version", "--all", "--yes"]);

function parse(argv: string[]): Parsed {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]!;
    const token = optionAliases[raw] ?? raw;
    if (token === "--") { positionals.push(...argv.slice(index + 1)); break; }
    if (!token.startsWith("-")) { positionals.push(token); continue; }
    const equal = token.indexOf("=");
    const name = equal > 0 ? token.slice(0, equal) : token;
    if (booleanOptions.has(name)) {
      if (equal > 0) throw new CliError(`${name} does not take a value`, ExitCode.Usage);
      options.set(name, true);
      continue;
    }
    if (!valueOptions.has(name)) throw new CliError(`Unknown option: ${name}`, ExitCode.Usage);
    const value = equal > 0 ? token.slice(equal + 1) : argv[++index];
    if (!value || value.startsWith("--")) throw new CliError(`${name} requires a value`, ExitCode.Usage);
    options.set(name, value);
  }
  return { positionals, options };
}

function defaultIo(): CliIo {
  const readStdin = async (): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of processStdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  };
  return {
    stdout: (text) => processStdout.write(text),
    stderr: (text) => processStderr.write(text),
    readStdin,
    isTty: Boolean(processStdin.isTTY && processStdout.isTTY),
    readSecret: async (prompt) => {
      if (!processStdin.isTTY || !processStdout.isTTY || !processStdin.setRawMode) return readStdin();
      processStdout.write(prompt);
      processStdin.setRawMode(true);
      processStdin.resume();
      return new Promise<string>((resolve, reject) => {
        let value = "";
        const finish = (): void => {
          processStdin.setRawMode(false);
          processStdin.pause();
          processStdin.off("data", onData);
          processStdout.write("\n");
          resolve(value);
        };
        const onData = (data: Buffer): void => {
          for (const byte of data) {
            if (byte === 3) { processStdin.setRawMode(false); reject(new CliError("Cancelled", ExitCode.Interrupted)); return; }
            if (byte === 10 || byte === 13) { finish(); return; }
            if (byte === 127 || byte === 8) value = value.slice(0, -1);
            else value += String.fromCharCode(byte);
          }
        };
        processStdin.on("data", onData);
      });
    },
  };
}

function value(parsed: Parsed, name: string): string | undefined {
  const result = parsed.options.get(name);
  return typeof result === "string" ? result : undefined;
}

function required(valueToCheck: string | undefined, message: string): string {
  if (!valueToCheck) throw new CliError(message, ExitCode.Usage);
  return valueToCheck;
}

const globalOptions = new Set(["--server", "--token", "--token-stdin", "--json", "--no-input", "--help", "--version"]);
const commandOptions: Record<string, string[]> = {
  login: [], logout: [], "config show": [], "machines list": [],
  "sessions list": ["--machine", "--harness", "--status", "--cwd"], "sessions get": [],
  "transcript get": ["--since", "--limit", "--cursor", "--all"], "transcript tail": ["--since"],
  "message send": ["--text", "--text-file"], "pending get": [],
  "pending respond": ["--pending-id", "--response", "--scope"], interrupt: ["--yes"], completion: [], examples: [],
};
const positionalCounts: Record<string, number> = {
  login: 1, logout: 1, "config show": 2, "machines list": 2,
  "sessions list": 2, "sessions get": 3, "transcript get": 3, "transcript tail": 3,
  "message send": 3, "pending get": 3, "pending respond": 3, interrupt: 2, completion: 2, examples: 1,
};

function validateCommand(parsed: Parsed, command: string, subcommand?: string): void {
  const composite = commandOptions[`${command} ${subcommand ?? ""}`.trim()] ? `${command} ${subcommand}` : command;
  const allowed = commandOptions[composite];
  if (!allowed) return;
  for (const option of parsed.options.keys()) if (!globalOptions.has(option) && !allowed.includes(option)) throw new CliError(`${option} is not valid for ${composite}`, ExitCode.Usage);
  if (parsed.positionals.length !== positionalCounts[composite]) throw new CliError(`Invalid arguments for ${composite}`, ExitCode.Usage);
}

async function loadConfig(store: ConfigStore): Promise<StoredConfig | undefined> {
  try { return await store.load(); }
  catch (error) { throw new CliError(error instanceof Error ? error.message : String(error), ExitCode.Config); }
}

function emit(io: CliIo, data: unknown, json: boolean): void {
  io.stdout(`${JSON.stringify(data, null, json ? undefined : 2)}\n`);
}

function completion(shell: string): string {
  const commands = "login logout config machines sessions transcript transcripts message pending interrupt completion examples";
  if (shell === "bash") return `complete -W '${commands}' rivetplane-api`;
  if (shell === "zsh") return `#compdef rivetplane-api\n_rivetplane_api() { _arguments '1:command:(${commands})' }\ncompdef _rivetplane_api rivetplane-api`;
  if (shell === "fish") return commands.split(" ").map((item) => `complete -c rivetplane-api -f -a '${item}'`).join("\n");
  throw new CliError("Shell must be bash, zsh, or fish", ExitCode.Usage);
}

function pendingFrom(valueToCheck: unknown): Record<string, unknown> | null {
  if (!valueToCheck || typeof valueToCheck !== "object") return null;
  const record = valueToCheck as Record<string, unknown>;
  const nested = record.pending;
  if (nested === null) return null;
  if (nested && typeof nested === "object") return nested as Record<string, unknown>;
  return record;
}

function transcriptPage(valueToCheck: unknown): { events: unknown[]; nextCursor?: string } {
  if (!valueToCheck || typeof valueToCheck !== "object") return { events: [] };
  const record = valueToCheck as Record<string, unknown>;
  return {
    events: Array.isArray(record.events) ? record.events : [],
    ...(typeof record.next_cursor === "string" ? { nextCursor: record.next_cursor } : {}),
  };
}

async function credentials(parsed: Parsed, store: ConfigStore, env: NodeJS.ProcessEnv, io: CliIo): Promise<{ server: string; token: string }> {
  const saved = await loadConfig(store);
  const server = value(parsed, "--server") ?? env.RIVETPLANE_SERVER ?? saved?.server;
  let token = value(parsed, "--token") ?? env.RIVETPLANE_TOKEN ?? saved?.token;
  if (parsed.options.has("--token-stdin")) token = (await io.readStdin()).trim();
  if (!server) throw new CliError("No server is configured. Run login or set RIVETPLANE_SERVER.", ExitCode.Config);
  if (!token) throw new CliError("No API token is configured. Run login or set RIVETPLANE_TOKEN.", ExitCode.Auth);
  try { return { server: normalizeServer(server), token }; }
  catch (error) { throw new CliError(error instanceof Error ? error.message : String(error), ExitCode.Config); }
}

async function execute(parsed: Parsed, dependencies: Required<Pick<CliDependencies, "createClient">> & { configStore: ConfigStore; env: NodeJS.ProcessEnv; io: CliIo }): Promise<void> {
  const { positionals, options } = parsed;
  const [originalCommand, subcommand] = positionals;
  const command = originalCommand === "transcripts" ? "transcript" : originalCommand;
  const json = options.has("--json");
  if (options.has("--version")) { dependencies.io.stdout(`${VERSION}\n`); return; }
  if (!command || (options.has("--help") && !subcommand)) { dependencies.io.stdout(command ? `${commandHelp(command) ?? HELP}\n` : `${HELP}\n`); return; }
  if (options.has("--help")) { dependencies.io.stdout(`${commandHelp(command, subcommand) ?? HELP}\n`); return; }
  validateCommand(parsed, command, subcommand);

  if (command === "examples") { dependencies.io.stdout(`${EXAMPLES}\n`); return; }
  if (command === "completion") { dependencies.io.stdout(`${completion(required(subcommand, "completion requires a shell"))}\n`); return; }
  if (command === "logout") { emit(dependencies.io, { removed: await dependencies.configStore.remove() }, json); return; }
  if (command === "config" && subcommand === "show") {
    const saved = await loadConfig(dependencies.configStore);
    emit(dependencies.io, { path: dependencies.configStore.path, server: dependencies.env.RIVETPLANE_SERVER ?? saved?.server ?? null, token_source: dependencies.env.RIVETPLANE_TOKEN ? "environment" : saved?.token ? "file" : "none" }, json);
    return;
  }
  if (command === "login") {
    const saved = await loadConfig(dependencies.configStore);
    let server: string;
    try { server = normalizeServer(required(value(parsed, "--server") ?? dependencies.env.RIVETPLANE_SERVER ?? saved?.server, "login requires --server or RIVETPLANE_SERVER")); }
    catch (error) { if (error instanceof CliError) throw error; throw new CliError(error instanceof Error ? error.message : String(error), ExitCode.Config); }
    let token = value(parsed, "--token") ?? dependencies.env.RIVETPLANE_TOKEN;
    if (options.has("--token-stdin")) token = (await dependencies.io.readStdin()).trim();
    if (!token && !options.has("--no-input")) token = (await dependencies.io.readSecret("API token: ")).trim();
    if (!token) throw new CliError("login requires a token source", ExitCode.Auth);
    await dependencies.createClient({ baseUrl: server, token }).listMachines();
    await dependencies.configStore.save({ server, token });
    emit(dependencies.io, { configured: true, server, path: dependencies.configStore.path }, json);
    return;
  }

  const auth = await credentials(parsed, dependencies.configStore, dependencies.env, dependencies.io);
  const client = dependencies.createClient({ baseUrl: auth.server, token: auth.token });
  if (command === "machines" && subcommand === "list") return emit(dependencies.io, await client.listMachines(), json);
  if (command === "sessions" && subcommand === "list") {
    const filter = Object.fromEntries(["machine", "harness", "status", "cwd"].flatMap((key) => {
      const option = value(parsed, `--${key}`);
      return option ? [[key, option]] : [];
    }));
    return emit(dependencies.io, await client.listSessions(filter), json);
  }
  const sessionId = positionals[2] ?? (command === "interrupt" ? subcommand : undefined);
  if (command === "sessions" && subcommand === "get") return emit(dependencies.io, await client.getSession(required(sessionId, "sessions get requires a session ID")), json);
  if (command === "transcript" && subcommand === "get") {
    const id = required(sessionId, "transcript get requires a session ID");
    const limitText = value(parsed, "--limit");
    const limit = limitText ? Number(limitText) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) throw new CliError("--limit must be an integer from 1 through 1000", ExitCode.Usage);
    const common = { ...(value(parsed, "--since") ? { since: value(parsed, "--since")! } : {}), ...(limit ? { limit } : {}) };
    if (!options.has("--all")) return emit(dependencies.io, await client.getTranscript(id, { ...common, ...(value(parsed, "--cursor") ? { cursor: value(parsed, "--cursor")! } : {}) }), json);
    const events: unknown[] = [];
    let cursor = value(parsed, "--cursor");
    do {
      const page = transcriptPage(await client.getTranscript(id, { ...common, ...(cursor ? { cursor } : {}) }));
      events.push(...page.events);
      cursor = page.nextCursor;
    } while (cursor);
    return emit(dependencies.io, { events, next_cursor: null }, json);
  }
  if (command === "transcript" && subcommand === "tail") {
    const abort = new AbortController();
    const onSignal = (): void => abort.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      for await (const event of client.subscribeToTranscript(required(sessionId, "transcript tail requires a session ID"), { signal: abort.signal })) emit(dependencies.io, event, true);
      if (abort.signal.aborted) throw new CliError("Interrupted", ExitCode.Interrupted);
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
    return;
  }
  if (command === "message" && subcommand === "send") {
    const textValue = value(parsed, "--text");
    const file = value(parsed, "--text-file");
    if (Boolean(textValue) === Boolean(file)) throw new CliError("Use exactly one of --text or --text-file", ExitCode.Usage);
    if (file === "-" && options.has("--token-stdin")) throw new CliError("Standard input cannot contain both a token and message text", ExitCode.Usage);
    const text = textValue ?? (file === "-" ? await dependencies.io.readStdin() : await readFile(file!, "utf8"));
    if (!text) throw new CliError("Message text is empty", ExitCode.Usage);
    return emit(dependencies.io, await client.sendMessage(required(sessionId, "message send requires a session ID"), text), json);
  }
  if (command === "pending" && subcommand === "get") return emit(dependencies.io, await client.getPending(required(sessionId, "pending get requires a session ID")), json);
  if (command === "pending" && subcommand === "respond") {
    const id = required(sessionId, "pending respond requires a session ID");
    const current = pendingFrom(await client.getPending(id));
    if (!current) throw new CliError("Session has no pending interaction", ExitCode.Conflict);
    const actualId = typeof current.id === "string" ? current.id : undefined;
    const expectedId = required(value(parsed, "--pending-id"), "pending respond requires --pending-id");
    if (actualId !== expectedId) throw new CliError("--pending-id does not match the current interaction", ExitCode.Conflict);
    const scope = value(parsed, "--scope");
    if (scope && !["once", "always_this_tool", "always_session"].includes(scope)) throw new CliError("Invalid --scope", ExitCode.Usage);
    return emit(dependencies.io, await client.respondToPending(id, expectedId, required(value(parsed, "--response"), "pending respond requires --response"), scope), json);
  }
  if (command === "interrupt") {
    if (!options.has("--yes")) throw new CliError("interrupt requires --yes", ExitCode.Usage);
    return emit(dependencies.io, await client.interruptSession(required(sessionId, "interrupt requires a session ID")), json);
  }
  throw new CliError(`Unknown command: ${positionals.slice(0, 2).join(" ")}`, ExitCode.Usage);
}

function mappedError(error: unknown): { code: ExitCode; message: string } {
  if (error instanceof CliError) return { code: error.exitCode, message: error.message };
  const status = statusFromError(error);
  const message = error instanceof Error ? error.message : String(error);
  if (status === 401 || status === 403) return { code: ExitCode.Auth, message };
  if (status === 404) return { code: ExitCode.NotFound, message };
  if (status === 409) return { code: ExitCode.Conflict, message };
  if (status !== undefined || error instanceof TypeError || (error instanceof Error && error.name.startsWith("Rivetplane"))) return { code: ExitCode.Api, message };
  return { code: ExitCode.Unexpected, message };
}

export async function runCli(argv: string[], dependencies: CliDependencies): Promise<number> {
  const io = dependencies.io ?? defaultIo();
  let parsed: Parsed | undefined;
  try {
    parsed = parse(argv);
    await execute(parsed, { createClient: dependencies.createClient, configStore: dependencies.configStore ?? new FileConfigStore(), env: dependencies.env ?? process.env, io });
    return ExitCode.Success;
  } catch (error) {
    const mapped = mappedError(error);
    if (parsed?.options.has("--json") || argv.includes("--json")) io.stderr(`${JSON.stringify({ error: { message: mapped.message, exit_code: mapped.code } })}\n`);
    else io.stderr(`Error: ${mapped.message}\n`);
    return mapped.code;
  }
}
