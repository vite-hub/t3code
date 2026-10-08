// @effect-diagnostics nodeBuiltinImport:off globalDate:off - This package exposes a Promise-based Node host boundary.
import * as NodeCrypto from "node:crypto";

import {
  EventId,
  type NodeId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderTurnId,
  type RunAttemptId,
  type RunId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  type ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
  type TurnTokenUsage,
} from "@t3tools/contracts";

import type { ProviderAdapterV2Event } from "../../../apps/server/src/orchestration-v2/ProviderAdapter.ts";

/**
 * One embedded turn. The host sees a stable `turnId`; the provider reports its
 * own turn id later through `provider_turn.updated`, so interruption waits for it.
 */
export interface LegacyRun {
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly rootNodeId: NodeId;
  readonly ordinal: number;
  readonly turnId: TurnId;
  readonly providerTurn: Promise<ProviderTurnId>;
  providerTurnId: ProviderTurnId | undefined;
  started: boolean;
  terminal: boolean;
  tokenUsage: TurnTokenUsage | undefined;
  lastUsageSignature: string | undefined;
  resolveProviderTurn: (providerTurnId: ProviderTurnId) => void;
}

export function createLegacyRun(input: {
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly rootNodeId: NodeId;
  readonly ordinal: number;
}): LegacyRun {
  let resolveProviderTurn!: (providerTurnId: ProviderTurnId) => void;
  const providerTurn = new Promise<ProviderTurnId>((resolve) => {
    resolveProviderTurn = resolve;
  });
  return {
    ...input,
    turnId: TurnId.make(input.runId),
    providerTurn,
    providerTurnId: undefined,
    started: false,
    terminal: false,
    tokenUsage: undefined,
    lastUsageSignature: undefined,
    resolveProviderTurn,
  };
}

type LegacyEventType = ProviderRuntimeEvent["type"];
type LegacyEventOf<T extends LegacyEventType> = Extract<ProviderRuntimeEvent, { readonly type: T }>;
type LegacyItemPayload = LegacyEventOf<"item.started">["payload"];
type LegacyItemType = LegacyItemPayload["itemType"];
type LegacyItemStatus = NonNullable<LegacyItemPayload["status"]>;
type LegacyRequestType = LegacyEventOf<"request.opened">["payload"]["requestType"];
type LegacyPlanStepStatus = LegacyEventOf<"turn.plan.updated">["payload"]["plan"][number]["status"];

interface LegacyEventRefs {
  readonly threadId?: ThreadId;
  readonly turnId?: TurnId;
  readonly itemId?: RuntimeItemId;
  readonly requestId?: RuntimeRequestId;
}

interface TrackedItem {
  item: OrchestrationV2TurnItem;
  started: boolean;
  completed: boolean;
  text: string;
}

interface TrackedRequest {
  request: OrchestrationV2RuntimeRequest | undefined;
  item:
    | Extract<OrchestrationV2TurnItem, { readonly type: "approval_request" | "user_input_request" }>
    | undefined;
  opened: boolean;
  resolved: boolean;
}

interface TrackedSubagent {
  started: boolean;
  completed: boolean;
}

export interface LegacyEventTranslatorOptions {
  readonly driver: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly providerThreadId: OrchestrationV2ProviderThread["id"];
  /** Receives the provider thread rows that carry this session's resume state. */
  readonly onProviderThread: (providerThread: OrchestrationV2ProviderThread) => void;
}

const TERMINAL_ITEM_STATUSES: ReadonlySet<OrchestrationV2TurnItem["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

const TERMINAL_SUBAGENT_STATUSES: ReadonlySet<OrchestrationV2Subagent["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

function legacyItemStatus(status: OrchestrationV2TurnItem["status"]): LegacyItemStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "interrupted":
      return "failed";
    case "cancelled":
      return "declined";
    default:
      return "inProgress";
  }
}

