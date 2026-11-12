import type { ProviderAdapterV2RuntimePolicy } from "../../provider-core/src/server/ProviderAdapter.ts";
import type { ProviderRuntimeStartInput } from "./index.ts";

/** The policy a session keeps for every turn. Absent native policies keep the runtime mode defaults. */
export function sessionRuntimePolicy(
  input: Pick<
    ProviderRuntimeStartInput,
    "approvalPolicy" | "cwd" | "runtimeMode" | "sandboxPolicy"
  >,
  cwd: string | null,
): ProviderAdapterV2RuntimePolicy {
  return {
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: "default",
    cwd: input.cwd ?? cwd,
    ...(input.approvalPolicy === undefined ? {} : { approvalPolicy: input.approvalPolicy }),
    ...(input.sandboxPolicy === undefined ? {} : { sandboxPolicy: input.sandboxPolicy }),
  };
}
