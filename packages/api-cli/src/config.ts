import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface StoredConfig {
  server: string;
  token: string;
}

export interface ConfigStore {
  readonly path: string;
  load(): Promise<StoredConfig | undefined>;
  save(config: StoredConfig): Promise<void>;
  remove(): Promise<boolean>;
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.RIVETPLANE_CONFIG_DIR
    ?? env.XDG_CONFIG_HOME
    ?? (process.platform === "win32" ? env.APPDATA : undefined)
    ?? join(homedir(), ".config");
  return join(root, "rivetplane", "api-cli.json");
}

export class FileConfigStore implements ConfigStore {
  constructor(readonly path = defaultConfigPath()) {}

  async load(): Promise<StoredConfig | undefined> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as Partial<StoredConfig>;
      if (typeof value.server !== "string" || typeof value.token !== "string") {
        throw new Error(`Invalid configuration file: ${this.path}`);
      }
      return { server: normalizeServer(value.server), token: value.token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(config: StoredConfig): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ ...config, server: normalizeServer(config.server) }, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }

  async remove(): Promise<boolean> {
    try {
      await unlink(this.path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}

export function normalizeServer(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Server URL must use HTTP or HTTPS");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (url.pathname.endsWith("/v1")) url.pathname = url.pathname.slice(0, -3);
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
