import { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as CodexAdapterV2 from "../../../../apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts";
import { checkCodexProviderStatus } from "../../../../apps/server/src/provider/CodexProvider.ts";
import { defineEmbeddedDriver } from "../drivers.ts";

// The full Codex driver needs server-only services (managed tokens, reset credits),
// so the runtime pairs the adapter with T3's standalone status probe.
const decodeSettings = Schema.decodeEffect(CodexSettings);

export const driver = defineEmbeddedDriver({
  layer: CodexAdapterV2.layerAppServerClientFactory,
  open: Effect.fn("EmbeddedDriver.codex.open")(function* (input) {
    const config = yield* decodeSettings(input.settings);
    const adapter = yield* CodexAdapterV2.createCodexAdapterV2({
      instanceId: input.instanceId,
      displayName: undefined,
      environment: [],
      enabled: true,
      config,
    });
    return {
      adapter,
      probe: checkCodexProviderStatus(config, undefined, input.environment),
    };
  }),
});
