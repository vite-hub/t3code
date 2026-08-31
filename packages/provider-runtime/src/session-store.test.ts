// @effect-diagnostics nodeBuiltinImport:off - This test verifies the Promise-based Node host boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createSqliteProviderRuntimeSessionStore } from "./session-store.ts";

describe("provider runtime session store", () => {
  it("persists resume cursors across store restarts", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-session-store-"));
    const path = NodePath.join(directory, "sessions.sqlite");
    const threadId = ThreadId.make("thread-1");

    try {
      const first = await createSqliteProviderRuntimeSessionStore(path);
      await first.set(threadId, { threadId: "provider-thread-1" });
      first.close();

      const second = await createSqliteProviderRuntimeSessionStore(path);
      await expect(second.get(threadId)).resolves.toEqual({ threadId: "provider-thread-1" });
      await second.delete(threadId);
      await expect(second.get(threadId)).resolves.toBeUndefined();
      second.close();
    } finally {
      await NodeFSP.rm(directory, { force: true, recursive: true });
    }
  });
});
