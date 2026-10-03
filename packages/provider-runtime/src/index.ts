// @effect-diagnostics nodeBuiltinImport:off globalDate:off - This package exposes a Promise-based Node host boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ApprovalRequestId,
  ClaudeSettings,
  CodexSettings,
  EnvironmentId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  OrchestrationV2ProviderThread,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  type RuntimeMode,
  RuntimeRequestId,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../apps/server/src/config.ts";
import * as McpProviderSession from "../../../apps/server/src/mcp/McpProviderSession.ts";
import * as ClaudeAdapterV2 from "../../../apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../../../apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as IdAllocator from "../../../apps/server/src/orchestration-v2/IdAllocator.ts";
import type {
  ProviderAdapterV2RuntimePolicy,
  ProviderAdapterV2SessionRuntime,
  ProviderAdapterV2Shape,
} from "../../../apps/server/src/orchestration-v2/ProviderAdapter.ts";
import type { ProviderAdapterDriverCreateError } from "../../../apps/server/src/orchestration-v2/ProviderAdapterDriver.ts";
import * as ProviderEventLoggers from "../../../apps/server/src/provider/Layers/ProviderEventLoggers.ts";
// pnpm pack cannot resolve a workspace dependency on the private shared package.
import { HostProcessEnvironment } from "../../shared/src/hostProcess.ts";
import { createLegacyRun, LegacyEventTranslator, type LegacyRun } from "./legacy-events.ts";
import { createRuntimeModelSelection, withRuntimeModelSelection } from "./model-options.ts";
import type { ProviderRuntimeSessionStore } from "./session-store.ts";

export {
  inspectProvider,
  type InspectProviderOptions,
  type ProviderInspection,
} from "./inspect.ts";

export type ProviderRuntimeKind = "claude-code" | "codex";

export interface ProviderRuntimeMcpServer {
  readonly authorizationHeader: string;
  readonly endpoint: string;
}

export interface ProviderRuntimeStartInput extends Omit<
  ProviderSessionStartInput,
  "modelSelection" | "provider" | "providerInstanceId" | "runtimeMode" | "sandboxMode"
> {
  readonly mcp?: ProviderRuntimeMcpServer;
  /** Provider model id. Falls back to the embedded default for the provider. */
  readonly model?: string;
  readonly modelOptions?: Readonly<Record<string, string | boolean>>;
  readonly runtimeMode?: RuntimeMode;
}

export interface CreateProviderRuntimeOptions {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly provider: ProviderRuntimeKind;
  readonly sessionStore?: ProviderRuntimeSessionStore;
  readonly stateDirectory?: string;
  readonly settings?: Record<string, unknown>;
}

export interface ProviderRuntime {
  readonly attachmentsDirectory: string;
  readonly events: AsyncIterable<ProviderRuntimeEvent>;
  close(): Promise<void>;
  hasSession(threadId: ThreadId): Promise<boolean>;
  interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void>;
  listSessions(): Promise<ReadonlyArray<ProviderSession>>;
  respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void>;
  respondToUserInput(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Promise<void>;
  sendTurn(input: ProviderSendTurnInput): Promise<ProviderTurnStartResult>;
  startSession(input: ProviderRuntimeStartInput): Promise<ProviderSession>;
  stopSession(threadId: ThreadId): Promise<void>;
}

/** Default models when a host starts a session without choosing one. */
export const DEFAULT_PROVIDER_RUNTIME_MODELS: Readonly<Record<ProviderRuntimeKind, string>> = {
  "claude-code": "claude-sonnet-5-5",
  codex: "gpt-6-astra",
};

const PROVIDER_TURN_ID_TIMEOUT = Duration.seconds(15);

/** The provider never reported which native turn backs a started host turn. */
export class ProviderRuntimeTurnIdentityTimeoutError extends Schema.TaggedError<ProviderRuntimeTurnIdentityTimeoutError>()(
  "ProviderRuntimeTurnIdentityTimeoutError",
  { turnId: Schema.String },
) {
  override get message(): string {
    return `T3 provider turn ${this.turnId} did not report its provider turn id.`;
  }
}
const EMBEDDED_PROJECT_ID = ProjectId.make("project:embedded");

const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

/**
 * Durable resume state handed back to hosts as the opaque `resumeCursor`. It
 * carries the provider thread row the adapters need to resume native history.
 */
const ProviderRuntimeResumeCursor = Schema.Struct({
  version: Schema.Literal(2),
  providerThread: OrchestrationV2ProviderThread,
});
const encodeResumeCursor = Schema.encodeSync(ProviderRuntimeResumeCursor);
const decodeResumeCursor = Schema.decodeUnknownOption(ProviderRuntimeResumeCursor);

function providerIdentity(provider: ProviderRuntimeKind) {
  const driverKind = ProviderDriverKind.make(provider === "claude-code" ? "claudeAgent" : "codex");
  return {
    driverKind,
    instanceId: ProviderInstanceId.make(driverKind),
  };
}

/** Single-consumer async queue that backs the host-facing event iterable. */
class AsyncEventQueue<T> implements AsyncIterable<T> {
  readonly #buffer: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #ended = false;

