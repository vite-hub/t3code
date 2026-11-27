// @effect-diagnostics nodeBuiltinImport:off - These tests drive the Promise-based Node host boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { type RuntimeMode, ThreadId } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { AcpRegistryOrchestratorReplayHarness } from "../../../apps/server/src/orchestration-v2/Adapters/AcpRegistryAdapterV2.testkit.ts";
import { makeAntigravityAdapterV2 } from "../../../apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts";
import { ClaudeOrchestratorReplayHarness } from "../../../apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
import { CodexOrchestratorReplayHarness } from "../../../apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import { CursorOrchestratorReplayHarness } from "../../../apps/server/src/orchestration-v2/Adapters/CursorAdapterV2.testkit.ts";
import { FxOrchestratorReplayHarness } from "../../../apps/server/src/orchestration-v2/Adapters/FxAdapterV2.testkit.ts";
import { GrokOrchestratorReplayHarness } from "../../../apps/server/src/orchestration-v2/Adapters/GrokAdapterV2.testkit.ts";
import { KiroOrchestratorReplayHarness } from "../../../apps/server/src/orchestration-v2/Adapters/KiroAdapterV2.testkit.ts";
import {
  materializeMuseReplayWorkspace,
  MuseOrchestratorReplayHarness,
} from "../../../apps/server/src/orchestration-v2/Adapters/MuseAdapterV2.testkit.ts";
import { OpenCodeOrchestratorReplayHarness } from "../../../apps/server/src/orchestration-v2/Adapters/OpenCodeAdapterV2.testkit.ts";
import { PiOrchestratorReplayHarness } from "../../../apps/server/src/orchestration-v2/Adapters/PiAdapterV2.testkit.ts";
import * as ProviderAdapterRegistry from "../../../apps/server/src/orchestration-v2/ProviderAdapterRegistry.ts";
import {
  ACP_REGISTRY_MODEL_SELECTION,
  CLAUDE_MODEL_SELECTION,
  CODEX_MODEL_SELECTION,
  CURSOR_MODEL_SELECTION,
  FX_MODEL_SELECTION,
  GROK_MODEL_SELECTION,
  KIRO_MODEL_SELECTION,
  MUSE_MODEL_SELECTION,
  OPENCODE_MODEL_SELECTION,
  PI_MODEL_SELECTION,
  SIMPLE_PROMPT,
} from "../../../apps/server/src/orchestration-v2/testkit/fixtures/shared.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../../../apps/server/src/orchestration-v2/testkit/ProviderReplayHarness.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "../../../apps/server/src/orchestration-v2/testkit/ReplayRuntimeInstructions.ts";
import { makeAntigravityAcpRuntime } from "../../../apps/server/src/provider/acp/AntigravityAcpSupport.ts";
import {
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "../../provider-testing/src/replayTranscript.ts";
import { resolveSelfInvocation } from "../../shared/src/nodeRuntime.ts";
import type { ProviderRuntime } from "./api.ts";
import { defineEmbeddedDriver, type EmbeddedDriver } from "./drivers.ts";
import {
  PROVIDER_RUNTIME_KINDS,
  providerRuntimeKindInfo,
  type ProviderRuntimeKind,
} from "./kinds.ts";
import type { ProviderRuntimeEvent } from "./legacy-contracts.ts";
import { openProviderRuntime } from "./runtime.ts";

type ReplayTranscript = Parameters<OrchestratorV2ProviderReplayHarness["decodeTranscript"]>[0];

interface ReplayCase<Transcript extends ReplayTranscript, E> {
  readonly harness: OrchestratorV2ProviderReplayHarness<Transcript, E>;
  /** The transcript under testkit/fixtures/simple. */
  readonly fixture: string;
  readonly model: string;
  readonly modelOptions?: Readonly<Record<string, string>>;
  readonly runtimeMode?: RuntimeMode;
  /** Rewrites recorded workspace paths to the session's cwd, for drivers that record them. */
  readonly materializeWorkspace?: (
    transcript: ReplayTranscript,
    cwd: string,
  ) => Effect.Effect<ReplayTranscript, Error>;
}

/** Runs a driver's upstream replay harness on its recorded "simple" turn instead of its CLI or SDK. */
function replayDriver<Transcript extends ReplayTranscript, E>(
  replay: ReplayCase<Transcript, E>,
  cwd: string,
): EmbeddedDriver {
  const transcript = Effect.gen(function* () {
    const recorded = yield* readProviderReplayTranscript(
      new URL(
        `../../../apps/server/src/orchestration-v2/testkit/fixtures/simple/${replay.fixture}_transcript.ndjson`,
        import.meta.url,
      ),
    );
    // The fixtures name their thread after the scenario; the embedded runtime names it itself.
    const renamed: ReplayTranscript = JSON.parse(
      JSON.stringify(recorded).replaceAll("Replay fixture: simple", "Embedded provider thread"),
    );
    const instructed = materializeReplayTranscriptRuntimeInstructions(renamed, {
      driver: replay.harness.driver,
      model: replay.model,
    });
    const materialized =
      replay.materializeWorkspace === undefined
        ? instructed
        : yield* replay.materializeWorkspace(instructed, cwd);
    return yield* replay.harness.decodeTranscript(materialized);
  });
  return defineEmbeddedDriver({
    layer: Layer.unwrap(Effect.map(transcript, replay.harness.makeProviderAdapterRegistryLayer)),
    open: Effect.fn("replayDriver.open")(function* () {
      const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
      const [instanceId] = yield* registry.list();
      if (instanceId === undefined) return yield* Effect.die("The replay harness has no adapter.");
      return {
        adapter: yield* registry.get(instanceId),
        probe: Effect.die("Replay drivers have no status probe."),
      };
    }),
  });
}

/** Antigravity has no replay harness; T3's ACP mock agent stands in for its CLI. */
const antigravityMockDriver = defineEmbeddedDriver({
  layer: Layer.empty,
  open: Effect.fn("antigravityMockDriver.open")(function* (input) {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const secureRandom = yield* SecureRandom.SecureRandom;
    const mockAgentPath = NodeURL.fileURLToPath(
      new URL("../../../apps/server/scripts/acp-mock-agent.ts", import.meta.url),
    );
    const adapter = yield* makeAntigravityAdapterV2({
      instanceId: input.instanceId,
      selfInvocation: yield* resolveSelfInvocation(),
      makeRuntime: (runtimeInput) =>
        makeAntigravityAcpRuntime({
          ...runtimeInput,
          childProcessSpawner,
          spawn: {
            command: process.execPath,
            args: [mockAgentPath],
            cwd: runtimeInput.cwd,
            env: { T3_ACP_ANTIGRAVITY: "1" },
          },
        }).pipe(Effect.provideService(SecureRandom.SecureRandom, secureRandom)),
      withProcess: (_stop, task) => task,
      defaultModel: Effect.undefined,
    });
    return { adapter, probe: Effect.die("The mock agent has no status probe.") };
  }),
});

const replayCase = <Transcript extends ReplayTranscript, E>(replay: ReplayCase<Transcript, E>) =>
  replay as ReplayCase<ReplayTranscript, unknown>;

const CASES: Readonly<
  Record<Exclude<ProviderRuntimeKind, "antigravity">, ReplayCase<ReplayTranscript, unknown>>
> = {
  "claude-code": replayCase({
    harness: ClaudeOrchestratorReplayHarness,
    fixture: "claude",
    model: CLAUDE_MODEL_SELECTION.model,
  }),
  codex: replayCase({
    harness: CodexOrchestratorReplayHarness,
    fixture: "codex",
    model: CODEX_MODEL_SELECTION.model,
    materializeWorkspace: (transcript, cwd) =>
      Effect.succeed(materializeReplayTranscriptWorkspace(transcript, cwd)),
  }),
  cursor: replayCase({
    harness: CursorOrchestratorReplayHarness,
    fixture: "cursor",
    model: CURSOR_MODEL_SELECTION.model,
  }),
  grok: replayCase({
    harness: GrokOrchestratorReplayHarness,
    fixture: "grok",
    model: GROK_MODEL_SELECTION.model,
  }),
  opencode: replayCase({
    harness: OpenCodeOrchestratorReplayHarness,
    fixture: "opencode",
    model: OPENCODE_MODEL_SELECTION.model,
    modelOptions: { agent: "build" },
  }),
  pi: replayCase({
    harness: PiOrchestratorReplayHarness,
    fixture: "pi",
    model: PI_MODEL_SELECTION.model,
  }),
  kiro: replayCase({
    harness: KiroOrchestratorReplayHarness,
    fixture: "kiro",
    model: KIRO_MODEL_SELECTION.model,
  }),
  // The fixture ran fx's `ask` mode, which a supervised session selects.
  fx: replayCase({
    harness: FxOrchestratorReplayHarness,
    fixture: "fx",
    model: FX_MODEL_SELECTION.model,
    runtimeMode: "approval-required",
  }),
  muse: replayCase({
    harness: MuseOrchestratorReplayHarness,
    fixture: "muse",
    model: MUSE_MODEL_SELECTION.model,
    materializeWorkspace: materializeMuseReplayWorkspace,
  }),
  acp: replayCase({
    harness: AcpRegistryOrchestratorReplayHarness,
    fixture: "registry",
    model: ACP_REGISTRY_MODEL_SELECTION.model,
  }),
};

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => NodeFSP.rm(path, { force: true, recursive: true })),
  );
});

