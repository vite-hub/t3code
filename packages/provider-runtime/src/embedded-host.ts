// @effect-diagnostics nodeBuiltinImport:off - The embedded host reads the Node process it runs in.
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../apps/server/src/config.ts";
import * as PortScanner from "../../../apps/server/src/preview/PortScanner.ts";
import * as ProviderInstallationGate from "../../../apps/server/src/provider/ProviderInstallationGate.ts";
import { noCompatibilityPolicy } from "../../provider-core/src/server/compatibility.ts";
import * as IdAllocator from "../../provider-core/src/server/IdAllocator.ts";
import * as McpProviderSessions from "../../provider-core/src/server/McpProviderSessions.ts";
import * as ProviderEventLoggers from "../../provider-core/src/server/ProviderEventLoggers.ts";
import * as ProviderHost from "../../provider-core/src/server/ProviderHost.ts";
import * as ProviderLatestVersions from "../../provider-core/src/server/ProviderLatestVersions.ts";
// pnpm pack cannot resolve a workspace dependency on the private shared package.
import * as HostProcess from "../../shared/src/HostProcess.ts";
import type { EmbeddedDriver, EmbeddedDriverInput } from "./drivers.ts";

export interface EmbeddedHostOptions {
  readonly cwd: string;
  /** Holds T3's per-runtime state (`userdata`, caches, attachments). */
  readonly stateDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  /**
   * Where drivers keep CLIs they install themselves: ACP registry agents and
   * Antigravity go under `<installationDirectory>/tools`. Defaults to the state
   * directory, so a temporary runtime installs them again.
   */
  readonly installationDirectory?: string;
}

/**
 * Replaces the T3 server's update checks. An embedded host never asks npm or
 * GitHub for a provider's latest release, so a probe reports no newer version.
 */
const layerNoLatestVersions = Layer.succeed(
  ProviderLatestVersions.ProviderLatestVersions,
  ProviderLatestVersions.ProviderLatestVersions.of({
    cached: Effect.fn("EmbeddedHost.latestVersions.cached")(function () {
      return Effect.succeed(null);
    }),
    invalidate: Effect.fn("EmbeddedHost.latestVersions.invalidate")(function () {
      return Effect.void;
    }),
    invalidateAll: Effect.void,
  }),
);

/**
 * The ProviderHost a driver sees outside the T3 server: fixed default settings,
 * no background work, and credentials that live only as long as the runtime.
 * `awaitServerReady` never completes, so a driver's snapshot runs no status
 * probe on its own; inspectProvider asks for one explicitly.
 */
const layerProviderHost = (options: EmbeddedHostOptions) =>
  Layer.effect(
    ProviderHost.ProviderHost,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const credentials = new Map<string, Uint8Array>();
      const settings = Effect.succeed(DEFAULT_SERVER_SETTINGS);
      return ProviderHost.ProviderHost.of({
        compatibility: noCompatibilityPolicy,
        paths: {
          cwd: options.cwd,
          baseDir: options.installationDirectory ?? config.baseDir,
          stateDir: config.stateDir,
          providerStatusCacheDir: config.providerStatusCacheDir,
          attachmentsDir: config.attachmentsDir,
        },
        settings: {
          get: settings,
          withSnapshot: (use) => Effect.flatMap(settings, use),
          changes: Stream.empty,
          subscribe: Effect.succeed(Stream.empty),
        },
        shouldRunBackgroundWork: Effect.fn("EmbeddedHost.shouldRunBackgroundWork")(function () {
          return Effect.succeed(false);
        }),
        awaitServerReady: Effect.never,
        resolveAttachmentPath: (attachment) => path.join(config.attachmentsDir, attachment.id),
        credentials: Effect.fn("EmbeddedHost.credentials")(function (namespace, bindingId) {
          const key = `${namespace}:${bindingId}`;
          return Effect.succeed({
            binding: { owner: "t3" as const, key },
            get: Effect.sync(() => Option.fromUndefinedOr(credentials.get(key))),
            set: (value: Uint8Array) => Effect.sync(() => void credentials.set(key, value)),
            remove: Effect.sync(() => void credentials.delete(key)),
          });
        }),
      });
    }),
  );

/**
 * ACP agents reach the host's MCP tools through a bridge process the adapter starts
 * as `<ExecutablePath> <Arguments[1]> acp-mcp-bridge`. The package ships that entry.
 */
const acpMcpBridgePath = () =>
  NodeURL.fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts") ? "./acp-mcp-bridge.ts" : "./acp-mcp-bridge.mjs",
      import.meta.url,
    ),
  );

/** Every service the built-in drivers share, without the T3 server around them. */
export const layerEmbeddedHost = (options: EmbeddedHostOptions) => {
  const config = ServerConfig.layerTest(options.cwd, options.stateDirectory).pipe(
    Layer.provide(NodeServices.layer),
  );
  const processContext = Context.make(HostProcess.Environment, options.environment).pipe(
    Context.add(HostProcess.HomeDirectory, options.environment.HOME ?? NodeOS.homedir()),
    Context.add(HostProcess.ExecutablePath, process.execPath),
    Context.add(HostProcess.IsExecutable, false),
    Context.add(HostProcess.Arguments, [process.execPath, acpMcpBridgePath()]),
  );
  return Layer.mergeAll(
    NodeServices.layer,
    config,
    layerProviderHost(options).pipe(Layer.provide(Layer.merge(config, NodeServices.layer))),
    IdAllocator.layer,
    McpProviderSessions.layer,
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
    Layer.succeedContext(processContext),
    NodeCrypto.layerDigest,
    NodeCrypto.layerSecureRandom,
    FetchHttpClient.layer,
    layerNoLatestVersions,
    ProviderInstallationGate.layer,
    // Embedded hosts have no preview surface, so agent port discovery is a no-op.
    PortScanner.layerTest,
  );
};

export type EmbeddedHostServices = Layer.Success<ReturnType<typeof layerEmbeddedHost>>;

/**
 * Builds `driver` on the embedded host and opens its provider. The caller owns the
 * returned runtime and scope: close the scope, then dispose of the runtime.
 */
export async function openEmbeddedProvider(
  driver: EmbeddedDriver,
  host: EmbeddedHostOptions,
  input: EmbeddedDriverInput,
) {
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off - defineEmbeddedDriver checked this driver's services.
  const layer = driver.layer.pipe(Layer.provideMerge(layerEmbeddedHost(host)));
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off - defineEmbeddedDriver checked this driver's services.
  const runtime = ManagedRuntime.make(layer);
  try {
    const scope = await runtime.runPromise(Scope.make());
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off - defineEmbeddedDriver checked this driver's services.
    const provider = await runtime.runPromise(driver.open(input).pipe(Scope.provide(scope)));
    return { runtime, scope, provider };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
