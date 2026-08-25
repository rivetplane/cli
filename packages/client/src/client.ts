import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { Credentials } from "./credentials.js";
import { LocalApi } from "./local-api.js";
import { OutboundRelay } from "./relay.js";
import { SessionManager } from "./session-manager.js";
import { OpenCodeManager } from "./opencode-manager.js";
import { OpenCodeExportDiscovery } from "./opencode-export-discovery.js";
import { CodexRolloutDiscovery } from "./codex-rollout-discovery.js";
import { CodexAppServerManager } from "./codex-app-server.js";
import { ClaudeCodeDiscovery } from "./claude-code-discovery.js";

export interface ClientOptions {
  credentials?: Credentials;
  discovery_directory?: string;
  discovery_interval_ms?: number;
  local_port?: number;
  relay?: boolean;
  opencode_url?: string | false;
  opencode_managed?: boolean;
  opencode_export?: boolean;
  opencode_directory?: string;
  opencode_executable?: string;
  opencode_checkpoint_path?: string;
  opencode_max_sessions_per_project?: number;
  opencode_index_interval_ms?: number;
  opencode_export_timeout_ms?: number;
  opencode_export_concurrency?: number;
  codex?: boolean;
  codex_managed?: boolean;
  codex_endpoint?: string;
  codex_token?: string;
  codex_directory?: string;
  codex_executable?: string;
  codex_sessions_directory?: string;
  codex_checkpoint_path?: string;
  claude_code?: boolean;
  claude_executable?: string;
  claude_config_dir?: string;
  claude_checkpoint_path?: string;
}

export class HarnessControlClient {
  readonly manager: SessionManager;
  readonly local_api: LocalApi;
  readonly relay?: OutboundRelay;
  readonly opencode?: OpenCodeManager;
  readonly opencode_exports?: OpenCodeExportDiscovery;
  readonly codex_rollouts?: CodexRolloutDiscovery;
  readonly codex_app_server?: CodexAppServerManager;
  readonly claude_code?: ClaudeCodeDiscovery;

