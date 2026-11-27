import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AntigravityDriver } from "../../../../apps/server/src/provider/Drivers/AntigravityDriver.ts";
import * as AntigravityInstallation from "../../../../apps/server/src/provider/AntigravityInstallation.ts";
import * as ModelManifest from "../../../../apps/server/src/provider/ModelManifest.ts";
import * as ProviderHost from "../../../provider-core/src/server/ProviderHost.ts";
import { defineEmbeddedDriver } from "../drivers.ts";
import { openProviderDriver } from "./provider-driver.ts";

// Models come from the manifest bundled with this build; the embedded host never fetches a newer one.
const layerModels = ModelManifest.layerTest;

// T3 installs the Antigravity CLI under `<installationDirectory>/tools` and never updates it in the background.
const layerInstallation = Layer.effect(
  AntigravityInstallation.AntigravityInstallation,
  Effect.gen(function* () {
    const host = yield* ProviderHost.ProviderHost;
    return yield* AntigravityInstallation.makeAntigravityInstallation({
      baseDir: host.paths.baseDir,
      updateChecksEnabled: Effect.succeed(false),
    });
  }),
).pipe(Layer.provide(layerModels));

export const driver = defineEmbeddedDriver({
  layer: Layer.merge(layerModels, layerInstallation),
  open: (input) => openProviderDriver(AntigravityDriver, input),
});
