import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { Credentials } from "./credentials.js";
import { LocalApi } from "./local-api.js";
import { OutboundRelay } from "./relay.js";
import { SessionManager } from "./session-manager.js";
import { OpenCodeManager } from "./opencode-manager.js";

export interface ClientOptions {
  credentials?: Credentials;
  discovery_directory?: string;
  discovery_interval_ms?: number;
  local_port?: number;
  relay?: boolean;
  opencode_url?: string | false;
  opencode_directory?: string;
}

export class HarnessControlClient {
  readonly manager: SessionManager;
  readonly local_api: LocalApi;
  readonly relay?: OutboundRelay;
  readonly opencode?: OpenCodeManager;

  constructor(private readonly options: ClientOptions = {}) {
    const machineId = options.credentials?.machine_id ?? `local-${randomUUID()}`;
    this.manager = new SessionManager(machineId, { ...(options.discovery_directory ? { directory: options.discovery_directory } : {}), ...(options.discovery_interval_ms ? { interval_ms: options.discovery_interval_ms } : {}) });
    if (options.opencode_url !== false) this.opencode = new OpenCodeManager(machineId, this.manager.registry, { ...(typeof options.opencode_url === "string" ? { url: options.opencode_url } : {}), ...(options.opencode_directory ? { directory: options.opencode_directory } : {}), ...(options.discovery_interval_ms ? { interval_ms: options.discovery_interval_ms } : {}) });
    const target = (id: string) => this.manager.target(id) ?? this.opencode?.target(id);
    this.local_api = new LocalApi(this.manager.registry, { port: options.local_port ?? 41737, target,
      harnesses: () => this.harnesses(), discovery_directory: this.manager.discovery.directory });
    if (options.credentials && options.relay !== false) this.relay = new OutboundRelay(options.credentials, this.manager.registry, target, {
      createSession: async (command) => { if (command.harness_type !== "opencode" || !this.opencode) throw new Error("Harness cannot create sessions"); return this.opencode.createSession(command); },
      capabilities: () => { const value = this.opencode?.capabilities(); return value ? [value] : []; },
    });
    this.manager.registry.on("warning", (error) => this.manager.registry.emit("log", `Warning: ${error instanceof Error ? error.message : String(error)}`));
  }

  async start(): Promise<{ local_port: number }> { const local_port = await this.local_api.start(); await Promise.all([this.manager.start(), this.opencode?.start()]); this.relay?.start(); return { local_port }; }
  async stop(): Promise<void> { this.relay?.stop(); this.opencode?.stop(); this.manager.stop(); await this.local_api.stop(); }
  harnesses() { return [...this.manager.harnesses(), ...(this.opencode?.harnesses() ?? [])]; }
}

export function localCredentials(server_url: string): Credentials {
  const machine_id = `local-${randomUUID()}`;
  return { server_url, machine_id, machine_name: hostname(), device_id: machine_id, owner_account_id: "local", token: "" };
}
