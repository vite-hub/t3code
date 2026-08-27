import type * as ClaudeAgentSdk from "@anthropic-ai/claude-agent-sdk";

const CLAUDE_AGENT_SDK_PACKAGE = ["@anthropic-ai", "claude-agent-sdk"].join(
  String.fromCharCode(47),
);

export function importClaudeAgentSdk(): Promise<typeof ClaudeAgentSdk> {
  return import(/* @vite-ignore */ CLAUDE_AGENT_SDK_PACKAGE) as Promise<typeof ClaudeAgentSdk>;
}
