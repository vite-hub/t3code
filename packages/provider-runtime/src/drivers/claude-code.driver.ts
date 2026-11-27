import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ClaudeAdapterV2 from "../../../../apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  checkClaudeProviderStatus,
  probeClaudeCapabilities,
} from "../../../../apps/server/src/provider/ClaudeProvider.ts";
import { defineEmbeddedDriver } from "../drivers.ts";

// The full Claude driver needs server-only services, so the runtime pairs the
// adapter with T3's standalone status probe.
const decodeSettings = Schema.decodeEffect(ClaudeSettings);

export const driver = defineEmbeddedDriver({
  layer: ClaudeAdapterV2.layerQueryRunner,
  open: Effect.fn("EmbeddedDriver.claudeCode.open")(function* (input) {
    const config = yield* decodeSettings(input.settings);
    const adapter = yield* ClaudeAdapterV2.createClaudeAdapterV2(
      {
        instanceId: input.instanceId,
        displayName: undefined,
        environment: [],
        enabled: true,
        config,
      },
      {},
    );
    return {
      adapter,
      probe: checkClaudeProviderStatus(
        config,
        (settings) =>
          probeClaudeCapabilities(settings, input.environment).pipe(
            Effect.provide(NodeServices.layer),
          ),
        input.environment,
      ),
    };
  }),
});
