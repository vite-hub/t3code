// @effect-diagnostics nodeBuiltinImport:off - The test reads a recorded fixture from disk.
import * as NodeFSP from "node:fs/promises";

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProviderRuntimeEvent } from "./legacy-contracts.ts";

const decodeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

type CommandData = { command?: string; output?: string; exitCode?: number };

// Every fixture records the prompt "Write hello.txt containing the word hi, then run cat hello.txt."
// and must replay as one completed turn that wrote hello.txt, printed hi, and answered.
async function replayHelloTurn(name: string) {
  const text = await NodeFSP.readFile(
    new URL(`../fixtures/${name}.events.jsonl`, import.meta.url),
    "utf8",
  );
  const [meta, ...lines] = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const events = lines.map((line) => decodeEvent(line));
  const completedItems = (itemType: string) =>
    events.flatMap((event) =>
      event.type === "item.completed" && event.payload.itemType === itemType ? [event.payload] : [],
    );

  const messages = completedItems("assistant_message");
  expect(messages.length).toBeGreaterThan(0);

  const fileChanges = completedItems("file_change");
  expect(fileChanges).toHaveLength(1);
  expect(JSON.stringify(fileChanges[0])).toContain("hello.txt");

  const commands = completedItems("command_execution").map((item) => ({
    status: item.status,
    data: item.data as CommandData,
  }));
  const cat = commands.find(
    (command) => command.status === "completed" && command.data.output?.trim().endsWith("hi"),
  );
  expect(cat).toBeDefined();

  const turns = events.flatMap((event) => (event.type === "turn.completed" ? [event.payload] : []));
  expect(turns).toHaveLength(1);
  expect(turns[0]!.state).toBe("completed");
  const threadUsage = events.flatMap((event) =>
    event.type === "thread.token-usage.updated" ? [event.payload.usage] : [],
  );
  return { meta, messages, commands, cat: cat!.data, turn: turns[0]!, threadUsage };
}

function expectTurnUsage(turn: Awaited<ReturnType<typeof replayHelloTurn>>["turn"]) {
  expect(turn.tokenUsage?.usageStatus).toBe("complete");
  expect(
    (turn.tokenUsage?.inputTokens ?? 0) + (turn.tokenUsage?.outputTokens ?? 0),
  ).toBeGreaterThan(0);
}

// Recorded by scripts/record-fixture.ts; fixtures/README.md lists each harness's model and route.
describe("recorded fixtures", () => {
  it("gemini writes hello.txt, runs cat, and reports usage", async () => {
    const turn = await replayHelloTurn("gemini");
    expect(turn.meta).toMatchObject({ type: "meta", kind: "acp", cwd: "<cwd>" });
    expect(turn.messages).toHaveLength(1);
    expect(turn.commands).toHaveLength(1);
    expect(turn.cat.output).toBe("hi");
    // Gemini CLI reports no exit code over ACP; a completed command without one exited 0.
    expect(turn.cat).not.toHaveProperty("exitCode");
    expectTurnUsage(turn.turn);
  });

  it("antigravity writes hello.txt, runs cat, and reports exit code and usage", async () => {
    const turn = await replayHelloTurn("antigravity");
    expect(turn.meta).toMatchObject({ type: "meta", kind: "antigravity", cwd: "<cwd>" });
    expect(turn.messages).toHaveLength(1);
    expect(turn.commands).toHaveLength(1);
    // agy prefixes the output with timestamps and "Command exited with code 0.".
    expect(turn.cat.exitCode).toBe(0);
    expectTurnUsage(turn.turn);
  });

  it("opencode writes hello.txt, runs cat, and reports exit code and usage", async () => {
    const turn = await replayHelloTurn("opencode");
    expect(turn.meta).toMatchObject({ type: "meta", kind: "opencode", cwd: "<cwd>" });
    expect(turn.messages).toHaveLength(1);
    expect(turn.commands).toHaveLength(1);
    expect(turn.cat).toMatchObject({ output: "hi\n", exitCode: 0 });
    expectTurnUsage(turn.turn);
  });

  it("pi writes hello.txt, runs cat, and reports usage per model call", async () => {
    const turn = await replayHelloTurn("pi");
    expect(turn.meta).toMatchObject({ type: "meta", kind: "pi", cwd: "<cwd>" });
    expect(turn.messages).toHaveLength(1);
    expect(turn.commands).toHaveLength(1);
    expect(turn.cat).toMatchObject({ output: "hi\n", exitCode: 0 });
    // Pi reports usage as thread token-usage updates, not on turn.completed.
    expect(turn.turn.tokenUsage).toBeUndefined();
    expect(turn.threadUsage.at(-1)?.usedTokens).toBeGreaterThan(0);
  });

  it("kimi code recovers from a cat that ran before the write, and reports no usage", async () => {
    const turn = await replayHelloTurn("kimi-code");
    expect(turn.meta).toMatchObject({ type: "meta", kind: "acp", cwd: "<cwd>" });
    // The first cat raced the write and failed; the retry printed hi. ACP carries no exit code.
    expect(turn.commands.map((command) => command.status)).toEqual(["failed", "completed"]);
    expect(turn.commands[0]!.data.output).toContain("exit code: 1");
    expect(turn.cat).not.toHaveProperty("exitCode");
    expect(turn.turn.tokenUsage?.usageStatus).toBe("unavailable");
    expect(turn.threadUsage).toHaveLength(0);
  });
});
