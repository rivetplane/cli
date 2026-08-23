import type {
  ApprovalScope,
  Machine,
  PendingInteraction,
  Session,
  Timestamp,
  TranscriptEvent,
} from "./model.js";

export interface HarnessModel {
  provider_id: string;
  model_id: string;
  name: string;
  status?: "alpha" | "beta" | "deprecated" | "active";
  context_limit?: number;
  output_limit?: number;
}

export interface HarnessCapabilities {
  machine_id: string;
  harness_type: string;
  can_create_session: boolean;
  directories: string[];
  models: HarnessModel[];
  default_model?: { provider_id: string; model_id: string };
  reported_at: Timestamp;
}

export const PROTOCOL_VERSION = 1 as const;

export interface MachineHelloMessage {
  type: "machine.hello";
  protocol_version: typeof PROTOCOL_VERSION;
  machine: Machine;
}

export interface MachineHeartbeatMessage {
  type: "machine.heartbeat";
  machine_id: string;
  sent_at: Timestamp;
}

export interface SessionUpsertMessage {
  type: "session.upsert";
  session: Session;
}

export interface TranscriptAppendMessage {
  type: "transcript.append";
  event: TranscriptEvent;
}

export interface SessionRemovedMessage {
  type: "session.removed";
  session_id: string;
  removed_at: Timestamp;
}

export interface CommandResultMessage {
  type: "command.result";
  command_id: string;
  ok: boolean;
  error?: string;
  result?: { session_id?: string };
}

export interface HarnessCapabilitiesMessage { type: "harness.capabilities"; capabilities: HarnessCapabilities; }

export type ClientToServerMessage =
  | MachineHelloMessage
  | MachineHeartbeatMessage
  | SessionUpsertMessage
  | TranscriptAppendMessage
  | SessionRemovedMessage
  | HarnessCapabilitiesMessage
  | CommandResultMessage;

interface CommandBase {
  command_id: string;
  session_id: string;
}

export interface SendMessageCommand extends CommandBase {
  type: "command.send_message";
  text: string;
}

export interface RespondToPendingCommand extends CommandBase {
  type: "command.respond_to_pending";
  pending_id: string;
  response: string;
  scope?: ApprovalScope;
}

export interface InterruptSessionCommand extends CommandBase {
  type: "command.interrupt_session";
}

export interface CreateSessionCommand {
  type: "command.create_session";
  command_id: string;
  machine_id: string;
  harness_type: string;
  cwd: string;
  title?: string;
  model: { provider_id: string; model_id: string };
}

export type ServerToClientMessage =
  | SendMessageCommand
  | RespondToPendingCommand
  | InterruptSessionCommand
  | CreateSessionCommand;

/** Backwards-compatible name used by server command routing. */
export type RelayCommand = ServerToClientMessage;

export interface SessionListFilter {
  machine?: string;
  harness?: string;
  status?: Session["status"];
  cwd?: string;
}

export interface TranscriptPage {
  events: TranscriptEvent[];
  next_cursor: string | null;
}

export interface PendingResponse {
  pending: PendingInteraction | null;
}
