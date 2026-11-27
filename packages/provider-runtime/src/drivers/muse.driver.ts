import * as Layer from "effect/Layer";

import { MuseDriver } from "../../../provider-muse/src/server/driver.ts";
import { defineEmbeddedDriver } from "../drivers.ts";
import { openProviderDriver } from "./provider-driver.ts";

export const driver = defineEmbeddedDriver({
  layer: Layer.empty,
  open: (input) => openProviderDriver(MuseDriver, input),
});
