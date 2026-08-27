import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createRuntimeModelSelection, withRuntimeModelSelection } from "./model-options.ts";

describe("provider runtime model options", () => {
  it("attaches model options to the selected embedded provider model", () => {
    expect(
      createRuntimeModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", {
        reasoningEffort: "high",
        reasoningSummary: "detailed",
      }),
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "reasoningSummary", value: "detailed" },
      ],
    });
  });

  it("inherits session model options without replacing explicit turn selections", () => {
    const sessionSelection = createRuntimeModelSelection(
      ProviderInstanceId.make("codex"),
      "gpt-5.4",
      { reasoningEffort: "high" },
    );
    const explicitSelection = createRuntimeModelSelection(
      ProviderInstanceId.make("codex"),
      "gpt-5.4-mini",
      { reasoningEffort: "low" },
    );
    const input = { input: "hello", threadId: ThreadId.make("thread-1") };

    expect(withRuntimeModelSelection(input, sessionSelection).modelSelection).toBe(
      sessionSelection,
    );
    expect(
      withRuntimeModelSelection({ ...input, modelSelection: explicitSelection }, sessionSelection)
        .modelSelection,
    ).toBe(explicitSelection);
  });
});
