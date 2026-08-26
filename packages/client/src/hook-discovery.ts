import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const HOOK_OWNER = "rivetplane-hook-v1";
export const HOOK_DISCOVERY_VERSION = 1 as const;

export interface HookDiscoveryRecord {
  version: typeof HOOK_DISCOVERY_VERSION;
  owner: typeof HOOK_OWNER;
  endpoint: string;
  token: string;
  pid: number;
  started_at: string;
}

export function defaultHookDiscoveryPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const root = env.XDG_CONFIG_HOME || join(home, ".config");
  return join(root, "harness-cp", "hook-endpoint.json");
}

export function createHookToken(): string { return randomBytes(32).toString("base64url"); }

export async function writeHookDiscovery(path: string, record: HookDiscoveryRecord): Promise<void> {
  await assertSafeParent(path);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Hook discovery file must be a regular file");
    assertOwnedAndPrivate(info, "Hook discovery file");
    const prior = JSON.parse(await readFile(path, "utf8")) as Partial<HookDiscoveryRecord>;
    if (prior.owner !== HOOK_OWNER || typeof prior.token !== "string") throw new Error("Refused to replace a discovery file not owned by Rivetplane");
    if (Number.isSafeInteger(prior.pid) && prior.pid !== process.pid && processExists(prior.pid!)) throw new Error(`Another Rivetplane hook endpoint is active (process ${prior.pid})`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function readHookDiscovery(path = defaultHookDiscoveryPath()): Promise<HookDiscoveryRecord> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Hook discovery path is not a regular file");
  assertOwnedAndPrivate(info, "Hook discovery file");
  const value = JSON.parse(await readFile(path, "utf8")) as Partial<HookDiscoveryRecord>;
  if (value.version !== HOOK_DISCOVERY_VERSION || value.owner !== HOOK_OWNER || typeof value.token !== "string" || value.token.length < 32 || !Number.isSafeInteger(value.pid) || typeof value.started_at !== "string") throw new Error("Hook discovery file is invalid");
  const endpoint = validateHookEndpoint(value.endpoint);
  if (!processExists(value.pid!)) {
    await removeHookDiscovery(path, value.token);
    throw new Error("Hook discovery process is not running");
  }
  return { version: HOOK_DISCOVERY_VERSION, owner: HOOK_OWNER, endpoint, token: value.token, pid: value.pid!, started_at: value.started_at };
}

export async function removeHookDiscovery(path: string, token: string): Promise<void> {
  try {
    const current = JSON.parse(await readFile(path, "utf8")) as Partial<HookDiscoveryRecord>;
    if (current.owner === HOOK_OWNER && secretEquals(current.token, token)) await rm(path);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export function validateHookEndpoint(value: unknown): string {
  if (typeof value !== "string") throw new Error("Hook endpoint is invalid");
  const url = new URL(value);
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]" && url.hostname !== "::1") || url.pathname !== "/v1/hooks/events" || url.username || url.password || url.search || url.hash) throw new Error("Hook endpoint must be the loopback ingestion endpoint");
  return url.toString();
}

export function secretEquals(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(actual); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function assertSafeParent(path: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  const info = await stat(parent);
  if (!info.isDirectory()) throw new Error("Hook discovery parent is not a directory");
  assertOwnedAndPrivate(info, "Hook discovery directory");
}

function assertOwnedAndPrivate(info: { uid: number; mode: number }, label: string): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && info.uid !== uid) throw new Error(`${label} is not owned by the current user`);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error(`${label} permissions are not private`);
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
