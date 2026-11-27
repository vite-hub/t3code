import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../../../apps/server/src/config.ts";
import { OpenCodeDriver } from "../../../provider-opencode/src/server/driver.ts";
import * as OpenCodeRuntime from "../../../provider-opencode/src/server/OpenCodeRuntime.ts";
import * as OpenCodeServerLedger from "../../../provider-opencode/src/server/OpenCodeServerLedger.ts";
import { defineEmbeddedDriver } from "../drivers.ts";
import { openProviderDriver } from "./provider-driver.ts";

export const driver = defineEmbeddedDriver({
  // The ledger lets a later runtime with the same state directory stop servers a crashed one left.
  layer: OpenCodeRuntime.layer.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          return OpenCodeServerLedger.layer({ stateDir: config.stateDir });
        }),
      ),
    ),
  ),
  open: (input) => openProviderDriver(OpenCodeDriver, input),
});
