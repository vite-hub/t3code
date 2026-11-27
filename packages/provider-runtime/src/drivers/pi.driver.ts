import * as Layer from "effect/Layer";

import { PiDriver } from "../../../provider-pi/src/server/driver.ts";
import { defineEmbeddedDriver } from "../drivers.ts";
import { openProviderDriver } from "./provider-driver.ts";

export const driver = defineEmbeddedDriver({
  layer: Layer.empty,
  open: (input) => openProviderDriver(PiDriver, input),
});
