#!/usr/bin/env node
import { hostname } from "node:os";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { HarnessControlClient } from "./client.js";
import { login, readCredentials, resolveServerUrl, writeCredentials } from "./credentials.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const HELP = `Rivetplane local client

Usage:
  rivetplane [--local-port PORT] [--discovery-dir PATH] [--opencode-directory PATH] [--opencode-executable PATH] [--opencode-checkpoint PATH] [--opencode-index-interval SECONDS] [--opencode-max-sessions-per-project COUNT] [--no-opencode] [--no-opencode-export] [--no-relay]
  rivetplane --opencode-url URL [client options]
  rivetplane opencode [client options] [-- OPENCODE_ATTACH_OPTIONS]
  rivetplane login [--server URL] [--machine-name NAME] [--machine ID --token TOKEN]
  rivetplane --help

The client scans ~/.acp/sessions/*.json, attaches to ACP sessions, and reads existing
OpenCode sessions with 'opencode session list' and 'opencode export'. Export discovery
is read-only. It can show pending questions, but it cannot answer them in the original
process. The machine index refreshes every 60 seconds by default. The 2-second
transcript poll uses the cached index. The client does not start OpenCode by default. Use 'rivetplane opencode' for
the managed server and attached TUI mode. Login uses https://rivetplane.com unless
--server or HARNESS_CP_SERVER selects a self-hosted control plane.`;

function flag(name: string): string | undefined { const offset = process.argv.indexOf(name); return offset >= 0 ? process.argv[offset + 1] : undefined; }

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) { process.stdout.write(`${HELP}\n`); return; }
  if (process.argv.includes("--version") || process.argv.includes("-v")) { process.stdout.write(`${version}\n`); return; }
  if (process.argv[2] === "login") {
    const server_url = resolveServerUrl(flag("--server"), process.env.HARNESS_CP_SERVER);
    const machineName = flag("--machine-name");
    const token = flag("--token") ?? process.env.HCP_MACHINE_TOKEN;
    if (token) {
      const credentials = { server_url: server_url.replace(/\/$/, ""), machine_id: flag("--machine") ?? `local-${hostname()}`, machine_name: machineName ?? hostname(), device_id: flag("--machine") ?? `local-${hostname()}`, owner_account_id: "self-hosted", token };
      await writeCredentials(credentials); process.stdout.write(`Paired machine ${credentials.machine_name} (${credentials.machine_id}).\n`); return;
    }
    process.stdout.write(`Starting device pairing for ${machineName ?? hostname()}...\n`);
    const credentials = await login({ server_url, ...(machineName ? { machine_name: machineName } : {}) });
    process.stdout.write(`Paired machine ${credentials.machine_name} (${credentials.machine_id}).\n`); return;
  }

  const explicitOpenCode = process.argv[2] === "opencode";
  const attachOpenCode = explicitOpenCode;
  const credentials = await readCredentials();
  const discoveryDirectory = flag("--discovery-dir");
  const localPort = Number(flag("--local-port") ?? process.env.HARNESS_CP_LOCAL_PORT ?? 41737);
  if (!Number.isInteger(localPort) || localPort < 0 || localPort > 65_535) throw new Error("--local-port must be a valid port");
  const maxOpenCodeSessions = Number(flag("--opencode-max-sessions-per-project") ?? process.env.HARNESS_CP_OPENCODE_MAX_SESSIONS_PER_PROJECT ?? 200);
  if (!Number.isSafeInteger(maxOpenCodeSessions) || maxOpenCodeSessions <= 0) throw new Error("--opencode-max-sessions-per-project must be a positive integer");
  const openCodeIndexIntervalSeconds = Number(flag("--opencode-index-interval") ?? process.env.HARNESS_CP_OPENCODE_INDEX_INTERVAL_SECONDS ?? 60);
  if (!Number.isSafeInteger(openCodeIndexIntervalSeconds) || openCodeIndexIntervalSeconds <= 0) throw new Error("--opencode-index-interval must be a positive integer number of seconds");
  const client = new HarnessControlClient({
    ...(credentials ? { credentials } : {}),
    ...(discoveryDirectory ? { discovery_directory: discoveryDirectory } : {}),
    local_port: localPort,
    relay: !process.argv.includes("--no-relay"),
    opencode_url: process.argv.includes("--no-opencode") ? false : (flag("--opencode-url") ?? process.env.HARNESS_CP_OPENCODE_URL),
    opencode_managed: explicitOpenCode,
    opencode_export: !process.argv.includes("--no-opencode-export") && !process.argv.includes("--no-opencode") && !explicitOpenCode && !flag("--opencode-url") && !process.env.HARNESS_CP_OPENCODE_URL,
    opencode_directory: flag("--opencode-directory") ?? process.env.HARNESS_CP_OPENCODE_DIRECTORY ?? process.cwd(),
    opencode_executable: flag("--opencode-executable") ?? process.env.HARNESS_CP_OPENCODE_EXECUTABLE,
    opencode_checkpoint_path: flag("--opencode-checkpoint") ?? process.env.HARNESS_CP_OPENCODE_CHECKPOINT,
    opencode_max_sessions_per_project: maxOpenCodeSessions,
    opencode_index_interval_ms: openCodeIndexIntervalSeconds * 1_000,
  });
  client.manager.registry.on("log", (message) => process.stderr.write(`${String(message)}\n`));
  const started = await client.start();
  process.stdout.write(`Local API: http://127.0.0.1:${started.local_port}/v1\n`);
  process.stdout.write(credentials && !process.argv.includes("--no-relay") ? `Relay: ${credentials.server_url}\n` : "Relay: disabled (run rivetplane login to pair this machine)\n");
  const harnesses = client.harnesses();
  if (harnesses.length === 0) process.stdout.write(`Harnesses: none found (ACP: ${client.manager.discovery.directory}; OpenCode export: ${client.opencode_exports?.executable ?? "not found"}; managed OpenCode: ${client.opencode ? client.opencode.url : "disabled"})\n`);
  else for (const harness of harnesses) process.stdout.write(`Harness: ${harness.harness_type} (${harness.attached_sessions}/${harness.discovered_sessions} sessions attached)\n`);
  let stopping = false;
  let attachedProcess: ChildProcess | undefined;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    attachedProcess?.kill("SIGTERM");
    void client.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  if (attachOpenCode) {
    if (!client.opencode || client.opencode.url === "automatic") {
      if (explicitOpenCode) throw new Error("OpenCode is not available for an attached TUI");
    } else {
      const separator = process.argv.indexOf("--");
      const attachOptions = separator >= 0 ? process.argv.slice(separator + 1) : [];
      attachedProcess = spawn("opencode", ["attach", client.opencode.url, ...attachOptions], {
        cwd: client.opencode.directory,
        stdio: "inherit",
      });
      const exitCode = await new Promise<number>((resolve, reject) => {
        attachedProcess?.once("error", reject);
        attachedProcess?.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
      });
      await client.stop();
      process.exitCode = exitCode;
    }
  }
}

void main().catch((error) => { process.stderr.write(`rivetplane: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
