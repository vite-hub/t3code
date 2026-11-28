import * as Schema from "effect/Schema";

import { ClientActivityClientId } from "./background.ts";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** A message an agent asked to have shown to the user while its thread is still running. */
export const AgentAlert = Schema.Struct({
  // Two alerts with the same text are still two alerts.
  id: TrimmedNonEmptyString,
  threadId: ThreadId,
  body: TrimmedNonEmptyString,
  /**
   * The client the user is on, from its activity lease. Only that client presents the alert, so
   * the laptop in use rings and an idle tab elsewhere stays quiet. Absent: every client presents it.
   */
  targetClientId: Schema.optionalKey(ClientActivityClientId),
});
export type AgentAlert = typeof AgentAlert.Type;
