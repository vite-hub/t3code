// @effect-diagnostics nodeBuiltinImport:off - This package exposes a Promise-based Node host boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ThreadId } from "@t3tools/contracts";

export interface ProviderRuntimeSessionStore {
  readonly delete: (threadId: ThreadId) => Promise<void>;
  readonly get: (threadId: ThreadId) => Promise<unknown | undefined>;
  readonly set: (threadId: ThreadId, resumeCursor: unknown) => Promise<void>;
}

export interface SqliteProviderRuntimeSessionStore extends ProviderRuntimeSessionStore {
  readonly close: () => void;
}

export async function createSqliteProviderRuntimeSessionStore(
  path: string,
): Promise<SqliteProviderRuntimeSessionStore> {
  if (!path.trim()) throw new TypeError("Provider session store path must not be empty.");
  await NodeFSP.mkdir(NodePath.dirname(NodePath.resolve(path)), { mode: 0o700, recursive: true });

  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS t3_provider_runtime_sessions (
      thread_id TEXT PRIMARY KEY,
      resume_cursor_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
  `);
  await NodeFSP.chmod(path, 0o600);

  const deleteSession = database.prepare(
    "DELETE FROM t3_provider_runtime_sessions WHERE thread_id = ?",
  );
  const getSession = database.prepare(
    "SELECT resume_cursor_json FROM t3_provider_runtime_sessions WHERE thread_id = ?",
  );
  const setSession = database.prepare(`
    INSERT INTO t3_provider_runtime_sessions (thread_id, resume_cursor_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT (thread_id) DO UPDATE SET
      resume_cursor_json = excluded.resume_cursor_json,
      updated_at = excluded.updated_at
  `);
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error("T3 provider session store is closed.");
  };

  return {
    close() {
      if (closed) return;
      closed = true;
      database.close();
    },
    async delete(threadId) {
      assertOpen();
      deleteSession.run(threadId);
    },
    async get(threadId) {
      assertOpen();
      const row = getSession.get(threadId);
      if (row === undefined) return undefined;
      const value = row.resume_cursor_json;
      if (typeof value !== "string") {
        throw new TypeError(`Provider session ${JSON.stringify(threadId)} has an invalid cursor.`);
      }
      return JSON.parse(value) as unknown;
    },
    async set(threadId, resumeCursor) {
      assertOpen();
      const value = JSON.stringify(resumeCursor);
      if (value === undefined) throw new TypeError("Provider resume cursor must be JSON serializable.");
      setSession.run(threadId, value, Date.now());
    },
  };
}