function legacyRequestType(
  kind: OrchestrationV2RuntimeRequest["kind"] | undefined,
): LegacyRequestType {
  switch (kind) {
    case "command":
      return "command_execution_approval";
    case "file-read":
      return "file_read_approval";
    case "file-change":
      return "file_change_approval";
    case "mcp-elicitation":
      return "mcp_elicitation_approval";
    case "permission":
      return "permission_approval";
    case "user_input":
      return "tool_user_input";
    case "dynamic_tool_call":
      return "dynamic_tool_call";
    case "auth_refresh":
      return "auth_tokens_refresh";
    default:
      return "unknown";
  }
}

function legacyPlanStepStatus(status: "pending" | "running" | "completed"): LegacyPlanStepStatus {
  return status === "running" ? "inProgress" : status;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return value !== null && value !== undefined && value.trim().length > 0 ? value : undefined;
}

function textDelta(previous: string, next: string): string {
  if (next.length === 0 || next === previous) return "";
  return next.startsWith(previous) ? next.slice(previous.length) : next;
}

function toolArgumentsFromItem(item: OrchestrationV2TurnItem | undefined): unknown {
  switch (item?.type) {
    case "dynamic_tool":
      return item.input;
    case "command_execution":
      return { command: item.input };
    case "file_change":
      return {
        fileName: item.fileName,
        ...(item.diffStr === undefined ? {} : { diff: item.diffStr }),
      };
    default:
      return undefined;
  }
}

/**
 * Translates orchestration-v2 adapter events into the flat `ProviderRuntimeEvent`
 * stream that embedded hosts consume. The translator owns the run registry for one
 * provider session so item, request, and turn events resolve to the host's turn ids.
 */
export class LegacyEventTranslator {
  readonly #options: LegacyEventTranslatorOptions;
  readonly #runsById = new Map<RunId, LegacyRun>();
  readonly #runsByAttemptId = new Map<RunAttemptId, LegacyRun>();
  readonly #runsByProviderTurnId = new Map<ProviderTurnId, LegacyRun>();
  readonly #nodes = new Map<NodeId, OrchestrationV2ExecutionNode>();
  readonly #items = new Map<OrchestrationV2TurnItem["id"], TrackedItem>();
  readonly #itemsByNodeId = new Map<NodeId, OrchestrationV2TurnItem>();
  readonly #requests = new Map<OrchestrationV2RuntimeRequest["id"], TrackedRequest>();
  readonly #subagents = new Map<NodeId, TrackedSubagent>();
  #activeRun: LegacyRun | undefined;

  constructor(options: LegacyEventTranslatorOptions) {
    this.#options = options;
  }

  get activeRun(): LegacyRun | undefined {
    return this.#activeRun !== undefined && !this.#activeRun.terminal ? this.#activeRun : undefined;
  }

  registerRun(run: LegacyRun): void {
    this.#runsById.set(run.runId, run);
    this.#runsByAttemptId.set(run.attemptId, run);
    this.#activeRun = run;
  }

  abandonRun(run: LegacyRun): void {
    run.terminal = true;
    this.#runsById.delete(run.runId);
    this.#runsByAttemptId.delete(run.attemptId);
    if (run.providerTurnId !== undefined) this.#runsByProviderTurnId.delete(run.providerTurnId);
    if (this.#activeRun === run) this.#activeRun = undefined;
  }

  runForTurnId(turnId: TurnId): LegacyRun | undefined {
    for (const run of this.#runsById.values()) {
      if (run.turnId === turnId) return run;
    }
    return undefined;
  }

  translate(event: ProviderAdapterV2Event): ProviderRuntimeEvent[] {
    switch (event.type) {
      case "provider_thread.updated":
        if (event.providerThread.id === this.#options.providerThreadId) {
          this.#options.onProviderThread(event.providerThread);
        }
        return [];
      case "provider_session.updated":
        return this.#translateSession(event.providerSession);
      case "provider_turn.updated":
        return this.#translateProviderTurn(event.providerTurn);
      case "node.updated":
        this.#nodes.set(event.node.id, event.node);
        return [];
      case "turn_item.updated":
        return this.#translateTurnItem(event.turnItem);
      case "runtime_request.updated":
        return this.#translateRuntimeRequest(event.runtimeRequest);
      case "subagent.updated":
        return this.#translateSubagent(event.subagent);
      case "turn.terminal":
        return this.#translateTerminal(event);
      case "app_thread.created":
      case "message.updated":
      case "plan.updated":
        return [];
    }
  }

  /** Reports a failed provider event stream as a session exit. */
  sessionExited(reason: string, exitKind: "graceful" | "error"): ProviderRuntimeEvent {
    for (const run of this.#runsById.values()) run.terminal = true;
    this.#activeRun = undefined;
    return this.#event("session.exited", {
      ...(nonEmpty(reason) === undefined ? {} : { reason }),
      recoverable: false,
      exitKind,
    });
  }

