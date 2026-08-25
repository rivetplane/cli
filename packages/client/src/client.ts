import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { Credentials } from "./credentials.js";
import { LocalApi } from "./local-api.js";
import { OutboundRelay } from "./relay.js";
import { SessionManager } from "./session-manager.js";
import { OpenCodeManager } from "./opencode-manager.js";
import { OpenCodeExportDiscovery } from "./opencode-export-discovery.js";

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
}

export class HarnessControlClient {
  readonly manager: SessionManager;
  readonly local_api: LocalApi;
  readonly relay?: OutboundRelay;
  readonly opencode?: OpenCodeManager;
  readonly opencode_exports?: OpenCodeExportDiscovery;

  constructor(private readonly options: ClientOptions = {}) {
    const machineId = options.credentials?.machine_id ?? `local-${randomUUID()}`;
    this.manager = new SessionManager(machineId, { ...(options.discovery_directory ? { directory: options.discovery_directory } : {}), ...(options.discovery_interval_ms ? { interval_ms: options.discovery_interval_ms } : {}) });
    if (typeof options.opencode_url === "string" || options.opencode_managed) this.opencode = new OpenCodeManager(machineId, this.manager.registry, { ...(typeof options.opencode_url === "string" ? { url: options.opencode_url } : {}), ...(options.opencode_directory ? { directory: options.opencode_directory } : {}), ...(options.discovery_interval_ms ? { interval_ms: options.discovery_interval_ms } : {}) });
    const exportEnabled = options.opencode_export ?? (!options.opencode_managed && typeof options.opencode_url !== "string");
    if (options.opencode_url !== false && exportEnabled) this.opencode_exports = new OpenCodeExportDiscovery(machineId, this.manager.registry, {
      ...(options.opencode_directory ? { directory: options.opencode_directory } : {}), ...(options.opencode_executable ? { executable: options.opencode_executable } : {}),
      ...(options.opencode_checkpoint_path ? { checkpoint_path: options.opencode_checkpoint_path } : {}), ...(options.discovery_interval_ms ? { interval_ms: options.discovery_interval_ms } : {}),
    });
    const target = (id: string) => this.manager.target(id) ?? this.opencode?.target(id) ?? this.opencode_exports?.target(id);
    this.local_api = new LocalApi(this.manager.registry, { port: options.local_port ?? 41737, target,
      harnesses: () => this.harnesses(), discovery_directory: this.manager.discovery.directory });
    if (options.credentials && options.relay !== false) this.relay = new OutboundRelay(options.credentials, this.manager.registry, target, {
      createSession: async (command) => { if (command.harness_type !== "opencode" || !this.opencode) throw new Error("Harness cannot create sessions"); return this.opencode.createSession(command); },
      capabilities: () => { const value = this.opencode?.capabilities(); return value ? [value] : []; },
    });
    this.manager.registry.on("warning", (error) => this.manager.registry.emit("log", `Warning: ${error instanceof Error ? error.message : String(error)}`));
  }

  async start(): Promise<{ local_port: number }> { const local_port = await this.local_api.start(); await Promise.all([this.manager.start(), this.opencode?.start(), this.opencode_exports?.start()]); this.relay?.start(); return { local_port }; }
  async stop(): Promise<void> { this.relay?.stop(); this.opencode?.stop(); this.opencode_exports?.stop(); this.manager.stop(); await this.local_api.stop(); }
  harnesses() {
    const result = new Map<string, { harness_type: string; discovered_sessions: number; attached_sessions: number }>();
    for (const item of [...this.manager.harnesses(), ...(this.opencode?.harnesses() ?? []), ...(this.opencode_exports?.harnesses() ?? [])]) {
      const prior = result.get(item.harness_type); result.set(item.harness_type, prior ? { ...prior, discovered_sessions: prior.discovered_sessions + item.discovered_sessions, attached_sessions: prior.attached_sessions + item.attached_sessions } : item);
    }
    return [...result.values()];
  }
}

export function localCredentials(server_url: string): Credentials {
  const machine_id = `local-${randomUUID()}`;
  return { server_url, machine_id, machine_name: hostname(), device_id: machine_id, owner_account_id: "local", token: "" };
}
