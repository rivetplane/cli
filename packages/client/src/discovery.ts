import { EventEmitter } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type AcpTransport =
  | { kind: "websocket"; url: string; headers?: Record<string, string> }
  | { kind: "tcp"; host: string; port: number }
  | { kind: "unix"; path: string };

export interface AcpSessionDescriptor {
  session_id: string;
  harness_type: string;
  cwd: string;
  transport: AcpTransport;
  created_at?: string;
  pid?: number;
}

export interface DiscoveryOptions {
  directory?: string;
  interval_ms?: number;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseDescriptor(value: unknown, filename = "descriptor"): AcpSessionDescriptor {
  if (typeof value !== "object" || value === null) throw new Error(`${filename}: expected an object`);
  const input = value as Record<string, unknown>;
  const session_id = asString(input.session_id) ?? asString(input.sessionId) ?? asString(input.id);
  const harness_type = asString(input.harness_type) ?? asString(input.harness) ?? asString(input.agent);
  const cwd = asString(input.cwd);
  if (!session_id || !harness_type || !cwd) throw new Error(`${filename}: session_id, harness_type, and cwd are required`);

  const rawTransport = typeof input.transport === "object" && input.transport !== null
    ? input.transport as Record<string, unknown>
    : input;
  const endpoint = asString(input.endpoint) ?? asString(input.url) ?? asString(rawTransport.url);
  let transport: AcpTransport;
  if (endpoint) {
    const url = new URL(endpoint);
    if (url.protocol === "ws:" || url.protocol === "wss:") {
      transport = { kind: "websocket", url: endpoint };
    } else if (url.protocol === "tcp:") {
      transport = { kind: "tcp", host: url.hostname, port: Number(url.port) };
    } else if (url.protocol === "unix:") {
      transport = { kind: "unix", path: decodeURIComponent(url.pathname) };
    } else {
      throw new Error(`${filename}: unsupported endpoint protocol ${url.protocol}`);
    }
  } else if (asString(rawTransport.path) || asString(input.socket_path)) {
    transport = { kind: "unix", path: resolve(asString(rawTransport.path) ?? asString(input.socket_path)!) };
  } else if (typeof rawTransport.port === "number") {
    transport = { kind: "tcp", host: asString(rawTransport.host) ?? "127.0.0.1", port: rawTransport.port };
  } else {
    throw new Error(`${filename}: an ACP endpoint is required`);
  }

  const created_at = asString(input.created_at) ?? asString(input.createdAt);
  const pid = typeof input.pid === "number" ? input.pid : undefined;
  return {
    session_id,
    harness_type,
    cwd: resolve(cwd),
    transport,
    ...(created_at ? { created_at } : {}),
    ...(pid !== undefined ? { pid } : {}),
  };
}

export class SessionDiscovery extends EventEmitter {
  readonly directory: string;
  readonly interval_ms: number;
  #timer: NodeJS.Timeout | undefined;
  #known = new Map<string, string>();

  constructor(options: DiscoveryOptions = {}) {
    super();
    this.directory = options.directory ?? join(homedir(), ".acp", "sessions");
    this.interval_ms = options.interval_ms ?? 2_000;
  }

  async scan(): Promise<AcpSessionDescriptor[]> {
    let names: string[];
    try { names = (await readdir(this.directory)).filter((name) => name.endsWith(".json")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const descriptors: AcpSessionDescriptor[] = [];
    for (const name of names.sort()) {
      const filename = join(this.directory, name);
      try { descriptors.push(parseDescriptor(JSON.parse(await readFile(filename, "utf8")) as unknown, filename)); }
      catch (error) { this.emit("warning", error); }
    }
    return descriptors;
  }

  async poll(): Promise<void> {
    const found = await this.scan();
    this.emit("sessions", found);
    const next = new Map<string, string>();
    for (const descriptor of found) {
      const signature = JSON.stringify(descriptor);
      next.set(descriptor.session_id, signature);
      if (this.#known.get(descriptor.session_id) !== signature) this.emit("session", descriptor);
    }
    for (const id of this.#known.keys()) if (!next.has(id)) this.emit("missing", id);
    this.#known = next;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.poll().catch((error) => this.emit("warning", error)), this.interval_ms);
    this.#timer.unref();
  }

  stop(): void { if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; }
}
