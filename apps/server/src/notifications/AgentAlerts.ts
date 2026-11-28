import type { AgentAlert, ClientActivityLease, ClientKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";

export type AgentAlertInput = Omit<AgentAlert, "targetClientId">;

export interface AgentAlertDelivery {
  /** A client took it, not that it put it on screen. */
  readonly delivered: boolean;
  /** The kind of client the user is on, or null when no client is in use and every one gets it. */
  readonly routedTo: ClientKind | null;
}

export class AgentAlerts extends Context.Service<
  AgentAlerts,
  {
    /** Hands the alert to the client the user is on, or to every client when none is in use. */
    readonly deliver: (alert: AgentAlertInput) => Effect.Effect<AgentAlertDelivery>;
    /** `deliver`, answering only whether a client took it. */
    readonly offer: (alert: AgentAlertInput) => Effect.Effect<boolean>;
    readonly stream: Stream.Stream<AgentAlert>;
  }
>()("t3/notifications/AgentAlerts") {}

/**
 * The client the user is on: a visible client with focus, else one they touched recently, the
 * latest report first. Phones are left out until they present alerts.
 */
export const pickAlertTarget = (
  leases: ReadonlyArray<ClientActivityLease>,
  now: DateTime.Utc,
): ClientActivityLease | undefined => {
  const inUse = leases.filter(
    (lease) =>
      DateTime.isGreaterThan(lease.expiresAt, now) &&
      lease.clientKind !== "mobile" &&
      lease.visible &&
      (lease.focused || lease.recentlyInteracted),
  );
  const rank = (lease: ClientActivityLease) => (lease.focused ? 1 : 0);
  return inUse.toSorted(
    (a, b) =>
      rank(b) - rank(a) ||
      DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt),
  )[0];
};

const make = Effect.gen(function* () {
  const policy = yield* Effect.serviceOption(BackgroundPolicy.BackgroundPolicy);
  const subscribers = yield* Ref.make(0);
  const alerts = yield* PubSub.unbounded<AgentAlert>();

  const stream = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe before counting: counted first, an offer in between reports a
      // delivery that the subscription never receives.
      const subscription = yield* PubSub.subscribe(alerts);
      // One step, so an interrupt cannot leave the count raised with no cleanup registered.
      yield* Effect.acquireRelease(
        Ref.update(subscribers, (count) => count + 1),
        () => Ref.update(subscribers, (count) => count - 1),
      );
      return Stream.fromSubscription(subscription);
    }),
  );

  const target = Option.match(policy, {
    onNone: () => Effect.undefined,
    onSome: (background) =>
      Effect.zipWith(background.snapshot, DateTime.now, (snapshot, now) =>
        pickAlertTarget(snapshot.leases, now),
      ),
  });

  const deliver: AgentAlerts["Service"]["deliver"] = Effect.fn("AgentAlerts.deliver")(
    function* (alert) {
      const lease = yield* target;
      const routedTo = lease?.clientKind ?? null;
      if ((yield* Ref.get(subscribers)) === 0) return { delivered: false, routedTo };
      yield* PubSub.publish(
        alerts,
        lease === undefined ? alert : { ...alert, targetClientId: lease.clientId },
      );
      return { delivered: true, routedTo };
    },
  );

  const offer: AgentAlerts["Service"]["offer"] = (alert) =>
    Effect.map(deliver(alert), (delivery) => delivery.delivered);

  return AgentAlerts.of({ deliver, offer, stream });
});

export const layer = Layer.effect(AgentAlerts, make);