  constructor(private readonly options: ClientOptions = {}) {
    const machineId = options.credentials?.machine_id ?? `local-${randomUUID()}`;
    this.manager = new SessionManager(machineId, { ...(options.discovery_directory ? { directory: options.discovery_directory } : {}), ...(options.discovery_interval_ms ? { interval_ms: options.discovery_interval_ms } : {}) });
    if (typeof options.opencode_url === "string" || options.opencode_managed) this.opencode = new OpenCodeManager(machineId, this.manager.registry, { ...(typeof options.opencode_url === "string" ? { url: options.opencode_url } : {}), ...(options.opencode_directory ? { directory: options.opencode_directory } : {}), ...(options.discovery_interval_ms ? { interval_ms: options.discovery_interval_ms } : {}) });
    const exportEnabled = options.opencode_export ?? (!options.opencode_managed && typeof options.opencode_url !== "string");
    if (options.opencode_url !== false && exportEnabled) this.opencode_exports = new OpenCodeExportDiscovery(machineId, this.manager.registry, {
      ...(options.opencode_directory ? { directory: options.opencode_directory } : {}), ...(options.opencode_executable ? { executable: options.opencode_executable } : {}),
      ...(options.opencode_checkpoint_path ? { checkpoint_path: options.opencode_checkpoint_path } : {}), ...(options.discovery_interval_ms ? { interval_ms: options.discovery_interval_ms } : {}),
      ...(options.opencode_max_sessions_per_project ? { max_sessions_per_project: options.opencode_max_sessions_per_project } : {}),
      ...(options.opencode_index_interval_ms ? { index_interval_ms: options.opencode_index_interval_ms } : {}),
      ...(options.opencode_export_timeout_ms ? { export_timeout_ms: options.opencode_export_timeout_ms } : {}),
      ...(options.opencode_export_concurrency ? { export_concurrency: options.opencode_export_concurrency } : {}),
    });
    if (options.codex !== false) this.codex_rollouts = new CodexRolloutDiscovery(machineId, this.manager.registry, {
      ...(options.codex_sessions_directory ? { sessions_directory: options.codex_sessions_directory } : {}), ...(options.codex_checkpoint_path ? { checkpoint_path: options.codex_checkpoint_path } : {}),
      ...(options.discovery_interval_ms ? { interval_ms: options.discovery_interval_ms } : {}),
    });
    if (options.codex_managed || options.codex_endpoint) this.codex_app_server = new CodexAppServerManager(machineId, this.manager.registry, {
      managed: options.codex_managed ?? false, ...(options.codex_endpoint ? { endpoint: options.codex_endpoint } : {}), ...(options.codex_token ? { token: options.codex_token } : {}),
      ...(options.codex_directory ? { directory: options.codex_directory } : {}), ...(options.codex_executable ? { executable: options.codex_executable } : {}), ...(options.discovery_interval_ms ? { interval_ms: options.discovery_interval_ms } : {}),
    });
    if (options.claude_code !== false) this.claude_code = new ClaudeCodeDiscovery(machineId, this.manager.registry, {
      ...(options.claude_executable ? { executable: options.claude_executable } : {}), ...(options.claude_config_dir ? { config_dir: options.claude_config_dir } : {}),
      ...(options.claude_checkpoint_path ? { checkpoint_path: options.claude_checkpoint_path } : {}), ...(options.discovery_interval_ms ? { interval_ms: options.discovery_interval_ms } : {}),
    });
    const target = (id: string) => this.manager.target(id) ?? this.opencode?.target(id) ?? this.codex_app_server?.target(id) ?? this.opencode_exports?.target(id) ?? this.codex_rollouts?.target(id) ?? this.claude_code?.target(id);
    this.local_api = new LocalApi(this.manager.registry, { port: options.local_port ?? 41737, target,
      harnesses: () => this.harnesses(), discovery_directory: this.manager.discovery.directory });
    if (options.credentials && options.relay !== false) this.relay = new OutboundRelay(options.credentials, this.manager.registry, target, {
      createSession: async (command) => {
        if (command.harness_type === "opencode" && this.opencode) return this.opencode.createSession(command);
        if (command.harness_type === "codex" && this.codex_app_server) return this.codex_app_server.createSession(command);
        throw new Error("Harness cannot create sessions");
      },
      capabilities: () => [this.opencode?.capabilities(), this.codex_app_server?.capabilities(), this.claude_code?.capabilities()].filter((value): value is NonNullable<typeof value> => Boolean(value)),
    });
    this.manager.registry.on("warning", (error) => this.manager.registry.emit("log", `Warning: ${error instanceof Error ? error.message : String(error)}`));
  }

  async start(): Promise<{ local_port: number }> { const local_port = await this.local_api.start(); await Promise.all([this.manager.start(), this.opencode?.start(), this.opencode_exports?.start(), this.claude_code?.start(), this.codex_rollouts?.start(), this.codex_app_server?.start()]); this.relay?.start(); return { local_port }; }
  async stop(): Promise<void> { this.relay?.stop(); this.opencode?.stop(); this.opencode_exports?.stop(); this.claude_code?.stop(); this.codex_rollouts?.stop(); await this.codex_app_server?.stop(); this.manager.stop(); await this.local_api.stop(); }
  harnesses() {
    const result = new Map<string, ReturnType<SessionManager["harnesses"]>[number]>();
    for (const item of [...this.manager.harnesses(), ...(this.opencode?.harnesses() ?? []), ...(this.opencode_exports?.harnesses() ?? []), ...(this.claude_code?.harnesses() ?? []), ...(this.codex_rollouts?.harnesses() ?? []), ...(this.codex_app_server?.harnesses() ?? [])]) {
      const prior = result.get(item.harness_type); result.set(item.harness_type, prior ? { ...prior, ...item, discovered_sessions: prior.discovered_sessions + item.discovered_sessions, attached_sessions: prior.attached_sessions + item.attached_sessions } : item);
    }
    return [...result.values()];
  }
}

export function localCredentials(server_url: string): Credentials {
  const machine_id = `local-${randomUUID()}`;
  return { server_url, machine_id, machine_name: hostname(), device_id: machine_id, owner_account_id: "local", token: "" };
}
