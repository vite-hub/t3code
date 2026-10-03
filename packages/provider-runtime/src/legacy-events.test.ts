import {
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  MessageId,
  NodeId,
  PlanId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderAdapterV2Event } from "../../../apps/server/src/orchestration-v2/ProviderAdapter.ts";
import { createLegacyRun, LegacyEventTranslator } from "./legacy-events.ts";

const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");
const threadId = ThreadId.make("thread:test");
const providerThreadId = ProviderThreadId.make("provider-thread:test");
const providerTurnId = ProviderTurnId.make("provider-turn:test");
const runId = RunId.make("run:test:1");
const attemptId = RunAttemptId.make("run-attempt:test:1");
const rootNodeId = NodeId.make("node:root");
const now = DateTime.makeUnsafe(0);

function makeTranslator() {
  const threads: OrchestrationV2ProviderThread[] = [];
  const translator = new LegacyEventTranslator({
    driver,
    providerInstanceId,
    threadId,
    providerThreadId,
    onProviderThread: (thread) => threads.push(thread),
  });
  const run = createLegacyRun({ runId, attemptId, rootNodeId, ordinal: 1 });
  translator.registerRun(run);
  return { translator, run, threads };
}

function providerTurn(status: OrchestrationV2ProviderTurn["status"]): ProviderAdapterV2Event {
  return {
    type: "provider_turn.updated",
    driver,
    providerTurn: {
      id: providerTurnId,
      providerThreadId,
      nodeId: rootNodeId,
      runAttemptId: attemptId,
      nativeTurnRef: null,
      ordinal: 1,
      status,
      startedAt: now,
      completedAt: null,
      tokenUsage: {
        usedTokens: 120,
        inputTokens: 100,
        outputTokens: 20,
        updatedAt: "1970-01-01T00:00:00.000Z",
      },
    },
  };
}

const itemBase = {
  threadId,
  runId,
  nodeId: NodeId.make("node:item"),
  providerThreadId,
  providerTurnId,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  title: null,
  startedAt: now,
  completedAt: null,
  updatedAt: now,
} as const;

function turnItem(item: OrchestrationV2TurnItem): ProviderAdapterV2Event {
  return { type: "turn_item.updated", driver, turnItem: item };
}

