import * as Layer from "effect/Layer";

import * as CursorAgentSdk from "../../../provider-cursor/src/server/CursorAgentSdk.ts";
import * as CursorSdk from "../../../provider-cursor/src/server/CursorSdk.ts";
import { CursorDriver } from "../../../provider-cursor/src/server/driver.ts";
import { defineEmbeddedDriver } from "../drivers.ts";
import { openProviderDriver } from "./provider-driver.ts";

// The server runs Cursor agents in a worker process it spawns from its own binary.
// An embedded host has no such binary, so agents run in the host's process.
export const driver = defineEmbeddedDriver({
  layer: CursorAgentSdk.layer.pipe(Layer.provideMerge(CursorSdk.layer)),
  open: (input) => openProviderDriver(CursorDriver, input),
});
