/** An RFC 3339 timestamp, serialized as a string on the wire. */
export type Timestamp = string;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const MACHINE_STATUSES = ["online", "offline"] as const;
export type MachineStatus = (typeof MACHINE_STATUSES)[number];

export interface Machine {
  id: string;
  name: string;
  owner_account_id: string;
  last_seen_at: Timestamp;
  status: MachineStatus;
  /** Harness types that the machine currently reports as active. */
  harnesses?: string[];
}

export const SESSION_STATUSES = [
  "running",
  "waiting_input",
  "waiting_approval",
  "completed",
  "error",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const APPROVAL_RESOLUTIONS = [
  "approve",
  "deny",
  "timeout",
  "cancelled",
] as const;
export type ApprovalResolution = (typeof APPROVAL_RESOLUTIONS)[number];

export const APPROVAL_SCOPES = [
  "once",
  "always_this_tool",
  "always_session",
] as const;
export type ApprovalScope = (typeof APPROVAL_SCOPES)[number];

/** Whether the source harness has a live handler that can accept a remote reply. */
export type PendingResponseMode = "remote" | "local";

export interface Approval {
  type: "approval";
  id: string;
  session_id: string;
  tool_name: string;
  tool_input_summary: string;
  /** Exact command when the source exposes one separately from its description. */
  command?: string;
  /** Human-readable explanation supplied by the source harness. */
  description?: string;
  /** Transport/source adapter that observed this interaction. */
  source?: string;
  response_mode?: PendingResponseMode;
  requested_at: Timestamp;
  resolved_at?: Timestamp;
  resolution?: ApprovalResolution;
  read_only?: boolean;
  /** Last instant at which the native harness can accept a remote response. */
  expires_at?: Timestamp;
}

export interface Question {
  type: "question";
  id: string;
  session_id: string;
  prompt: string;
  /** Short label supplied by the harness. */
  header?: string;
  options?: string[];
  option_details?: Array<{ label: string; description?: string }>;
  questions?: Array<{
    prompt: string;
    header: string;
    options: Array<{ label: string; description?: string }>;
    multiple?: boolean;
    custom?: boolean;
  }>;
  tool_call_id?: string;
  /** Transport/source adapter that observed this interaction. */
  source?: string;
  response_mode?: PendingResponseMode;
  /** True when this adapter can observe, but cannot answer, the request. */
  read_only?: boolean;
  /** Last instant at which the native harness can accept a remote response. */
  expires_at?: Timestamp;
  requested_at: Timestamp;
  resolved_at?: Timestamp;
  response?: string;
}

export type PendingInteraction = Approval | Question;

export interface Session {
  id: string;
  machine_id: string;
  harness_type: string;
  cwd: string;
  status: SessionStatus;
  created_at: Timestamp;
  last_activity_at: Timestamp;
  pending: PendingInteraction | null;
  title?: string;
  model?: { provider_id: string; model_id: string };
  agent?: string;
  /** True when Rivetplane cannot send commands to the source process. */
  read_only?: boolean;
  metadata?: JsonValue;
}

export interface UserMessagePayload {
  text: string;
}

export interface AgentMessagePayload {
  text: string;
}

export interface ToolCallPayload {
  tool_call_id: string;
  tool_name: string;
  input_summary: string;
  input?: JsonValue;
}

export interface ToolResultPayload {
  tool_call_id: string;
  output_summary: string;
  output?: JsonValue;
  is_error: boolean;
}

export interface PermissionRequestPayload {
  approval_id: string;
  tool_name: string;
  tool_input_summary: string;
}

export interface PermissionResponsePayload {
  approval_id: string;
  resolution: ApprovalResolution;
  scope?: ApprovalScope;
  actor_id?: string;
}

export interface StatusChangePayload {
  from: SessionStatus;
  to: SessionStatus;
  reason?: string;
}

export interface TranscriptEventPayloadMap {
  user_message: UserMessagePayload;
  agent_message: AgentMessagePayload;
  tool_call: ToolCallPayload;
  tool_result: ToolResultPayload;
  permission_request: PermissionRequestPayload;
  permission_response: PermissionResponsePayload;
  status_change: StatusChangePayload;
}

export type TranscriptEventType = keyof TranscriptEventPayloadMap;

export type TranscriptEventOf<TType extends TranscriptEventType> = {
  id: string;
  session_id: string;
  seq: number;
  ts: Timestamp;
  type: TType;
  payload: TranscriptEventPayloadMap[TType];
};

/**
 * A discriminated union. Checking `type` also narrows `payload` to its
 * type-specific shape.
 */
export type TranscriptEvent = {
  [TType in TranscriptEventType]: TranscriptEventOf<TType>;
}[TranscriptEventType];
