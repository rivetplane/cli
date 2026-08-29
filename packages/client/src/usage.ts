import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  UsageContext,
  UsageCost,
  UsageCounterMode,
  UsageQuotaWindow,
  UsageSample,
  UsageTokens,
} from "@rivetplane/shared/model";

const TOKEN_KEYS = ["input", "output", "reasoning", "cache_read", "cache_write", "total"] as const;
const MAX_EVENT_IDS = 20_000;

interface CounterSnapshot { tokens: UsageTokens; cost_amount?: number }
interface UsageCheckpoint { version: 1; counters: Record<string, CounterSnapshot>; recent_event_ids: string[] }

export interface RawUsageSample {
  session_id: string | null;
  turn_id?: string;
  timestamp?: string;
  harness: string;
  provider?: string;
  model?: string;
  source: string;
  source_counter_mode: UsageCounterMode;
  /** Stable native record ID. If absent, the normalized source values form the ID. */
  source_event_id?: string;
  /** Stable scope for a cumulative counter, such as a session or turn ID. */
  counter_key?: string;
  tokens: Partial<UsageTokens>;
  context?: UsageContext;
  cost?: UsageCost;
  quota?: UsageQuotaWindow[];
}

export interface UsageCollectorOptions { checkpoint_path?: string; now?: () => number; max_event_ids?: number }

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function tokens(value: Partial<UsageTokens>): UsageTokens {
  return {
    input: finite(value.input), output: finite(value.output), reasoning: finite(value.reasoning),
    cache_read: finite(value.cache_read), cache_write: finite(value.cache_write), total: finite(value.total),
  };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function stableId(value: unknown): string { return `usage:${createHash("sha256").update(canonical(value)).digest("base64url").slice(0, 32)}`; }
function delta(current: number | null, prior: number | null): number | null {
  if (current === null) return null;
  if (prior === null) return current;
  return current >= prior ? current - prior : 0;
}
function cleanCost(value: UsageCost | undefined): UsageCost {
  if (!value) return { status: "unavailable" };
  const amount = finite(value.amount);
  return {
    status: value.status,
    ...(amount !== null ? { amount } : {}),
    ...(typeof value.currency === "string" && value.currency ? { currency: value.currency.toUpperCase() } : {}),
  };
}

/** Normalizes source counters and keeps a small durable replay checkpoint. */
export class UsageCollector extends EventEmitter {
  readonly checkpoint_path: string;
  #checkpoint: UsageCheckpoint = { version: 1, counters: {}, recent_event_ids: [] };
  #seen = new Set<string>();
  #loaded = false;
  #saveChain: Promise<void> = Promise.resolve();

  constructor(readonly machine_id: string, private readonly options: UsageCollectorOptions = {}) {
    super();
    this.checkpoint_path = options.checkpoint_path ?? join(homedir(), ".config", "harness-cp", "usage-checkpoints.json");
  }

  async start(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const value = JSON.parse(await readFile(this.checkpoint_path, "utf8")) as UsageCheckpoint;
      if (value.version === 1 && value.counters && Array.isArray(value.recent_event_ids)) this.#checkpoint = value;
    } catch { /* A missing or invalid checkpoint starts a safe new baseline. */ }
    this.#seen = new Set(this.#checkpoint.recent_event_ids);
  }

  ingest(raw: RawUsageSample): UsageSample | undefined {
    if (!this.#loaded) throw new Error("UsageCollector.start() must complete before ingest()");
    const currentTokens = tokens(raw.tokens); const currentCost = cleanCost(raw.cost);
    const identity = raw.source_event_id ?? canonical({
      session_id: raw.session_id, turn_id: raw.turn_id, harness: raw.harness, source: raw.source,
      counter_key: raw.counter_key, tokens: currentTokens, context: raw.context, cost: currentCost, quota: raw.quota,
    });
    const event_id = stableId({ machine_id: this.machine_id, harness: raw.harness, session_id: raw.session_id, turn_id: raw.turn_id, source: raw.source, identity });
    if (this.#seen.has(event_id)) return undefined;

    let normalizedTokens = currentTokens; let normalizedCost = currentCost;
    if (raw.source_counter_mode === "cumulative") {
      const key = raw.counter_key ?? `${raw.source}\0${raw.session_id ?? "account"}\0${raw.turn_id ?? "session"}`;
      const prior = this.#checkpoint.counters[key];
      normalizedTokens = Object.fromEntries(TOKEN_KEYS.map((name) => [name, delta(currentTokens[name], prior?.tokens[name] ?? null)])) as unknown as UsageTokens;
      if (currentCost.amount !== undefined) {
        const amount = prior?.cost_amount === undefined ? currentCost.amount : currentCost.amount >= prior.cost_amount ? currentCost.amount - prior.cost_amount : 0;
        normalizedCost = { ...currentCost, amount };
      }
      // A decrease is a source reset. Emit zero for the reset snapshot, then
      // use it as the new baseline so later valid usage is not suppressed.
      this.#checkpoint.counters[key] = { tokens: currentTokens, ...(currentCost.amount !== undefined ? { cost_amount: currentCost.amount } : {}) };
    }

    const sample: UsageSample = {
      event_id, machine_id: this.machine_id, session_id: raw.session_id,
      ...(raw.turn_id ? { turn_id: raw.turn_id } : {}),
      timestamp: validTimestamp(raw.timestamp, this.options.now?.() ?? Date.now()), harness: raw.harness,
      ...(raw.provider ? { provider: raw.provider } : {}), ...(raw.model ? { model: raw.model } : {}),
      source: raw.source, source_counter_mode: raw.source_counter_mode, tokens: normalizedTokens,
      ...(raw.context ? { context: raw.context } : {}), cost: normalizedCost,
      ...(raw.quota ? { quota: raw.quota } : {}),
    };
    this.#seen.add(event_id); this.#checkpoint.recent_event_ids.push(event_id);
    const limit = this.options.max_event_ids ?? MAX_EVENT_IDS;
    if (this.#checkpoint.recent_event_ids.length > limit) {
      this.#checkpoint.recent_event_ids.splice(0, this.#checkpoint.recent_event_ids.length - limit);
      this.#seen = new Set(this.#checkpoint.recent_event_ids);
    }
    this.#scheduleSave(); this.emit("usage", structuredClone(sample)); return structuredClone(sample);
  }

  async flush(): Promise<void> { await this.#saveChain; }

  #scheduleSave(): void {
    const snapshot = structuredClone(this.#checkpoint); const path = this.checkpoint_path;
    this.#saveChain = this.#saveChain.then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 }); await rename(temporary, path);
    }).catch((error: unknown) => { this.emit("warning", error); });
  }
}

function validTimestamp(value: string | undefined, fallback: number): string {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return new Date(Number.isFinite(parsed) ? parsed : fallback).toISOString();
}
