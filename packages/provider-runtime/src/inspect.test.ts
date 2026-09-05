// @effect-diagnostics nodeBuiltinImport:off - These tests exercise a subprocess through the public package interface.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import { HostProcessPlatform } from "../../shared/src/hostProcess.ts";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, vi } from "vite-plus/test";
import { inspectProvider } from "./inspect.ts";

const claudeSdk = vi.hoisted(() => ({
  query:
    vi.fn<
      (input: {
        prompt: AsyncIterable<unknown>;
        options: { abortController: AbortController; env: NodeJS.ProcessEnv };
      }) => object
    >(),
}));
vi.mock("../../../apps/server/src/provider/Drivers/ClaudeSdk.ts", () => ({
  importClaudeAgentSdk: async () => claudeSdk,
}));

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});

async function peer(mode: string, platform: NodeJS.Platform) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-inspect-"));
  directories.push(directory);
  const script = NodePath.join(directory, "peer.mjs");
  await NodeFSP.writeFile(
    script,
    `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('2.1.260 (Claude Code)'); process.exit(0); }
writeFileSync(process.env.PROBE_PID, String(process.pid));
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  appendFileSync(process.env.PROBE_REQUESTS, request.method + '\\n');
  if (request.id === undefined) return;
  const send = result => console.log(JSON.stringify({ id: request.id, result }));
  switch (request.method) {
    case 'initialize': return send({ userAgent: 'codex/0.149.1', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'linux' });
    case 'account/read':
      if (process.env.PROBE_MODE === 'hang') return;
      return send({ requiresOpenaiAuth: true, account: process.env.PROBE_MODE === 'noauth' ? null : { type: 'chatgpt', email: 'probe@example.test', planType: 'plus' } });
    case 'skills/list': return send({ data: [] });
    case 'model/list': return send({ data: [], nextCursor: null });
    case 'account/rateLimits/read':
      if (process.env.PROBE_MODE === 'quotaerror') return console.log(JSON.stringify({ id: request.id, error: { code: -32601, message: 'Unavailable' } }));
      return send({ rateLimits: { limitId: 'codex', limitName: null, primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: null, credits: null, planType: 'plus' }, rateLimitsByLimitId: {}, rateLimitResetCredits: null });
    default: throw Error('Unexpected request: ' + request.method);
  }
});
`,
  );
  await NodeFSP.chmod(script, 0o755);
  const binaryPath = platform === "win32" ? NodePath.join(directory, "peer.cmd") : script;
  if (platform === "win32") {
    await NodeFSP.writeFile(binaryPath, `@"${process.execPath}" "${script}" %*\r\n`);
  }
  const requests = NodePath.join(directory, "requests");
  const pid = NodePath.join(directory, "pid");
  return {
    directory,
    requests,
    pid,
    options: {
      provider: "codex" as const,
      settings: {
        binaryPath,
        launchArgs: "",
        homePath: directory,
      },
      environment: { ...process.env, PROBE_MODE: mode, PROBE_REQUESTS: requests, PROBE_PID: pid },
    },
    async assertStopped() {
      const childPid = Number(await NodeFSP.readFile(pid, "utf8"));
      expect(() => process.kill(childPid, 0)).toThrow();
    },
  };
}

const withPeer = Effect.fn("withPeer")(function* (
  mode: string,
  test: (fixture: Awaited<ReturnType<typeof peer>>) => Promise<void>,
) {
  const platform = yield* HostProcessPlatform;
  yield* Effect.promise(async () => test(await peer(mode, platform)));
});

describe("inspectProvider", () => {
  it.effect(
    "reads account and quota without starting a session or model turn, then closes the process",
    () =>
      withPeer("ready", async (fixture) => {
        const result = await inspectProvider(fixture.options);
        expect(result).toMatchObject({
          installed: true,
          status: "ready",
          auth: { status: "authenticated" },
        });
        expect(result.usageLimits?.windows).toEqual([
          expect.objectContaining({ id: "primary", usedPercent: 25, windowDurationMins: 300 }),
        ]);
        const methods = (await NodeFSP.readFile(fixture.requests, "utf8")).trim().split("\n");
        expect(methods.sort()).toEqual(
          [
            "account/rateLimits/read",
            "account/read",
            "initialize",
            "initialized",
            "model/list",
            "skills/list",
          ].sort(),
        );
        await fixture.assertStopped();
      }),
  );

  it.effect("keeps authenticated status when quota evidence is unavailable", () =>
    withPeer("quotaerror", async (fixture) => {
      const result = await inspectProvider(fixture.options);
      expect(result.auth.status).toBe("authenticated");
      expect(result.usageLimits?.unavailable?.reason).toBe("probeFailed");
      await fixture.assertStopped();
    }),
  );

  it.effect("reports a signed-out account without requesting quota", () =>
    withPeer("noauth", async (fixture) => {
      const result = await inspectProvider(fixture.options);
      expect(result.auth.status).not.toBe("authenticated");
      expect(await NodeFSP.readFile(fixture.requests, "utf8")).not.toContain(
        "account/rateLimits/read",
      );
      await fixture.assertStopped();
    }),
  );

  it.effect("closes a running probe when the caller aborts", () =>
    withPeer("hang", async (fixture) => {
      const controller = new AbortController();
      const watcher = NodeFS.watch(fixture.directory, async (_, file) => {
        if (
          file === "requests" &&
          (await NodeFSP.readFile(fixture.requests, "utf8")).includes("account/read")
        )
          controller.abort();
      });
      try {
        await expect(
          inspectProvider({ ...fixture.options, signal: controller.signal }),
        ).rejects.toThrow();
        expect(controller.signal.aborted).toBe(true);
        await fixture.assertStopped();
      } finally {
        watcher.close();
      }
    }),
  );

  it.effect(
    "reads Claude account and quota without yielding a prompt and aborts initialization",
    () =>
      withPeer("ready", async (fixture) => {
        claudeSdk.query.mockReturnValue({
          initializationResult: async () => ({
            account: { email: "probe@example.test", subscriptionType: "max", tokenSource: "oauth" },
            commands: [],
          }),
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
            rate_limits_available: true,
            rate_limits: { five_hour: { utilization: 42, resets_at: null } },
          }),
        });
        const result = await inspectProvider({ ...fixture.options, provider: "claude-code" });
        expect(result).toMatchObject({
          status: "ready",
          auth: { status: "authenticated", email: "probe@example.test" },
        });
        expect(result.usageLimits?.windows).toEqual(
          expect.arrayContaining([expect.objectContaining({ usedPercent: 42 })]),
        );
        expect(claudeSdk.query).toHaveBeenCalledTimes(1);
        const input = claudeSdk.query.mock.calls[0]![0];
        expect(input.options.env.PROBE_REQUESTS).toBe(fixture.requests);
        expect(input.options).toMatchObject({
          persistSession: false,
          settings: { disableAllHooks: true },
        });
        expect(input.options.abortController.signal.aborted).toBe(true);
        expect(await input.prompt[Symbol.asyncIterator]().next()).toMatchObject({ done: true });
      }),
  );

  it.each(["codex", "claude-code"] as const)(
    "reports a missing %s executable",
    async (provider) => {
      const result = await inspectProvider({
        provider,
        settings: { binaryPath: "/nonexistent/t3-inspect-cli" },
      });
      expect(result).toMatchObject({ installed: false, status: "error" });
    },
  );
});
