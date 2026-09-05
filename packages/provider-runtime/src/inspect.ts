// @effect-diagnostics nodeBuiltinImport:off - This package exposes a Promise-based Node host interface.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, CodexSettings, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  checkClaudeProviderStatus,
  probeClaudeCapabilities,
} from "../../../apps/server/src/provider/Layers/ClaudeProvider.ts";
import { checkCodexProviderStatus } from "../../../apps/server/src/provider/Layers/CodexProvider.ts";
import type { ProviderRuntimeKind } from "./index.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

export interface InspectProviderOptions {
  readonly provider: ProviderRuntimeKind;
  readonly settings?: Record<string, unknown>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

export type ProviderInspection = Pick<
  ServerProvider,
  "enabled" | "installed" | "version" | "status" | "auth" | "checkedAt" | "message" | "usageLimits"
>;

/**
 * Run T3's bounded account/usage probe without persisting a session or sending a turn.
 * Uses the host's current working directory. Pass the same settings and environment
 * as createProviderRuntime to inspect that account. No snapshots are cached here.
 * Quota availability is independent of authentication; inspect usageLimits too.
 */
export async function inspectProvider(
  options: InspectProviderOptions,
): Promise<ProviderInspection> {
  const settings = options.settings ?? {};
  const probe =
    options.provider === "codex"
      ? checkCodexProviderStatus(decodeCodexSettings(settings), undefined, options.environment)
      : checkClaudeProviderStatus(
          decodeClaudeSettings(settings),
          (claudeSettings) =>
            probeClaudeCapabilities(claudeSettings, options.environment).pipe(
              Effect.provide(NodeServices.layer),
            ),
          options.environment,
        );
  const snapshot = await Effect.runPromise(probe.pipe(Effect.provide(NodeServices.layer)), {
    signal: options.signal,
  });
  const { enabled, installed, version, status, auth, checkedAt, message, usageLimits } = snapshot;
  return { enabled, installed, version, status, auth, checkedAt, message, usageLimits };
}
