import { describe, expect, it } from "@effect/vitest";
import {
  type AgentAlert,
  AuthSessionId,
  type ClientActivityLease,
  RpcClientId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as AgentAlerts from "./AgentAlerts.ts";

const alert = {
  id: "tool-1",
  threadId: ThreadId.make("thread-1"),
  body: "fleet.lock stuck",
} satisfies AgentAlert;

describe("AgentAlerts", () => {
  it.effect("reports no delivery when no client is subscribed", () =>
    Effect.gen(function* () {
      const alerts = yield* AgentAlerts.AgentAlerts;
      expect(yield* alerts.offer(alert)).toBe(false);
    }).pipe(Effect.provide(AgentAlerts.layer)),
  );

  it.effect("delivers to every subscribed client until it disconnects", () =>
    Effect.gen(function* () {
      const alerts = yield* AgentAlerts.AgentAlerts;
      const first = yield* Queue.unbounded<AgentAlert>();
      const second = yield* Queue.unbounded<AgentAlert>();
      const firstClient = yield* alerts.stream.pipe(
        Stream.runForEach((item) => Queue.offer(first, item)),
        Effect.forkScoped({ startImmediately: true }),
      );
      const secondClient = yield* alerts.stream.pipe(
        Stream.runForEach((item) => Queue.offer(second, item)),
        Effect.forkScoped({ startImmediately: true }),
      );

      expect(yield* alerts.offer(alert)).toBe(true);
      expect(yield* Queue.take(first)).toEqual(alert);
      expect(yield* Queue.take(second)).toEqual(alert);

      yield* Fiber.interrupt(firstClient);
      expect(yield* alerts.offer(alert)).toBe(true);
      expect(yield* Queue.take(second)).toEqual(alert);

      yield* Fiber.interrupt(secondClient);
      expect(yield* alerts.offer(alert)).toBe(false);
    }).pipe(Effect.provide(AgentAlerts.layer), Effect.scoped),
  );
});

const lease = (
  clientId: string,
  overrides: Partial<ClientActivityLease> = {},
): ClientActivityLease => ({
  sessionId: AuthSessionId.make("session-1"),
  rpcClientId: RpcClientId.make(1),
  clientId,
  clientKind: "desktop-renderer",
  visible: true,
  focused: false,
  recentlyInteracted: false,
  scopes: [],
  updatedAt: DateTime.makeUnsafe("2026-11-28T12:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe("2026-11-28T12:00:45.000Z"),
  ...overrides,
});

describe("pickAlertTarget", () => {
  const now = DateTime.makeUnsafe("2026-11-28T12:00:10.000Z");

  it("picks the focused client over one touched more recently", () => {
    const target = AgentAlerts.pickAlertTarget(
      [
        lease("laptop", { focused: true }),
        lease("browser", {
          recentlyInteracted: true,
          updatedAt: DateTime.makeUnsafe("2026-11-28T12:00:05.000Z"),
        }),
      ],
      now,
    );
    expect(target?.clientId).toBe("laptop");
  });

  it("finds nobody when every client is hidden, idle, expired or a phone", () => {
    const target = AgentAlerts.pickAlertTarget(
      [
        lease("hidden", { visible: false, focused: true }),
        lease("idle"),
        lease("expired", {
          focused: true,
          expiresAt: DateTime.makeUnsafe("2026-11-28T12:00:05.000Z"),
        }),
        lease("phone", { clientKind: "mobile", focused: true }),
      ],
      now,
    );
    expect(target).toBeUndefined();
  });
});
