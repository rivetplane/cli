import type { AcpSessionDescriptor } from "./discovery.js";
import { SessionDiscovery } from "./discovery.js";
import { ACPAttach } from "./acp-attach.js";
import { SessionRegistry } from "./registry.js";
import type { CapabilitySupport } from "@rivetplane/shared/protocol";

interface Managed { signature: string; attach: ACPAttach }
export interface HarnessDiscoveryStatus {
  harness_type: string;
  discovered_sessions: number;
  attached_sessions: number;
  /** Internal identities used to merge overlapping discovery transports. */
  discovered_session_ids?: readonly string[];
  /** Internal identities used to merge overlapping live transports. */
  attached_session_ids?: readonly string[];
  version?: string;
  capabilities?: {
    persisted_discovery?: CapabilitySupport;
    discovery: CapabilitySupport;
    transcript: CapabilitySupport;
    live_attachment?: CapabilitySupport;
    messaging: CapabilitySupport;
    interrupt?: CapabilitySupport;
    question_response: CapabilitySupport;
    approval_response: CapabilitySupport;
    transport?: string;
    managed?: boolean;
    endpoint?: string | null;
  };
}

export class SessionManager {
  readonly registry: SessionRegistry;
  readonly discovery: SessionDiscovery;
  #sessions = new Map<string, Managed>();
  #connecting = new Set<string>();
  #descriptors = new Map<string, AcpSessionDescriptor>();
  #reconcile = Promise.resolve();

  constructor(readonly machine_id: string, options: { directory?: string; interval_ms?: number } = {}) {
    this.registry = new SessionRegistry();
    this.discovery = new SessionDiscovery(options);
    this.discovery.on("sessions", (descriptors: AcpSessionDescriptor[]) => {
      this.#descriptors = new Map(descriptors.map((descriptor) => [descriptor.session_id, descriptor]));
      this.#reconcile = this.#reconcileSessions(descriptors);
    });
    this.discovery.on("session", (descriptor: AcpSessionDescriptor) => this.registry.emit("log", `ACP endpoint found: ${descriptor.harness_type} (${descriptor.session_id})`));
    this.discovery.on("warning", (error) => this.registry.emit("warning", error));
  }

  async start(): Promise<void> { await this.discovery.poll(); await this.#reconcile; this.discovery.start(); }
  stop(): void { this.discovery.stop(); for (const item of this.#sessions.values()) item.attach.close(); this.#sessions.clear(); }
  target(id: string): ACPAttach | undefined { return this.#sessions.get(id)?.attach; }
  harnesses(): HarnessDiscoveryStatus[] {
    const types = new Set([...this.#descriptors.values()].map((item) => item.harness_type));
    return [...types].sort().map((harness_type) => ({
      harness_type,
      discovered_sessions: [...this.#descriptors.values()].filter((item) => item.harness_type === harness_type).length,
      attached_sessions: this.registry.list().filter((item) => item.harness_type === harness_type && this.#sessions.get(item.id)?.attach.connected).length,
    }));
  }

  async #reconcileSessions(descriptors: AcpSessionDescriptor[]): Promise<void> {
    const found = new Set(descriptors.map((item) => item.session_id));
    for (const [id, managed] of this.#sessions) {
      if (!found.has(id)) {
        managed.attach.close(); this.#sessions.delete(id);
        if (this.registry.get(id)) this.registry.setStatus(id, "error", "ACP discovery record is missing");
      }
    }
    await Promise.all(descriptors.map((descriptor) => this.#ensure(descriptor)));
  }

  async #ensure(descriptor: AcpSessionDescriptor): Promise<void> {
    const signature = JSON.stringify(descriptor);
    const current = this.#sessions.get(descriptor.session_id);
    if (current?.signature === signature && current.attach.connected) return;
    if (this.#connecting.has(descriptor.session_id)) return;
    current?.attach.close(); this.#sessions.delete(descriptor.session_id);
    this.#connecting.add(descriptor.session_id);
    const attach = new ACPAttach(descriptor, this.registry, this.machine_id);
    try {
      await attach.connect();
      this.#sessions.set(descriptor.session_id, { signature, attach });
      this.registry.emit("log", `Harness attached: ${descriptor.harness_type} (${descriptor.session_id})`);
      attach.once("close", () => this.#sessions.delete(descriptor.session_id));
    } catch (error) {
      attach.close(); this.registry.emit("warning", new Error(`Cannot attach ${descriptor.session_id}: ${error instanceof Error ? error.message : String(error)}`));
    } finally { this.#connecting.delete(descriptor.session_id); }
  }
}
