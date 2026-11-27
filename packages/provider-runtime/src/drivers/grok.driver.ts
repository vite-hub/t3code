import * as Layer from "effect/Layer";

import { GrokDriver } from "../../../provider-grok/src/server/driver.ts";
import { defineEmbeddedDriver } from "../drivers.ts";
import { openProviderDriver } from "./provider-driver.ts";

export const driver = defineEmbeddedDriver({
  layer: Layer.empty,
  open: (input) => openProviderDriver(GrokDriver, input),
});
