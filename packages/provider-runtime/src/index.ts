import type { CreateProviderRuntimeOptions, ProviderRuntime } from "./api.ts";
import { openProviderRuntime } from "./runtime.ts";

export { PROVIDER_RUNTIME_KINDS, type ProviderRuntimeKind } from "./kinds.ts";
export {
  inspectProvider,
  type InspectProviderOptions,
  type ProviderInspection,
} from "./inspect.ts";
export {
  type CreateProviderRuntimeOptions,
  DEFAULT_PROVIDER_RUNTIME_MODELS,
  type ProviderRuntime,
  type ProviderRuntimeMcpServer,
  type ProviderRuntimeStartInput,
  ProviderRuntimeTurnIdentityTimeoutError,
} from "./api.ts";

/**
 * Runs one T3 provider driver in this process. Each kind loads its driver on
 * demand, so a host that runs only Codex never loads the other drivers.
 */
export function createProviderRuntime(
  options: CreateProviderRuntimeOptions,
): Promise<ProviderRuntime> {
  return openProviderRuntime(options);
}

export type {
  ProviderApprovalDecision,
  ProviderSendTurnInput,
  ProviderUserInputAnswers,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
export type {
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderTurnStartResult,
} from "./legacy-contracts.ts";
export {
  createSqliteProviderRuntimeSessionStore,
  type ProviderRuntimeSessionStore,
  type SqliteProviderRuntimeSessionStore,
} from "./session-store.ts";
