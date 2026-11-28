import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

/** What an agent asked the user for through `notify_user`. It counts until the user opens the thread or replies. */
export interface AgentAlertMark {
  readonly body: string;
  readonly at: string;
}

let marks: ReadonlyMap<string, AgentAlertMark> = new Map();
const listeners = new Set<() => void>();

const update = (next: ReadonlyMap<string, AgentAlertMark>) => {
  marks = next;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function markAgentAlert(
  ref: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
  body: string,
  at: string,
): void {
  update(new Map(marks).set(scopedThreadKey(ref), { body, at }));
}

/** The thread's mark, unless the user has opened the thread or written in it since the agent asked. */
export function useAgentAlertMark(
  threadKey: string,
  seen: {
    readonly lastVisitedAt?: string | null;
    readonly latestUserAuthoredMessageAt?: string | null;
  },
): AgentAlertMark | null {
  const mark = useSyncExternalStore(subscribe, () => marks.get(threadKey) ?? null);
  if (mark === null) return null;
  if (seen.lastVisitedAt != null && seen.lastVisitedAt > mark.at) return null;
  if (seen.latestUserAuthoredMessageAt != null && seen.latestUserAuthoredMessageAt > mark.at)
    return null;
  return mark;
}