describe("LegacyEventTranslator", () => {
  it("maps provider turns to turn.started, token usage, and turn.completed", () => {
    const { translator, run } = makeTranslator();
    const started = translator.translate(providerTurn("running"));
    expect(started.map((event) => event.type)).toEqual([
      "turn.started",
      "thread.token-usage.updated",
    ]);
    expect(started.every((event) => event.turnId === run.turnId)).toBe(true);
    expect(run.providerTurnId).toBe(providerTurnId);

    expect(translator.translate(providerTurn("running"))).toEqual([]);

    const completed = translator.translate({
      type: "turn.terminal",
      driver,
      providerThreadId,
      providerTurnId,
      runOrdinal: 1,
      status: "completed",
      failure: null,
      threadDisposition: "reusable",
    });
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      type: "turn.completed",
      turnId: run.turnId,
      payload: { state: "completed" },
    });
    expect(translator.activeRun).toBeUndefined();
  });

  it("reports failures and interruptions through the legacy turn events", () => {
    const { translator, run } = makeTranslator();
    translator.translate(providerTurn("running"));
    const failed = translator.translate({
      type: "turn.terminal",
      driver,
      providerThreadId,
      providerTurnId,
      runOrdinal: 1,
      failureItemOrdinal: 2,
      status: "failed",
      failure: { class: "provider_error", message: "boom", code: null, retryable: null },
      threadDisposition: "reusable",
    });
    expect(failed[0]).toMatchObject({
      type: "turn.completed",
      turnId: run.turnId,
      payload: { state: "failed", errorMessage: "boom" },
    });

    const second = makeTranslator();
    second.translator.translate(providerTurn("running"));
    const aborted = second.translator.translate({
      type: "turn.terminal",
      driver,
      providerThreadId,
      providerTurnId,
      runOrdinal: 1,
      status: "interrupted",
      failure: null,
      threadDisposition: "reusable",
    });
    expect(aborted[0]).toMatchObject({ type: "turn.aborted", payload: { reason: "interrupted" } });
  });

  it("streams assistant text as deltas and completes the item once", () => {
    const { translator, run } = makeTranslator();
    const id = TurnItemId.make("turn-item:assistant");
    const messageId = MessageId.make("message:assistant");
    const first = translator.translate(
      turnItem({
        ...itemBase,
        id,
        type: "assistant_message",
        messageId,
        text: "Hel",
        streaming: true,
        status: "running",
      }),
    );
    expect(first.map((event) => event.type)).toEqual(["item.started", "content.delta"]);
    expect(first[1]).toMatchObject({
      turnId: run.turnId,
      payload: { streamKind: "assistant_text", delta: "Hel" },
    });
    const second = translator.translate(
      turnItem({
        ...itemBase,
        id,
        type: "assistant_message",
        messageId,
        text: "Hello",
        streaming: true,
        status: "running",
      }),
    );
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ payload: { delta: "lo" } });
    const done = translator.translate(
      turnItem({
        ...itemBase,
        id,
        type: "assistant_message",
        messageId,
        text: "Hello",
        streaming: false,
        status: "completed",
      }),
    );
    expect(done.map((event) => event.type)).toEqual(["item.completed"]);
    expect(done[0]).toMatchObject({
      payload: { itemType: "assistant_message", status: "completed", data: { text: "Hello" } },
    });
    expect(
      translator.translate(
        turnItem({
          ...itemBase,
          id,
          type: "assistant_message",
          messageId,
          text: "Hello",
          streaming: false,
          status: "completed",
        }),
      ),
    ).toEqual([]);
  });

  it("reports MCP and native tool items with their inputs and outputs", () => {
    const { translator } = makeTranslator();
    const id = TurnItemId.make("turn-item:tool");
    const started = translator.translate(
      turnItem({
        ...itemBase,
        id,
        type: "dynamic_tool",
        toolName: "mcp__t3__search",
        input: { q: "x" },
        status: "running",
      }),
    );
    expect(started[0]).toMatchObject({
      type: "item.started",
      itemId: id,
      payload: {
        itemType: "mcp_tool_call",
        status: "inProgress",
        data: { toolName: "mcp__t3__search", input: { q: "x" } },
      },
    });
    const completed = translator.translate(
      turnItem({
        ...itemBase,
        id,
        type: "dynamic_tool",
        toolName: "mcp__t3__search",
        input: { q: "x" },
        output: { hits: 1 },
        status: "completed",
      }),
    );
    expect(completed.map((event) => event.type)).toEqual(["item.completed"]);
    expect(completed[0]).toMatchObject({
      payload: { status: "completed", data: { result: { hits: 1 } } },
    });

    const command = translator.translate(
      turnItem({
        ...itemBase,
        id: TurnItemId.make("turn-item:cmd"),
        type: "command_execution",
        input: "ls",
        output: "a",
        exitCode: 0,
        status: "completed",
      }),
    );
    expect(command.map((event) => event.type)).toEqual(["item.started", "item.completed"]);
    expect(command[1]).toMatchObject({
      payload: { itemType: "command_execution", title: "ls", data: { command: "ls", output: "a" } },
    });
  });

  it("opens approvals with the tool arguments and resolves them with the decision", () => {
    const { translator, run } = makeTranslator();
    const toolNodeId = NodeId.make("node:tool");
    const approvalNodeId = NodeId.make("node:approval");
    const requestId = RuntimeRequestId.make("runtime-request:1");
    translator.translate(
      turnItem({
        ...itemBase,
        id: TurnItemId.make("turn-item:tool"),
        nodeId: toolNodeId,
        type: "command_execution",
        input: "rm -rf dist",
        status: "waiting",
      }),
    );
    const node: OrchestrationV2ExecutionNode = {
      id: approvalNodeId,
      threadId,
      runId,
      parentNodeId: toolNodeId,
      rootNodeId,
      kind: "approval_request",
      status: "waiting",
      countsForRun: false,
      providerThreadId,
      providerTurnId,
      nativeItemRef: null,
      runtimeRequestId: requestId,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    };
    expect(translator.translate({ type: "node.updated", driver, node })).toEqual([]);
    const request: OrchestrationV2RuntimeRequest = {
      id: requestId,
      nodeId: approvalNodeId,
      providerTurnId,
      nativeRequestRef: null,
      kind: "command",
      status: "pending",
      responseCapability: {
        type: "live",
        providerSessionId: ProviderSessionId.make("provider-session:1"),
      },
      createdAt: now,
      resolvedAt: null,
    };
    expect(
      translator.translate({ type: "runtime_request.updated", driver, runtimeRequest: request }),
    ).toEqual([]);
    const opened = translator.translate(
      turnItem({
        ...itemBase,
        id: TurnItemId.make("turn-item:approval"),
        nodeId: approvalNodeId,
        type: "approval_request",
        requestId,
        requestKind: "command",
        prompt: "Run rm?",
        status: "waiting",
      }),
    );
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      type: "request.opened",
      requestId,
      turnId: run.turnId,
      payload: {
        requestType: "command_execution_approval",
        detail: "Run rm?",
        args: { command: "rm -rf dist" },
      },
    });
    const resolved = translator.translate({
      type: "runtime_request.updated",
      driver,
      runtimeRequest: { ...request, status: "resolved", resolvedAt: now, decision: "accept" },
    });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      type: "request.resolved",
      requestId,
      payload: { decision: "accept" },
    });
  });

  it("maps user input requests to the legacy question events", () => {
    const { translator } = makeTranslator();
    const requestId = RuntimeRequestId.make("runtime-request:2");
    const nodeId = NodeId.make("node:question");
    translator.translate({
      type: "runtime_request.updated",
      driver,
      runtimeRequest: {
        id: requestId,
        nodeId,
        providerTurnId,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: {
          type: "live",
          providerSessionId: ProviderSessionId.make("provider-session:1"),
        },
        createdAt: now,
        resolvedAt: null,
      },
    });
    const requested = translator.translate(
      turnItem({
        ...itemBase,
        id: TurnItemId.make("turn-item:question"),
        nodeId,
        type: "user_input_request",
        requestId,
        questions: [
          {
            id: "q1",
            header: "Pick",
            question: "Which?",
            options: [{ label: "A", description: "first" }],
          },
        ],
        status: "waiting",
      }),
    );
    expect(requested[0]).toMatchObject({
      type: "user-input.requested",
      requestId,
      payload: {
        questions: [{ id: "q1", header: "Pick", question: "Which?", multiSelect: false }],
      },
    });
  });

  it("turns todo lists into plan updates and retries into recoverable warnings", () => {
    const { translator, run } = makeTranslator();
    const plan = translator.translate(
      turnItem({
        ...itemBase,
        id: TurnItemId.make("turn-item:todo"),
        type: "todo_list",
        planId: PlanId.make("plan:1"),
        steps: [{ id: "s1", text: "Build", status: "running" }],
        status: "running",
      }),
    );
    expect(plan[0]).toMatchObject({
      type: "turn.plan.updated",
      turnId: run.turnId,
      payload: { plan: [{ step: "Build", status: "inProgress" }] },
    });
    const retry = translator.translate(
      turnItem({
        ...itemBase,
        id: TurnItemId.make("turn-item:retry"),
        type: "error",
        failure: { class: "provider_error", message: "overloaded", code: null, retryable: true },
        retry: { attempt: 1, maxAttempts: 3, retryDelayMs: 1000 },
        status: "running",
      }),
    );
    expect(retry).toHaveLength(1);
    expect(retry[0]).toMatchObject({ type: "runtime.warning", payload: { message: "overloaded" } });
  });

  it("tracks the session's provider thread and reports stream failures as exits", () => {
    const { translator, threads } = makeTranslator();
    const thread: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver,
      providerInstanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: { driver, nativeId: "native-1", strength: "strong" },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      contextUsage: null,
      nativeMetadata: null,
      createdAt: now,
      updatedAt: now,
    };
    expect(
      translator.translate({ type: "provider_thread.updated", driver, providerThread: thread }),
    ).toEqual([]);
    expect(
      translator.translate({
        type: "provider_thread.updated",
        driver,
        providerThread: { ...thread, id: ProviderThreadId.make("provider-thread:other") },
      }),
    ).toEqual([]);
    expect(threads).toHaveLength(1);
    expect(translator.sessionExited("process died", "error")).toMatchObject({
      type: "session.exited",
      payload: { reason: "process died", exitKind: "error", recoverable: false },
    });
    expect(translator.activeRun).toBeUndefined();
  });
});
