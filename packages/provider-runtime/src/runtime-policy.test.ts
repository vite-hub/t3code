import { describe, expect, it } from "vite-plus/test";

import { sessionRuntimePolicy } from "./runtime-policy.ts";

describe("sessionRuntimePolicy", () => {
  it("keeps the native sandbox policy a host passes", () => {
    const sandboxPolicy = {
      type: "workspaceWrite",
      networkAccess: true,
      writableRoots: ["/cache/pnpm"],
    };
    expect(
      sessionRuntimePolicy(
        { runtimeMode: "auto-accept-edits", approvalPolicy: "never", sandboxPolicy },
        "/work",
      ),
    ).toEqual({
      runtimeMode: "auto-accept-edits",
      interactionMode: "default",
      cwd: "/work",
      approvalPolicy: "never",
      sandboxPolicy,
    });
  });

  it("leaves the runtime mode defaults when the host passes no native policy", () => {
    expect(sessionRuntimePolicy({ cwd: "/repo" }, "/work")).toEqual({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: "/repo",
    });
  });
});