function waitForEvent(
  runtime: ProviderRuntime,
  matches: (event: ProviderRuntimeEvent) => boolean,
): Promise<ProviderRuntimeEvent> {
  return (async () => {
    for await (const event of runtime.events) {
      if (matches(event)) return event;
    }
    throw new Error("The runtime closed before the event arrived.");
  })();
}

describe("provider runtime drivers", () => {
  it.each(PROVIDER_RUNTIME_KINDS.filter((kind) => kind !== "antigravity"))(
    "%s runs its recorded turn through the embedded runtime",
    async (kind) => {
      const replay = CASES[kind as Exclude<ProviderRuntimeKind, "antigravity">];
      const cwd = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), `t3-runtime-${kind}-`));
      directories.push(cwd);
      const eventLogPath = NodePath.join(cwd, "..", `${NodePath.basename(cwd)}.events.jsonl`);
      directories.push(eventLogPath);
      const runtime = await openProviderRuntime(
        { provider: kind, cwd, eventLogPath },
        replayDriver(replay, cwd),
      );
      const threadId = ThreadId.make(`thread-${kind}`);
      try {
        const completed = waitForEvent(
          runtime,
          (event) => event.type === "turn.completed" && event.threadId === threadId,
        );
        const session = await runtime.startSession({
          threadId,
          model: replay.model,
          ...(replay.modelOptions === undefined ? {} : { modelOptions: replay.modelOptions }),
          ...(replay.runtimeMode === undefined ? {} : { runtimeMode: replay.runtimeMode }),
        });
        expect(session).toMatchObject({
          threadId,
          provider: providerRuntimeKindInfo(kind).driverKind,
        });
        await runtime.sendTurn({ threadId, input: SIMPLE_PROMPT });
        await expect(completed).resolves.toMatchObject({ payload: { state: "completed" } });
      } finally {
        await runtime.close();
      }
      const lines = (await NodeFSP.readFile(eventLogPath, "utf8")).trim().split("\n");
      expect(JSON.parse(lines[0] ?? "null")).toMatchObject({
        type: "meta",
        kind,
        model: replay.model,
        cwd,
      });
      expect(lines.slice(1).map((line) => JSON.parse(line).type)).toContain("turn.completed");
    },
  );

  it("antigravity starts a session against T3's ACP mock agent", async () => {
    const cwd = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-runtime-antigravity-"));
    directories.push(cwd);
    const runtime = await openProviderRuntime(
      { provider: "antigravity", cwd },
      antigravityMockDriver,
    );
    const threadId = ThreadId.make("thread-antigravity");
    try {
      await expect(
        runtime.startSession({ threadId, model: "gemini-test-low" }),
      ).resolves.toMatchObject({ threadId, provider: "antigravity" });
      await expect(runtime.hasSession(threadId)).resolves.toBe(true);
    } finally {
      await runtime.close();
    }
  });
});
