import * as Context from "effect/Context";

import type { ServerSettingsService as ServerSettings } from "../../../apps/server/src/serverSettings.ts";

/**
 * The key of T3's settings service, without the settings store. The runtime never provides the
 * service, and the modules it bundles only look the key up (Claude reads it with
 * `Effect.serviceOption`), so the bundle takes this file in place of
 * `apps/server/src/serverSettings.ts` (vite.config.ts). The key string is the service's identity.
 */
export const ServerSettingsService = Context.Service<
  ServerSettings,
  (typeof ServerSettings)["Service"]
>("t3/serverSettings/ServerSettingsService");
