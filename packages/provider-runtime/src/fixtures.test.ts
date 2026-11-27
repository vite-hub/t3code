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
  return { meta, events: events.map((event) => decodeEvent(event)) };
}

describe("recorded fixtures", () => {
  // Recorded by scripts/record-fixture.ts: acp gemini-3.8-flash-high --agent-id gemini.
  it("gemini writes hello.txt, runs cat, and reports usage", async () => {
    const { meta, events } = await readFixture("gemini");
    expect(meta).toMatchObject({ type: "meta", kind: "acp", cwd: "<cwd>" });
    const completedItems = (itemType: string) =>
      events.filter(
        (event) => event.type === "item.completed" && event.payload.itemType === itemType,
      );

    const messages = completedItems("assistant_message");
    expect(messages).toHaveLength(1);

    const commands = completedItems("command_execution");
    expect(commands).toHaveLength(1);
    const command = commands[0]!;
    expect(command.type === "item.completed" && command.payload).toMatchObject({
      status: "completed",
      data: { output: "hi" },
    });
    // Gemini CLI reports no exit code over ACP; a completed command without one exited 0.
    expect(command.type === "item.completed" && command.payload.data).not.toHaveProperty(
      "exitCode",
    );

    const fileChanges = completedItems("file_change");
    expect(fileChanges).toHaveLength(1);
    expect(JSON.stringify(fileChanges[0])).toContain("hello.txt");

    const completed = events.find((event) => event.type === "turn.completed");
    expect(completed?.type === "turn.completed" && completed.payload.state).toBe("completed");
    const usage = completed?.type === "turn.completed" ? completed.payload.tokenUsage : undefined;
    expect(usage?.usageStatus).toBe("complete");
    expect((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)).toBeGreaterThan(0);
  });
});
