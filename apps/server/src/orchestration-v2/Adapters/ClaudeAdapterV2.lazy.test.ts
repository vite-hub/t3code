import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  throw new Error("Claude SDK loaded eagerly.");
});

describe("ClaudeAdapterV2 module loading", () => {
  it("does not load the Claude SDK while importing the adapter", async () => {
    await expect(import("./ClaudeAdapterV2.ts")).resolves.toMatchObject({
      ClaudeAdapterV2Driver: expect.any(Object),
      claudeAgentSdkQueryRunnerLiveLayer: expect.anything(),
    });
  });
});
