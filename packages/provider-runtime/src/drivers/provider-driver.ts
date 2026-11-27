import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProviderDriver } from "../../../provider-core/src/server/driver.ts";
import type { EmbeddedDriverInput } from "../drivers.ts";

/**
 * Builds a T3 provider instance the way the server's registry does, with the host's
 * settings as its config and its environment as instance variables. Some status probes
 * merge those over process.env, so a key the host leaves out still comes from it.
 */
export const openProviderDriver = Effect.fn("EmbeddedDriver.openProviderDriver")(function* <
  Config,
  R,
  UsageR,
>(driver: ProviderDriver<Config, R, UsageR>, input: EmbeddedDriverInput) {
  const decodeConfig = Schema.decodeEffect(driver.configSchema);
  const config = yield* decodeConfig(input.settings);
  const instance = yield* driver.create({
    instanceId: input.instanceId,
    displayName: undefined,
    environment: Object.entries(input.environment).flatMap(([name, value]) =>
      value === undefined ? [] : [{ name, value, sensitive: false }],
    ),
    enabled: true,
    config,
  });
  return { adapter: instance.orchestrationAdapter, probe: instance.snapshot.refresh };
});
