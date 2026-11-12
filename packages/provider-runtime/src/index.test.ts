// @effect-diagnostics nodeBuiltinImport:off - This test verifies the Promise-based Node host boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createProviderRuntime, type ProviderRuntimeKind } from "./index.ts";

/** A Codex app-server stand-in that records each request method and its params. */
const fakeCodexSource = (logPath: string) => `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const results = {
  initialize: { userAgent: "fake", codexHome: "/tmp/codex-home", platformFamily: "unix", platformOs: "linux" },
  "skills/extraRoots/set": {},
  "thread/start": {
    thread: {
      id: "native-thread", sessionId: "native-thread", forkedFromId: null, preview: "", ephemeral: false,
      modelProvider: "openai", createdAt: 1782622440, updatedAt: 1782622440, status: { type: "idle" },
      path: "/tmp/native-thread.jsonl", cwd: "/workspace", cliVersion: "0.167.0", source: "vscode",
      threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: null, projectId: null, turns: [],
    },
    model: "gpt-5.4", modelProvider: "openai", serviceTier: null, cwd: "/workspace", instructionSources: [],
    approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false }, reasoningEffort: "medium",
  },
};
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ method: message.method, params: message.params }) + "\\n");
    if (message.id === undefined) continue;
    const result = results[message.method];
    process.stdout.write(JSON.stringify(result === undefined
      ? { id: message.id, error: { code: -32601, message: "unsupported" } }
      : { id: message.id, result }) + "\\n");
  }
});
`;

describe("createProviderRuntime", () => {
  it("owns and cleans isolated state for both embedded providers", async () => {
    for (const provider of ["codex", "claude-code"] satisfies ProviderRuntimeKind[]) {
      const runtime = await createProviderRuntime({ provider });
      const stateDirectory = NodePath.resolve(runtime.attachmentsDirectory, "../..");

      await expect(runtime.listSessions()).resolves.toEqual([]);
      await expect(NodeFSP.access(stateDirectory)).resolves.toBeUndefined();

      await runtime.close();
      await runtime.close();

      await expect(NodeFSP.access(stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(runtime.listSessions()).rejects.toThrow("T3 provider runtime is closed");
    }
  });

  it("gives a Codex session its skill roots before the thread starts", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-skill-roots-"));
    const logPath = NodePath.join(directory, "requests.jsonl");
    const binaryPath = NodePath.join(directory, "codex");
    await NodeFSP.writeFile(binaryPath, fakeCodexSource(logPath), { mode: 0o755 });
    const skillRoot = NodePath.join(directory, "skills");
    const runtime = await createProviderRuntime({
      provider: "codex",
      cwd: directory,
      settings: { binaryPath },
    });
    try {
      await runtime.startSession({
        threadId: ThreadId.make("thread-skill-roots"),
        skillRoots: [skillRoot],
      });
      const requests = (await NodeFSP.readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method: string; params?: unknown });
      expect(requests.map((request) => request.method)).toEqual([
        "initialize",
        "initialized",
        "skills/extraRoots/set",
        "thread/start",
      ]);
      expect(requests[2]?.params).toEqual({ extraRoots: [skillRoot] });
    } finally {
      await runtime.close();
      await NodeFSP.rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects skill roots for a Claude Code session", async () => {
    const runtime = await createProviderRuntime({ provider: "claude-code" });
    try {
      await expect(
        runtime.startSession({
          threadId: ThreadId.make("thread-claude"),
          skillRoots: ["/tmp/skills"],
        }),
      ).rejects.toThrow("skillRoots are supported only for Codex sessions");
    } finally {
      await runtime.close();
    }
  });
});
