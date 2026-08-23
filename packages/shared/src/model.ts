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

export interface Approval {
  type: "approval";
  id: string;
  session_id: string;
  tool_name: string;
  tool_input_summary: string;
  requested_at: Timestamp;
  resolved_at?: Timestamp;
  resolution?: ApprovalResolution;
}

export interface Question {
  type: "question";
  id: string;
  session_id: string;
  prompt: string;
  options?: string[];
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
