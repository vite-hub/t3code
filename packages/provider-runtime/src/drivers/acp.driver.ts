import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { defaultProviderContinuationIdentity } from "../../../provider-core/src/server/driver.ts";
import * as ProviderHost from "../../../provider-core/src/server/ProviderHost.ts";
import * as AcpRegistrySupport from "../../../provider-acp-registry/src/server/AcpRegistrySupport.ts";
import {
  AcpRegistryDriver,
  checkAcpRegistryProviderStatus,
} from "../../../provider-acp-registry/src/server/driver.ts";
import { probeAcpRegistryConfiguration } from "../../../provider-acp-registry/src/server/probe.ts";
import { AcpRegistrySettings } from "../../../provider-acp-registry/src/settings.ts";
import { defineEmbeddedDriver, type EmbeddedDriverInput } from "../drivers.ts";
import { openProviderDriver } from "./provider-driver.ts";

/** A `commandPath` without an `agentId` names a local ACP command. */
const decodeSettings = Schema.decodeEffect(AcpRegistrySettings);

const withSource = (settings: EmbeddedDriverInput["settings"]) => {
  const isLocalCommand =
    settings.source === undefined &&
    (settings.agentId === undefined || settings.agentId === "") &&
    typeof settings.commandPath === "string" &&
    settings.commandPath !== "";
  return isLocalCommand ? { ...settings, source: "local" } : settings;
};

/**
 * Runs an agent from the ACP registry, chosen by `settings.agentId` (such as
 * "gemini", "kimi", "opencode" or "copilot"), or a local ACP command given by
 * `settings.commandPath` and `settings.commandArgs`.
 */
export const driver = defineEmbeddedDriver({
  layer: AcpRegistrySupport.layerFromHost,
  open: Effect.fn("EmbeddedDriver.acp.open")(function* (rawInput: EmbeddedDriverInput) {
    const input = { ...rawInput, settings: withSource(rawInput.settings) };
    const provider = yield* openProviderDriver(AcpRegistryDriver, input);
    const settings = yield* decodeSettings(input.settings);
    const host = yield* ProviderHost.ProviderHost;
    // The instance's own refresh defers sign-in and model checks to the background;
    // this runs the whole check, which opens an ACP session but sends no prompt.
    const probe = checkAcpRegistryProviderStatus(
      {
        instanceId: input.instanceId,
        displayName: undefined,
        accentColor: undefined,
        continuationKey: defaultProviderContinuationIdentity({
          driverKind: AcpRegistryDriver.driverKind,
          instanceId: input.instanceId,
        }).continuationKey,
        settings,
        cwd: host.paths.cwd,
        environment: input.environment,
      },
      probeAcpRegistryConfiguration,
    );
    return { adapter: provider.adapter, probe };
  }),
});
