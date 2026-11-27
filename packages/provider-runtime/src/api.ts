import type {
  ProviderApprovalDecision,
  ProviderSendTurnInput,
  ProviderUserInputAnswers,
  RuntimeMode,
  ThreadId,
  TurnId,
  ApprovalRequestId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { providerRuntimeKindInfo, type ProviderRuntimeKind } from "./kinds.ts";
import type {
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from "./legacy-contracts.ts";
import type { ProviderRuntimeSessionStore } from "./session-store.ts";

// The package's public types. They import no driver or server code, so the
// published declarations stay free of T3 server internals.

export interface ProviderRuntimeMcpServer {
  readonly authorizationHeader: string;
  readonly endpoint: string;
}

export interface ProviderRuntimeStartInput extends Omit<
  ProviderSessionStartInput,
  "modelSelection" | "provider" | "providerInstanceId" | "runtimeMode" | "sandboxMode"
> {
  readonly mcp?: ProviderRuntimeMcpServer;
  /** Provider model id. Falls back to the embedded default for the provider. */
  readonly model?: string;
  readonly modelOptions?: Readonly<Record<string, string | boolean>>;
  readonly runtimeMode?: RuntimeMode;
  /**
   * Native sandbox policy for every turn, such as Codex
   * `{ type: "workspaceWrite", networkAccess: true, writableRoots: [...] }`.
   * Replaces the sandbox that `runtimeMode` selects.
   */
  readonly sandboxPolicy?: unknown;
  /**
   * Absolute skill folders that Codex loads in addition to its own roots, such
   * as a per-session folder outside the checkout. Each folder holds one
   * directory per skill. Claude Code reads skills from `--add-dir` directories
   * instead, so a Claude session rejects this option.
   */
  readonly skillRoots?: ReadonlyArray<string>;
}

export interface CreateProviderRuntimeOptions {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  /**
   * NDJSON file the runtime appends to: a `meta` line when a session starts
   * (kind, model, cwd, start time), then every event it emits.
   */
  readonly eventLogPath?: string;
  /**
   * Where drivers install the agents they manage, such as ACP registry agents
   * and the Antigravity CLI (under `tools/`). Defaults to the state directory.
   */
  readonly installationDirectory?: string;
  readonly provider: ProviderRuntimeKind;
  readonly sessionStore?: ProviderRuntimeSessionStore;
  readonly stateDirectory?: string;
  /**
   * The driver's T3 settings, such as Codex `binaryPath`. The `acp` kind takes
   * `agentId` for a registry agent (gemini, kimi, opencode, copilot, ...) or
   * `commandPath` and `commandArgs` for a local ACP command.
   */
  readonly settings?: Record<string, unknown>;
}

export interface ProviderRuntime {
  readonly attachmentsDirectory: string;
  readonly events: AsyncIterable<ProviderRuntimeEvent>;
  close(): Promise<void>;
  hasSession(threadId: ThreadId): Promise<boolean>;
  interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void>;
  listSessions(): Promise<ReadonlyArray<ProviderSession>>;
  respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void>;
  respondToUserInput(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Promise<void>;
  sendTurn(input: ProviderSendTurnInput): Promise<ProviderTurnStartResult>;
  startSession(input: ProviderRuntimeStartInput): Promise<ProviderSession>;
  stopSession(threadId: ThreadId): Promise<void>;
}

/** Default Claude Code and Codex models when a host starts a session without choosing one. */
export const DEFAULT_PROVIDER_RUNTIME_MODELS: Readonly<Record<"claude-code" | "codex", string>> = {
  "claude-code": providerRuntimeKindInfo("claude-code").defaultModel ?? "",
  codex: providerRuntimeKindInfo("codex").defaultModel ?? "",
};

/** The provider never reported which native turn backs a started host turn. */
export class ProviderRuntimeTurnIdentityTimeoutError extends Schema.TaggedError<ProviderRuntimeTurnIdentityTimeoutError>()(
  "ProviderRuntimeTurnIdentityTimeoutError",
  { turnId: Schema.String },
) {
  override get message(): string {
    return `T3 provider turn ${this.turnId} did not report its provider turn id.`;
  }
}