  #event<T extends LegacyEventType>(
    type: T,
    payload: LegacyEventOf<T>["payload"],
    refs: LegacyEventRefs = {},
  ): ProviderRuntimeEvent {
    const event = {
      eventId: EventId.make(NodeCrypto.randomUUID()),
      provider: this.#options.driver,
      providerInstanceId: this.#options.providerInstanceId,
      threadId: refs.threadId ?? this.#options.threadId,
      createdAt: new Date().toISOString(),
      ...(refs.turnId === undefined ? {} : { turnId: refs.turnId }),
      ...(refs.itemId === undefined ? {} : { itemId: refs.itemId }),
      ...(refs.requestId === undefined ? {} : { requestId: refs.requestId }),
      type,
      payload,
    };
    // SAFETY: `payload` is typed from the union member selected by `type`.
    return event as unknown as LegacyEventOf<T>;
  }

  #runForItem(runId: RunId | null): LegacyRun | undefined {
    return (runId === null ? undefined : this.#runsById.get(runId)) ?? this.activeRun;
  }

  #refs(run: LegacyRun | undefined, extra: Omit<LegacyEventRefs, "turnId"> = {}): LegacyEventRefs {
    return { ...(run === undefined ? {} : { turnId: run.turnId }), ...extra };
  }

  #translateSession(
    session: Extract<
      ProviderAdapterV2Event,
      { readonly type: "provider_session.updated" }
    >["providerSession"],
  ): ProviderRuntimeEvent[] {
    if (session.status === "error") {
      return [this.sessionExited(session.lastError ?? "Provider session failed.", "error")];
    }
    if (session.status === "stopped") {
      return [this.sessionExited(session.lastError ?? "", "graceful")];
    }
    return [];
  }

  #translateProviderTurn(turn: OrchestrationV2ProviderTurn): ProviderRuntimeEvent[] {
    const run =
      (turn.runAttemptId === null ? undefined : this.#runsByAttemptId.get(turn.runAttemptId)) ??
      this.#runsByProviderTurnId.get(turn.id);
    if (run === undefined) return [];
    const events: ProviderRuntimeEvent[] = [];
    if (run.providerTurnId === undefined) {
      run.providerTurnId = turn.id;
      this.#runsByProviderTurnId.set(turn.id, run);
      run.resolveProviderTurn(turn.id);
    }
    if (!run.started && turn.status === "running") {
      run.started = true;
      events.push(this.#event("turn.started", {}, this.#refs(run)));
    }
    if (turn.turnTokenUsage !== undefined) run.tokenUsage = turn.turnTokenUsage;
    if (turn.tokenUsage !== undefined) {
      const usage = turn.tokenUsage;
      const snapshot: ThreadTokenUsageSnapshot = {
        usedTokens: usage.usedTokens,
        ...(usage.maxTokens === undefined || usage.maxTokens === null || usage.maxTokens <= 0
          ? {}
          : { maxTokens: usage.maxTokens }),
        ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
        ...(usage.cachedInputTokens === undefined
          ? {}
          : { cachedInputTokens: usage.cachedInputTokens }),
        ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
        ...(usage.reasoningOutputTokens === undefined
          ? {}
          : { reasoningOutputTokens: usage.reasoningOutputTokens }),
      };
      const signature = JSON.stringify(snapshot);
      if (signature !== run.lastUsageSignature) {
        run.lastUsageSignature = signature;
        events.push(
          this.#event("thread.token-usage.updated", { usage: snapshot }, this.#refs(run)),
        );
      }
    }
    return events;
  }

  #translateTerminal(
    event: Extract<ProviderAdapterV2Event, { readonly type: "turn.terminal" }>,
  ): ProviderRuntimeEvent[] {
    const run = this.#runsByProviderTurnId.get(event.providerTurnId) ?? this.activeRun;
    if (run === undefined || run.terminal) return [];
    run.terminal = true;
    if (this.#activeRun === run) this.#activeRun = undefined;
    const refs = this.#refs(run);
    const tokenUsage = run.tokenUsage === undefined ? {} : { tokenUsage: run.tokenUsage };
    switch (event.status) {
      case "completed":
        return [this.#event("turn.completed", { state: "completed", ...tokenUsage }, refs)];
      case "interrupted":
      case "cancelled":
        return [this.#event("turn.aborted", { reason: event.status, ...tokenUsage }, refs)];
      case "failed":
        return [
          this.#event(
            "turn.completed",
            {
              state: "failed",
              errorMessage: nonEmpty(event.failure.message) ?? "Provider turn failed.",
              ...tokenUsage,
            },
            refs,
          ),
        ];
    }
  }

  #translateTurnItem(item: OrchestrationV2TurnItem): ProviderRuntimeEvent[] {
    if (item.nodeId !== null) this.#itemsByNodeId.set(item.nodeId, item);
    const run = this.#runForItem(item.runId);
    const refs = this.#refs(run, {
      itemId: RuntimeItemId.make(item.id),
      ...(item.threadId === this.#options.threadId ? {} : { threadId: item.threadId }),
    });
    switch (item.type) {
      case "assistant_message":
        return this.#translateStreamingItem(
          item,
          "assistant_message",
          "assistant_text",
          item.text,
          refs,
          {
            phase: "final",
          },
        );
      case "reasoning":
        return this.#translateStreamingItem(
          item,
          "reasoning",
          "reasoning_text",
          item.text,
          refs,
          {},
        );
      case "proposed_plan":
        return this.#translateStreamingItem(item, "plan", "plan_text", item.markdown, refs, {
          planId: item.planId,
        });
      case "dynamic_tool": {
        const toolName = item.toolName ?? undefined;
        const isMcpTool = toolName !== undefined && toolName.startsWith("mcp__");
        return this.#translateLifecycleItem(item, refs, {
          itemType: isMcpTool ? "mcp_tool_call" : "dynamic_tool_call",
          title: nonEmpty(item.title) ?? toolName,
          data: {
            ...(toolName === undefined ? {} : { toolName }),
            input: item.input,
            ...(item.output === undefined ? {} : { result: item.output, output: item.output }),
          },
        });
      }
      case "command_execution":
        return this.#translateLifecycleItem(item, refs, {
          itemType: "command_execution",
          title: nonEmpty(item.title) ?? nonEmpty(item.input),
          detail:
            item.exitCode === undefined || item.exitCode === 0
              ? undefined
              : `Exit code ${item.exitCode}`,
          data: {
            toolName: "command_execution",
            command: item.input,
            ...(item.output === undefined ? {} : { output: item.output }),
            ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }),
          },
        });
      case "file_change":
        return this.#translateLifecycleItem(item, refs, {
          itemType: "file_change",
          title: nonEmpty(item.title) ?? item.fileName,
          data: {
            toolName: "file_change",
            fileName: item.fileName,
            ...(item.additions === undefined ? {} : { additions: item.additions }),
            ...(item.deletions === undefined ? {} : { deletions: item.deletions }),
            ...(item.diffStr === undefined ? {} : { diff: item.diffStr }),
            ...(item.changes === undefined ? {} : { changes: item.changes }),
          },
        });
      case "file_search":
        return this.#translateLifecycleItem(item, refs, {
          itemType: "dynamic_tool_call",
          title: nonEmpty(item.title) ?? item.pattern,
          data: {
            toolName: "file_search",
            ...(item.pattern === undefined ? {} : { pattern: item.pattern }),
            ...(item.results === undefined ? {} : { results: item.results }),
          },
        });
      case "web_search":
        return this.#translateLifecycleItem(item, refs, {
          itemType: "web_search",
          title: nonEmpty(item.title) ?? item.patterns?.join(", "),
          data: {
            toolName: "web_search",
            ...(item.patterns === undefined ? {} : { patterns: item.patterns }),
            ...(item.results === undefined ? {} : { results: item.results }),
          },
        });
      case "todo_list":
        return [
          this.#event(
            "turn.plan.updated",
            {
              ...(nonEmpty(item.explanation) === undefined
                ? {}
                : { explanation: item.explanation }),
              plan: item.steps.map((step) => ({
                step: step.text,
                status: legacyPlanStepStatus(step.status),
              })),
            },
            this.#refs(run),
          ),
        ];
      case "approval_request":
      case "user_input_request":
        return this.#trackRequestItem(item, run);
      case "error": {
        const tracked = this.#items.get(item.id);
        this.#items.set(item.id, { item, started: true, completed: true, text: "" });
        if (tracked !== undefined) return [];
        return [
          this.#event(
            "runtime.warning",
            {
              message: nonEmpty(item.failure.message) ?? "Provider reported an error.",
              detail: {
                failure: item.failure,
                ...(item.retry === undefined ? {} : { retry: item.retry }),
              },
            },
            refs,
          ),
        ];
      }
      case "compaction":
        return this.#translateLifecycleItem(item, refs, {
          itemType: "context_compaction",
          title: nonEmpty(item.title),
          detail: nonEmpty(item.summary),
          data: {
            ...(item.beforeTokenCount === undefined
              ? {}
              : { beforeTokenCount: item.beforeTokenCount }),
            ...(item.afterTokenCount === undefined
              ? {}
              : { afterTokenCount: item.afterTokenCount }),
          },
        });
      case "user_message":
      case "subagent":
        return [];
      case "notification":
        return this.#translateLifecycleItem(item, refs, {
          itemType: "unknown",
          title: item.summary,
          detail: nonEmpty(item.detail),
          data: { kind: item.type, source: item.source, outcome: item.outcome },
        });
      case "system_notice":
      case "run_interrupt_request":
      case "run_interrupt_result":
        return this.#translateLifecycleItem(item, refs, {
          itemType: "unknown",
          title: nonEmpty(item.title),
          detail: nonEmpty(item.message),
          data: { kind: item.type },
        });
      case "checkpoint":
      case "handoff":
      case "fork":
      case "thread_created":
        return this.#translateLifecycleItem(item, refs, {
          itemType: "unknown",
          title: nonEmpty(item.title),
          data: { kind: item.type },
        });
      case "secret_request":
        return this.#translateLifecycleItem(item, refs, {
          itemType: "unknown",
          title: item.label,
          detail: nonEmpty(item.reason),
          data: { kind: item.type, secretStatus: item.secretStatus },
        });
    }
  }

  #translateStreamingItem(
    item: OrchestrationV2TurnItem,
    itemType: LegacyItemType,
    streamKind: LegacyEventOf<"content.delta">["payload"]["streamKind"],
    text: string,
    refs: LegacyEventRefs,
    data: Record<string, unknown>,
  ): ProviderRuntimeEvent[] {
    const events: ProviderRuntimeEvent[] = [];
    const tracked = this.#items.get(item.id) ?? {
      item,
      started: false,
      completed: false,
      text: "",
    };
    this.#items.set(item.id, tracked);
    tracked.item = item;
    if (tracked.completed) return events;
    if (!tracked.started) {
      tracked.started = true;
      events.push(this.#event("item.started", { itemType, status: "inProgress", data }, refs));
    }
    const delta = textDelta(tracked.text, text);
    if (delta.length > 0) {
      tracked.text = text;
      events.push(this.#event("content.delta", { streamKind, delta }, refs));
    }
    const streaming = "streaming" in item ? item.streaming : false;
    if (!streaming || TERMINAL_ITEM_STATUSES.has(item.status)) {
      tracked.completed = true;
      events.push(
        this.#event(
          "item.completed",
          { itemType, status: legacyItemStatus(item.status), data: { ...data, text } },
          refs,
        ),
      );
    }
    return events;
  }

  #translateLifecycleItem(
    item: OrchestrationV2TurnItem,
    refs: LegacyEventRefs,
    payload: {
      readonly itemType: LegacyItemType;
      readonly title?: string | undefined;
      readonly detail?: string | undefined;
      readonly data?: unknown;
    },
  ): ProviderRuntimeEvent[] {
    const events: ProviderRuntimeEvent[] = [];
    const tracked = this.#items.get(item.id) ?? {
      item,
      started: false,
      completed: false,
      text: "",
    };
    this.#items.set(item.id, tracked);
    tracked.item = item;
    if (tracked.completed) return events;
    const lifecycle: LegacyItemPayload = {
      itemType: payload.itemType,
      status: legacyItemStatus(item.status),
      ...(payload.title === undefined ? {} : { title: payload.title }),
      ...(payload.detail === undefined ? {} : { detail: payload.detail }),
      ...(item.toolSurface === undefined ? {} : { toolSurface: item.toolSurface }),
      ...(item.toolIcon === undefined ? {} : { toolIcon: item.toolIcon }),
      ...(item.toolSource === undefined ? {} : { toolSource: item.toolSource }),
      ...(payload.data === undefined ? {} : { data: payload.data }),
    };
    const terminal = TERMINAL_ITEM_STATUSES.has(item.status);
    if (!tracked.started) {
      tracked.started = true;
      events.push(this.#event("item.started", lifecycle, refs));
    } else if (!terminal) {
      events.push(this.#event("item.updated", lifecycle, refs));
    }
    if (terminal) {
      tracked.completed = true;
      events.push(this.#event("item.completed", lifecycle, refs));
    }
    return events;
  }

  #trackRequestItem(
    item: Extract<
      OrchestrationV2TurnItem,
      { readonly type: "approval_request" | "user_input_request" }
    >,
    run: LegacyRun | undefined,
  ): ProviderRuntimeEvent[] {
    const tracked = this.#requests.get(item.requestId) ?? {
      request: undefined,
      item: undefined,
      opened: false,
      resolved: false,
    };
    this.#requests.set(item.requestId, tracked);
    tracked.item = item;
    return this.#openRequest(tracked, run);
  }

  #translateRuntimeRequest(request: OrchestrationV2RuntimeRequest): ProviderRuntimeEvent[] {
    const tracked = this.#requests.get(request.id) ?? {
      request: undefined,
      item: undefined,
      opened: false,
      resolved: false,
    };
    this.#requests.set(request.id, tracked);
    tracked.request = request;
    const run = this.#runForItem(tracked.item?.runId ?? null);
    const events = this.#openRequest(tracked, run);
    if (request.status === "pending" || tracked.resolved || !tracked.opened) return events;
    tracked.resolved = true;
    const refs = this.#refs(run, { requestId: RuntimeRequestId.make(request.id) });
    if (request.kind === "user_input") {
      events.push(this.#event("user-input.resolved", { answers: request.answers ?? {} }, refs));
      return events;
    }
    events.push(
      this.#event(
        "request.resolved",
        {
          requestType: legacyRequestType(request.kind),
          ...(request.decision === undefined
            ? request.status === "resolved"
              ? {}
              : { decision: request.status }
            : { decision: request.decision }),
        },
        refs,
      ),
    );
    return events;
  }

  #openRequest(tracked: TrackedRequest, run: LegacyRun | undefined): ProviderRuntimeEvent[] {
    if (tracked.opened || tracked.request === undefined || tracked.item === undefined) return [];
    tracked.opened = true;
    const { request, item } = tracked;
    const refs = this.#refs(run, { requestId: RuntimeRequestId.make(request.id) });
    if (item.type === "user_input_request") {
      return [
        this.#event(
          "user-input.requested",
          {
            questions: item.questions.map((question) => ({
              id: question.id,
              header: question.header,
              question: question.question,
              options: question.options.map((option) => ({
                label: option.label,
                description: option.description,
                ...(option.value === undefined ? {} : { value: option.value }),
              })),
              ...(question.allowCustomAnswer === undefined
                ? {}
                : { allowCustomAnswer: question.allowCustomAnswer }),
              multiSelect: question.multiSelect ?? false,
            })),
            ...(item.responseMode === undefined ? {} : { responseMode: item.responseMode }),
          },
          refs,
        ),
      ];
    }
    const node = this.#nodes.get(request.nodeId);
    const toolItem =
      node?.parentNodeId === null || node?.parentNodeId === undefined
        ? undefined
        : this.#itemsByNodeId.get(node.parentNodeId);
    const args = toolArgumentsFromItem(toolItem);
    return [
      this.#event(
        "request.opened",
        {
          requestType: legacyRequestType(item.requestKind ?? request.kind),
          ...(nonEmpty(item.prompt) === undefined ? {} : { detail: item.prompt }),
          ...(nonEmpty(item.appName) === undefined ? {} : { appName: item.appName }),
          ...(item.options === undefined ? {} : { options: item.options }),
          ...(args === undefined ? {} : { args }),
        },
        refs,
      ),
    ];
  }

  #translateSubagent(subagent: OrchestrationV2Subagent): ProviderRuntimeEvent[] {
    const tracked = this.#subagents.get(subagent.id) ?? { started: false, completed: false };
    this.#subagents.set(subagent.id, tracked);
    if (tracked.completed) return [];
    const run = this.#runForItem(subagent.runId);
    const refs = this.#refs(
      run,
      subagent.threadId === this.#options.threadId ? {} : { threadId: subagent.threadId },
    );
    const taskId = RuntimeTaskId.make(subagent.id);
    const description = nonEmpty(subagent.title) ?? nonEmpty(subagent.prompt) ?? "Subagent";
    const linkage = {
      taskType: "subagent",
      agentId: subagent.id,
      ...(nonEmpty(subagent.title) === undefined ? {} : { title: subagent.title as string }),
      ...(nonEmpty(subagent.model) === undefined ? {} : { model: subagent.model as string }),
    };
    const events: ProviderRuntimeEvent[] = [];
    if (!tracked.started) {
      tracked.started = true;
      events.push(this.#event("task.started", { taskId, description, ...linkage }, refs));
    }
    if (TERMINAL_SUBAGENT_STATUSES.has(subagent.status)) {
      tracked.completed = true;
      events.push(
        this.#event(
          "task.completed",
          {
            taskId,
            status:
              subagent.status === "completed"
                ? "completed"
                : subagent.status === "failed"
                  ? "failed"
                  : "stopped",
            ...(nonEmpty(subagent.result) === undefined
              ? {}
              : { summary: subagent.result as string }),
            ...linkage,
          },
          refs,
        ),
      );
      return events;
    }
    if (events.length === 0) {
      events.push(
        this.#event(
          "task.updated",
          {
            taskId,
            status: subagent.status,
            ...(nonEmpty(subagent.progress) === undefined
              ? {}
              : { description: subagent.progress as string }),
            ...linkage,
          },
          refs,
        ),
      );
    }
    return events;
  }
}
