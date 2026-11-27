import type { ProviderInstanceId } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import type { ProviderAdapterV2 } from "../../provider-core/src/server/ProviderAdapter.ts";
import type { EmbeddedHostServices } from "./embedded-host.ts";
import {
  providerRuntimeKindInfo,
  type ProviderInspection,
  type ProviderRuntimeKind,
} from "./kinds.ts";

export interface EmbeddedDriverInput {
  readonly instanceId: ProviderInstanceId;
  readonly settings: Readonly<Record<string, unknown>>;
  /** The process environment the provider runs with. */
  readonly environment: NodeJS.ProcessEnv;
}

export interface EmbeddedProvider<R = any> {
  readonly adapter: ProviderAdapterV2["Service"];
  /** Checks install, version and authentication without a model turn. */
  readonly probe: Effect.Effect<ProviderInspection, unknown, R>;
}

/**
 * One driver as the embedded runtime runs it. The runtime builds `layer` on top of
 * the embedded host, then calls `open` once per runtime or inspection.
 */
export interface EmbeddedDriver {
  // Each driver needs different services; defineEmbeddedDriver checks them before they are erased.
  readonly layer: Layer.Layer<any, unknown, EmbeddedHostServices>;
  readonly open: (input: EmbeddedDriverInput) => Effect.Effect<EmbeddedProvider, unknown, any>;
}

/** Fails to compile when `open` needs a service that neither the host nor `layer` provides. */
export function defineEmbeddedDriver<
  ROut,
  R extends ROut | EmbeddedHostServices | Scope.Scope,
  ProbeR extends ROut | EmbeddedHostServices | Scope.Scope = never,
>(driver: {
  readonly layer: Layer.Layer<ROut, unknown, EmbeddedHostServices>;
  readonly open: (
    input: EmbeddedDriverInput,
  ) => Effect.Effect<EmbeddedProvider<ProbeR>, unknown, R>;
}): EmbeddedDriver {
  return driver;
}

// One import() per kind, so each driver builds into its own chunk and a host loads only its own.
const LOADERS: Readonly<Record<ProviderRuntimeKind, () => Promise<{ driver: EmbeddedDriver }>>> = {
  "claude-code": () => import("./drivers/claude-code.driver.ts"),
  codex: () => import("./drivers/codex.driver.ts"),
  cursor: () => import("./drivers/cursor.driver.ts"),
  grok: () => import("./drivers/grok.driver.ts"),
  opencode: () => import("./drivers/opencode.driver.ts"),
  antigravity: () => import("./drivers/antigravity.driver.ts"),
  pi: () => import("./drivers/pi.driver.ts"),
  kiro: () => import("./drivers/kiro.driver.ts"),
  fx: () => import("./drivers/fx.driver.ts"),
  muse: () => import("./drivers/muse.driver.ts"),
  acp: () => import("./drivers/acp.driver.ts"),
};

export async function loadEmbeddedDriver(kind: ProviderRuntimeKind): Promise<EmbeddedDriver> {
  providerRuntimeKindInfo(kind);
  return (await LOADERS[kind]()).driver;
}
