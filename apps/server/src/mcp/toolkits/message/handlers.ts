import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";

import * as AgentAlerts from "../../../notifications/AgentAlerts.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MessageToolkit } from "./tools.ts";

const makeHandlers = (random: SecureRandom.SecureRandom["Service"]) =>
  ({
    send_to_user: McpToolAccess.actsAsCaller((input) =>
      Effect.succeed({
        sentMessage: input.message,
        message: "Shown to the user. Don't repeat it.",
      }),
    ),
    notify_user: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const thread = yield* McpInvocationContext.requireThreadScope(scope, "notify the user");
        const alerts = yield* AgentAlerts.AgentAlerts;
        const id = yield* random.uuidV4();
        const { delivered, routedTo } = yield* alerts.deliver({
          id,
          threadId: thread.thread.threadId,
          body: input.message,
        });
        return {
          delivered,
          routedTo,
          message: !delivered
            ? "No T3 Code client is connected, so nobody was notified. Ask in your reply."
            : routedTo === null
              ? "The user is away from every client, so all of them were notified. Ask in your reply and end your turn."
              : `Notified the user on the ${routedTo === "desktop-renderer" ? "desktop app" : routedTo} they are using. Ask in your reply and end your turn.`,
        };
      }),
    ),
  }) satisfies McpToolAccess.Handlers<typeof MessageToolkit.tools>;

export const layer = McpToolAccess.toLayer(
  MessageToolkit,
  Effect.gen(function* () {
    return makeHandlers(yield* SecureRandom.SecureRandom);
  }),
);
