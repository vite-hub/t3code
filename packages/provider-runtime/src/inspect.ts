// @effect-diagnostics nodeBuiltinImport:off - This package exposes a Promise-based Node host interface.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import { loadEmbeddedDriver } from "./drivers.ts";
import {
  providerRuntimeKindInfo,
  type ProviderInspection,
  type ProviderRuntimeKind,
} from "./kinds.ts";
import { openEmbeddedProvider } from "./embedded-host.ts";

export interface InspectProviderOptions {
  readonly provider: ProviderRuntimeKind;
  readonly settings?: Record<string, unknown>;
  readonly environment?: NodeJS.ProcessEnv;
  /** Where drivers look for agents they install themselves; see createProviderRuntime. */
  readonly installationDirectory?: string;
  readonly signal?: AbortSignal;
}

export type { ProviderInspection };

/**
 * Runs T3's install, version, account and usage probe for one kind without a turn.
 * Pass createProviderRuntime's settings and environment to inspect that account.
 * Quota is independent of authentication, so check usageLimits too.
 */
export async function inspectProvider(
  options: InspectProviderOptions,
): Promise<ProviderInspection> {
  const { instanceId } = providerRuntimeKindInfo(options.provider);
  const driver = await loadEmbeddedDriver(options.provider);
  const environment = options.environment ?? process.env;
  const stateDirectory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-provider-inspect-"),
  );
  try {
    const { runtime, scope, provider } = await openEmbeddedProvider(
      driver,
      {
        cwd: process.cwd(),
        stateDirectory,
        environment,
        ...(options.installationDirectory === undefined
          ? {}
          : { installationDirectory: options.installationDirectory }),
      },
      { instanceId, settings: options.settings ?? {}, environment },
    );
    try {
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off - each driver fails with its own errors.
      const snapshot = await runtime.runPromise(provider.probe, {
        signal: options.signal,
      });
      const { enabled, installed, version, status, auth, checkedAt, message, usageLimits } =
        snapshot;
      return { enabled, installed, version, status, auth, checkedAt, message, usageLimits };
    } finally {
      try {
        await runtime.runPromise(Scope.close(scope, Exit.void));
      } finally {
        await runtime.dispose();
      }
    }
  } finally {
    await NodeFSP.rm(stateDirectory, { force: true, recursive: true });
  }
}
