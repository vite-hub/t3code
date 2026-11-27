import * as Layer from "effect/Layer";

import { KiroDriver } from "../../../provider-kiro/src/server/driver.ts";
import { defineEmbeddedDriver } from "../drivers.ts";
import { openProviderDriver } from "./provider-driver.ts";

export const driver = defineEmbeddedDriver({
  layer: Layer.empty,
  open: (input) => openProviderDriver(KiroDriver, input),
});
