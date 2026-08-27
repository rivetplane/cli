type RecordValue = Record<string, unknown>;

export interface NormalizedApprovalInput {
  summary: string;
  command?: string;
  description?: string;
}

function object(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function text(value: unknown): string | undefined {
  const result = typeof value === "string"
    ? value
    : Array.isArray(value) && value.every((item) => typeof item === "string")
      ? value.join(" ")
      : undefined;
  const trimmed = result?.trim();
  return trimmed || undefined;
}

function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/** Normalize one harness-native approval payload before it enters the shared registry. */
export function normalizeApprovalInput(value: unknown, limit = 2_000): NormalizedApprovalInput {
  const record = object(value);
  const command = text(record?.command) ?? text(record?.cmd);
  const description = text(record?.description) ?? text(record?.reason) ?? text(record?.justification);
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const summary = bounded(raw || description || command || "Approval requested", limit);
  return {
    summary,
    ...(command ? { command: bounded(command, limit) } : {}),
    ...(description ? { description: bounded(description, limit) } : {}),
  };
}