  push(value: T): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#buffer.push(value);
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.#buffer.length > 0) {
          return Promise.resolve({ done: false, value: this.#buffer.shift() as T });
        }
        if (this.#ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => {
          this.#waiters.push(resolve);
        });
      },
      return: () => {
        this.end();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }
}

interface EmbeddedSession {
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderAdapterV2SessionRuntime["providerSessionId"];
  readonly scope: Scope.Closeable;
  readonly runtime: ProviderAdapterV2SessionRuntime;
  readonly translator: LegacyEventTranslator;
  readonly runtimeMode: RuntimeMode;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  readonly modelSelection: ModelSelection;
  readonly createdAt: string;
  providerThread: OrchestrationV2ProviderThread;
  /** Run ordinal on the provider thread; continues from a resumed thread's last run. */
  turnOrdinal: number;
  messageOrdinal: number;
  updatedAt: string;
}

export async function createProviderRuntime(
  options: CreateProviderRuntimeOptions,
): Promise<ProviderRuntime> {
  const cwd = options.cwd ?? process.cwd();
  const ownsStateDirectory = options.stateDirectory === undefined;
  const stateDirectory =
    options.stateDirectory ??
    (await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-provider-runtime-")));
  const identity = providerIdentity(options.provider);
  const environment = options.environment ?? process.env;
  const settings = options.settings ?? {};

  const infrastructure = Layer.mergeAll(
    NodeServices.layer,
    ServerConfig.layerTest(cwd, stateDirectory).pipe(Layer.provide(NodeServices.layer)),
    IdAllocator.layer,
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
    Layer.succeed(HostProcessEnvironment, environment),
  );
  // Both factories only read services at construction; no provider process starts here.
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      ClaudeAdapterV2.claudeAgentSdkQueryRunnerLiveLayer,
      CodexAdapterV2.codexAppServerClientFactoryFromSettingsLayer,
    ).pipe(Layer.provideMerge(infrastructure)),
  );

  const removeOwnedState = async () => {
    if (ownsStateDirectory) await NodeFSP.rm(stateDirectory, { force: true, recursive: true });
  };

  let adapterScope: Scope.Closeable;
  let adapter: ProviderAdapterV2Shape;
  let idAllocator: IdAllocator.IdAllocatorV2["Service"];
  try {
    adapterScope = await runtime.runPromise(Scope.make());
    const driverInput = {
      instanceId: identity.instanceId,
      displayName: undefined,
      environment: [],
      enabled: true,
    };
    const createAdapter: Effect.Effect<
      ProviderAdapterV2Shape,
      ProviderAdapterDriverCreateError,
      | Scope.Scope
      | ClaudeAdapterV2.ClaudeAdapterV2DriverEnv
      | CodexAdapterV2.CodexAdapterV2DriverEnv
    > =
      options.provider === "codex"
        ? CodexAdapterV2.CodexAdapterV2Driver.create({
            ...driverInput,
            config: decodeCodexSettings(settings),
          })
        : ClaudeAdapterV2.ClaudeAdapterV2Driver.create({
            ...driverInput,
            config: decodeClaudeSettings(settings),
          });
    adapter = await runtime.runPromise(createAdapter.pipe(Scope.provide(adapterScope)));
    idAllocator = await runtime.runPromise(Effect.service(IdAllocator.IdAllocatorV2));
  } catch (error) {
    await runtime.dispose();
    await removeOwnedState();
    throw error;
  }

  const events = new AsyncEventQueue<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, EmbeddedSession>();
  let closed = false;

  const assertOpen = () => {
    if (closed) throw new Error("T3 provider runtime is closed.");
  };
  const requireSession = (threadId: ThreadId): EmbeddedSession => {
    assertOpen();
    const session = sessions.get(threadId);
    if (session === undefined) {
      throw new Error(`T3 provider session ${JSON.stringify(threadId)} does not exist.`);
    }
    return session;
  };
  const run = <A, E>(effect: Effect.Effect<A, E, IdAllocator.IdAllocatorV2>): Promise<A> => {
    assertOpen();
    return runtime.runPromise(effect);
  };
  const resumeCursorFor = (session: EmbeddedSession): unknown =>
    encodeResumeCursor({ version: 2, providerThread: session.providerThread });
  const legacySession = (session: EmbeddedSession): ProviderSession => ({
    provider: identity.driverKind,
    providerInstanceId: identity.instanceId,
    status: session.translator.activeRun === undefined ? "ready" : "running",
    runtimeMode: session.runtimeMode,
    cwd: session.runtimePolicy.cwd ?? cwd,
    model: session.modelSelection.model,
    threadId: session.threadId,
    resumeCursor: resumeCursorFor(session),
    ...(session.translator.activeRun === undefined
      ? {}
      : { activeTurnId: session.translator.activeRun.turnId }),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  });
  const appThreadFor = (
    session: EmbeddedSession,
    modelSelection: ModelSelection,
    runtimePolicy: ProviderAdapterV2RuntimePolicy,
  ): OrchestrationV2AppThread => {
    const now = DateTime.makeUnsafe(Date.now());
    return {
      createdBy: "user",
      creationSource: "server",
      id: session.threadId,
      projectId: EMBEDDED_PROJECT_ID,
      title: "Embedded provider thread",
      providerInstanceId: identity.instanceId,
      modelSelection,
      runtimeMode: runtimePolicy.runtimeMode,
      interactionMode: runtimePolicy.interactionMode,
      branch: null,
      worktreePath: null,
      activeProviderThreadId: session.providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: session.threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
  };
  const closeSession = async (session: EmbeddedSession) => {
    sessions.delete(session.threadId);
    McpProviderSession.clearMcpProviderSession(session.threadId);
    await runtime.runPromise(Scope.close(session.scope, Exit.succeed(undefined)));
  };
  const providerTurnFor = (legacyRun: LegacyRun) =>
    legacyRun.providerTurnId !== undefined
      ? Promise.resolve(legacyRun.providerTurnId)
      : run(
          Effect.promise(() => legacyRun.providerTurn).pipe(
            Effect.timeoutOption(PROVIDER_TURN_ID_TIMEOUT),
            Effect.flatMap(
              Effect.fromOption(
                () => new ProviderRuntimeTurnIdentityTimeoutError({ turnId: legacyRun.turnId }),
              ),
            ),
          ),
        );

  return {
    attachmentsDirectory: NodePath.join(stateDirectory, "userdata", "attachments"),
    events,
    async close() {
      if (closed) return;
      closed = true;
      try {
        for (const session of Array.from(sessions.values())) {
          await closeSession(session);
        }
        await runtime.runPromise(Scope.close(adapterScope, Exit.succeed(undefined)));
      } finally {
        events.end();
        try {
          await runtime.dispose();
        } finally {
          await removeOwnedState();
        }
      }
    },
    async hasSession(threadId) {
      assertOpen();
      return sessions.has(threadId);
    },
    async interruptTurn(threadId, turnId) {
      const session = requireSession(threadId);
      const target =
        turnId === undefined
          ? session.translator.activeRun
          : session.translator.runForTurnId(turnId);
      if (target === undefined || target.terminal) return;
      const providerTurnId = await providerTurnFor(target);
      await run(
        session.runtime.interruptTurn({ providerThread: session.providerThread, providerTurnId }),
      );
    },
    async listSessions() {
      assertOpen();
      return [...sessions.values()].map(legacySession);
    },
    respondToRequest: (threadId, requestId, decision) =>
      run(
        requireSession(threadId).runtime.respondToRuntimeRequest({
          requestId: RuntimeRequestId.make(requestId),
          decision,
        }),
      ),
    respondToUserInput: (threadId, requestId, answers) =>
      run(
        requireSession(threadId).runtime.respondToRuntimeRequest({
          requestId: RuntimeRequestId.make(requestId),
          answers,
        }),
      ),
    async sendTurn(rawInput) {
      const session = requireSession(rawInput.threadId);
      const input = withRuntimeModelSelection(rawInput, session.modelSelection);
      const modelSelection = input.modelSelection ?? session.modelSelection;
      const runtimePolicy: ProviderAdapterV2RuntimePolicy = {
        ...session.runtimePolicy,
        interactionMode: input.interactionMode ?? session.runtimePolicy.interactionMode,
      };
      const activeRun = session.translator.activeRun;
      if (activeRun !== undefined) {
        // A turn sent while another runs steers the active turn, like the T3 composer.
        const providerTurnId = await providerTurnFor(activeRun);
        const messageId = await run(
          idAllocator.allocate.message({
            threadId: session.threadId,
            ordinal: ++session.messageOrdinal,
          }),
        );
        await run(
          session.runtime.steerTurn({
            threadId: session.threadId,
            runId: activeRun.runId,
            providerThread: session.providerThread,
            providerTurnId,
            message: {
              messageId,
              text: input.input ?? "",
              attachments: input.attachments ?? [],
              createdBy: "user",
              creationSource: "server",
            },
          }),
        );
        session.updatedAt = new Date().toISOString();
        return {
          threadId: session.threadId,
          turnId: activeRun.turnId,
          resumeCursor: resumeCursorFor(session),
        };
      }
      const ordinal = ++session.turnOrdinal;
      const runId = idAllocator.derive.run({ threadId: session.threadId, ordinal });
      const attemptId = idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
      const legacyRun = createLegacyRun({
        runId,
        attemptId,
        rootNodeId: idAllocator.derive.rootNode({ runId }),
        ordinal,
      });
      const messageId = await run(
        idAllocator.allocate.message({
          threadId: session.threadId,
          ordinal: ++session.messageOrdinal,
        }),
      );
      session.translator.registerRun(legacyRun);
      try {
        await run(
          session.runtime.startTurn({
            appThread: appThreadFor(session, modelSelection, runtimePolicy),
            threadId: session.threadId,
            runId,
            runOrdinal: ordinal,
            providerTurnOrdinal: ordinal,
            attemptId,
            rootNodeId: legacyRun.rootNodeId,
            providerThread: session.providerThread,
            message: {
              messageId,
              text: input.input ?? "",
              attachments: input.attachments ?? [],
              createdBy: "user",
              creationSource: "server",
            },
            modelSelection,
            runtimePolicy,
          }),
        );
      } catch (error) {
        session.translator.abandonRun(legacyRun);
        throw error;
      }
      // Hosts persist the cursor returned here. Record the run on the thread now so
      // a later resume knows native history exists; the adapter's own thread update
      // replaces these values when the turn settles.
      session.providerThread = {
        ...session.providerThread,
        firstRunOrdinal: session.providerThread.firstRunOrdinal ?? ordinal,
        lastRunOrdinal: ordinal,
        status: "active",
      };
      session.updatedAt = new Date().toISOString();
      return {
        threadId: session.threadId,
        turnId: legacyRun.turnId,
        resumeCursor: resumeCursorFor(session),
      };
    },
    async startSession(startInput) {
      assertOpen();
      const { mcp, model, modelOptions, runtimeMode, ...sessionInput } = startInput;
      const threadId = sessionInput.threadId;
      if (sessions.has(threadId)) {
        throw new Error(`T3 provider session ${JSON.stringify(threadId)} already exists.`);
      }
      const modelSelection = createRuntimeModelSelection(
        identity.instanceId,
        model ?? DEFAULT_PROVIDER_RUNTIME_MODELS[options.provider],
        modelOptions,
      );
      const runtimePolicy: ProviderAdapterV2RuntimePolicy = {
        runtimeMode: runtimeMode ?? "full-access",
        interactionMode: "default",
        cwd: sessionInput.cwd ?? cwd,
        ...(sessionInput.approvalPolicy === undefined
          ? {}
          : { approvalPolicy: sessionInput.approvalPolicy }),
      };
      const providerSessionId = await run(
        idAllocator.allocate.providerSession({ providerInstanceId: identity.instanceId, threadId }),
      );
      if (mcp) {
        McpProviderSession.setMcpProviderSession({
          authorizationHeader: mcp.authorizationHeader,
          endpoint: mcp.endpoint,
          environmentId: EnvironmentId.make("embedded"),
          providerInstanceId: identity.instanceId,
          providerSessionId,
          threadId,
          browserToolsAvailable: false,
        });
      }
      const scope = await runtime.runPromise(Scope.make());
      try {
        const sessionRuntime = await run(
          adapter
            .openSession({ threadId, providerSessionId, modelSelection, runtimePolicy })
            .pipe(Scope.provide(scope)),
        );
        const persistedCursor =
          sessionInput.resumeCursor ?? (await options.sessionStore?.get(threadId));
        const resumeThread = Option.getOrUndefined(
          decodeResumeCursor(persistedCursor),
        )?.providerThread;
        const providerThread = await run(
          Effect.gen(function* () {
            if (resumeThread !== undefined) {
              const resumed = yield* Effect.result(
                sessionRuntime.resumeThread({
                  providerThread: resumeThread,
                  threadId,
                  modelSelection,
                  runtimePolicy,
                }),
              );
              if (resumed._tag === "Success") return resumed.success;
              yield* Effect.logWarning("provider-runtime.resume-failed", {
                threadId,
                errorTag: resumed.failure._tag,
              });
            }
            return yield* sessionRuntime.ensureThread({
              threadId,
              modelSelection,
              runtimePolicy,
              providerSessionId,
            });
          }),
        );
        const now = new Date().toISOString();
        const session: EmbeddedSession = {
          threadId,
          providerSessionId,
          scope,
          runtime: sessionRuntime,
          translator: new LegacyEventTranslator({
            driver: identity.driverKind,
            providerInstanceId: identity.instanceId,
            threadId,
            providerThreadId: providerThread.id,
            onProviderThread: (updated) => {
              session.providerThread = updated;
              session.updatedAt = new Date().toISOString();
            },
          }),
          runtimeMode: runtimePolicy.runtimeMode,
          runtimePolicy,
          modelSelection,
          createdAt: now,
          providerThread,
          turnOrdinal: providerThread.lastRunOrdinal ?? 0,
          messageOrdinal: 0,
          updatedAt: now,
        };
        const pump = Stream.runForEach(sessionRuntime.events, (event) =>
          Effect.sync(() => {
            for (const legacyEvent of session.translator.translate(event)) events.push(legacyEvent);
          }),
        ).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              events.push(session.translator.sessionExited(error.message, "error"));
            }),
          ),
        );
        await runtime.runPromise(Effect.forkIn(pump, scope));
        sessions.set(threadId, session);
        if (resumeThread === undefined || resumeThread.id !== providerThread.id) {
          try {
            await options.sessionStore?.set(threadId, resumeCursorFor(session));
          } catch (error) {
            try {
              await closeSession(session);
            } catch (stopError) {
              throw new AggregateError(
                [error, stopError],
                "T3 provider session cursor persistence and cleanup failed.",
                { cause: stopError },
              );
            }
            throw error;
          }
        }
        return legacySession(session);
      } catch (error) {
        sessions.delete(threadId);
        McpProviderSession.clearMcpProviderSession(threadId);
        await runtime
          .runPromise(Scope.close(scope, Exit.succeed(undefined)))
          .catch(() => undefined);
        throw error;
      }
    },
    async stopSession(threadId) {
      const session = requireSession(threadId);
      await closeSession(session);
    },
  };
}

export type {
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderTurnStartResult,
  ProviderUserInputAnswers,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
export {
  createSqliteProviderRuntimeSessionStore,
  type ProviderRuntimeSessionStore,
  type SqliteProviderRuntimeSessionStore,
} from "./session-store.ts";
