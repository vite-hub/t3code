// @effect-diagnostics nodeBuiltinImport:off - The test reads a recorded fixture from disk.
import * as NodeFSP from "node:fs/promises";

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProviderRuntimeEvent } from "./legacy-contracts.ts";

const decodeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

async function readFixture(name: string) {
  const text = await NodeFSP.readFile(
    new URL(`../fixtures/${name}.events.jsonl`, import.meta.url),
    "utf8",
  );
  const [meta, ...events] = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const decoded = events.map((event) => decodeEvent(event));
  const completedItems = (itemType: string) =>
    decoded.flatMap((event) =>
      event.type === "item.completed" && event.payload.itemType === itemType ? [event.payload] : [],
    );
  const turnCompleted = decoded.flatMap((event) =>
    event.type === "turn.completed" ? [event.payload] : [],
  );
  return { meta, completedItems, turnCompleted };
}

// Every fixture records the prompt "Write hello.txt containing the word hi, then run cat hello.txt."
async function expectHelloTurn(name: string) {
  const fixture = await readFixture(name);
  expect(fixture.completedItems("assistant_message")).toHaveLength(1);

  const fileChanges = fixture.completedItems("file_change");
  expect(fileChanges).toHaveLength(1);
  expect(JSON.stringify(fileChanges[0])).toContain("hello.txt");

  const commands = fixture.completedItems("command_execution");
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({ status: "completed" });

  expect(fixture.turnCompleted).toHaveLength(1);
  const turn = fixture.turnCompleted[0]!;
  expect(turn.state).toBe("completed");
  expect(turn.tokenUsage?.usageStatus).toBe("complete");
  expect(
    (turn.tokenUsage?.inputTokens ?? 0) + (turn.tokenUsage?.outputTokens ?? 0),
  ).toBeGreaterThan(0);
  return { meta: fixture.meta, command: commands[0]! };
}

describe("recorded fixtures", () => {
  // Recorded by scripts/record-fixture.ts: acp gemini-3.8-flash-high --agent-id gemini.
  it("gemini writes hello.txt, runs cat, and reports usage", async () => {
    const { meta, command } = await expectHelloTurn("gemini");
    expect(meta).toMatchObject({ type: "meta", kind: "acp", cwd: "<cwd>" });
    expect(command.data).toMatchObject({ output: "hi" });
    // Gemini CLI reports no exit code over ACP; a completed command without one exited 0.
    expect(command.data).not.toHaveProperty("exitCode");
  });

  // Recorded by scripts/record-fixture.ts: antigravity gemini-3.8-flash-high, with a copy of
  // T3's Antigravity login as --state and the agy binary as --settings '{"binaryPath":...}'.
  it("antigravity writes hello.txt, runs cat, and reports exit code and usage", async () => {
    const { meta, command } = await expectHelloTurn("antigravity");
    expect(meta).toMatchObject({ type: "meta", kind: "antigravity", cwd: "<cwd>" });
    // agy prefixes the output with timestamps and "Command exited with code 0.".
    const data = command.data as { output?: string; exitCode?: number };
    expect(data.output?.trim().endsWith("hi")).toBe(true);
    expect(data.exitCode).toBe(0);
  });
});
