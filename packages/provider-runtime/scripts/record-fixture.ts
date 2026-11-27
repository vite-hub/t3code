// @effect-diagnostics nodeBuiltinImport:off - A Node CLI script around the Promise-based runtime.
// @effect-diagnostics globalConsole:off - It reports to the terminal that runs it.
/**
 * Records one redacted turn as fixtures/<agent-id or kind>.events.jsonl, in a temporary cwd and HOME:
 *   record-fixture.ts <kind> <model> [--agent-id x] [--settings json] [--home dir] [--state dir]
 * --home and --state seed that HOME or T3 state directory with a CLI's config or login.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { ApprovalRequestId, ThreadId } from "@t3tools/contracts";

import {
  createProviderRuntime,
  PROVIDER_RUNTIME_KINDS,
  type ProviderRuntimeKind,
} from "../src/index.ts";

const RECORD_PROMPT = "Write hello.txt containing the word hi, then run cat hello.txt.";
const TIMEOUT_MS = 120_000;
// Variables a provider reads for its endpoint and key. Everything else stays out.
const PASSTHROUGH =
  /^(?:GEMINI_|GOOGLE_|ANTHROPIC_|OPENAI_|CODEX_|CURSOR_|XAI_|GROK_|KIMI_|MOONSHOT_)/u;

const { values, positionals } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    "agent-id": { type: "string" },
    settings: { type: "string" },
    home: { type: "string" },
    state: { type: "string" },
  },
});
const [kind, model] = positionals;
if (!PROVIDER_RUNTIME_KINDS.includes(kind as ProviderRuntimeKind) || !model) {
  console.error(
    `Usage: record-fixture.ts <${PROVIDER_RUNTIME_KINDS.join("|")}> <model> [--agent-id <id>]`,
  );
  process.exit(2);
}
const agentId = values["agent-id"];
if (kind === "acp" && agentId === undefined) {
  console.error("The acp kind needs --agent-id, such as gemini.");
  process.exit(2);
}

const fixturesDirectory = NodeURL.fileURLToPath(new URL("../fixtures/", import.meta.url));
const output = NodePath.join(fixturesDirectory, `${agentId ?? kind}.events.jsonl`);
const root = await NodeFSP.realpath(
  await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-record-fixture-")),
);
const cwd = NodePath.join(root, "work");
const home = NodePath.join(root, "home");
const stateDirectory = NodePath.join(root, "state");
const eventLogPath = NodePath.join(root, "events.jsonl");
await NodeFSP.mkdir(cwd);
for (const [target, source] of [
  [home, values.home],
  [stateDirectory, values.state],
] as const) {
  if (source === undefined) await NodeFSP.mkdir(target);
  else await NodeFSP.cp(NodePath.resolve(source), target, { recursive: true });
}

const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8" };
for (const [name, value] of Object.entries(process.env)) {
  if (PASSTHROUGH.test(name)) environment[name] = value;
}

const runtime = await createProviderRuntime({
  provider: kind as ProviderRuntimeKind,
  cwd,
  environment,
  eventLogPath,
  stateDirectory,
  // Registry agents install once per machine instead of once per recording.
  installationDirectory: NodePath.join(NodeOS.tmpdir(), "t3-record-fixture-tools"),
  settings: {
    // customModels lets T3 pass a model the agent does not list, such as a proxy's model id.
    ...(agentId === undefined ? {} : { agentId, customModels: [model] }),
    ...(values.settings === undefined ? {} : JSON.parse(values.settings)),
  },
});
const threadId = ThreadId.make("record-fixture");
const timeout = AbortSignal.timeout(TIMEOUT_MS);
let state = "timeout";
try {
  const finished = (async () => {
    for await (const event of runtime.events) {
      if (event.type === "request.opened" && event.requestId !== undefined) {
        await runtime.respondToRequest(threadId, ApprovalRequestId.make(event.requestId), "accept");
      }
      if (event.type === "turn.completed") return event.payload.state;
      if (event.type === "session.exited") return "exited";
    }
    return "closed";
  })();
  const aborted = new Promise<string>((resolve) =>
    timeout.addEventListener("abort", () => resolve("timeout"), { once: true }),
  );
  await runtime.startSession({ threadId, model, runtimeMode: "full-access" });
  await runtime.sendTurn({ threadId, input: RECORD_PROMPT });
  state = await Promise.race([finished, aborted]);
} finally {
  await runtime.close();
}

const secrets = Object.entries(environment)
  .filter(([name, value]) => name !== "PATH" && name !== "HOME" && name !== "LANG" && value)
  .map(([, value]) => value as string)
  .filter((value) => value.length >= 8);
const redact = (text: string) => {
  let next = text;
  for (const secret of secrets.toSorted((a, b) => b.length - a.length)) {
    next = next.replaceAll(secret, "<redacted>");
  }
  return next
    .replaceAll(cwd, "<cwd>")
    .replaceAll(home, "<home>")
    .replaceAll(root, "<tmp>")
    .replaceAll(NodeOS.homedir(), "<user-home>")
    .replaceAll(NodeOS.userInfo().username, "<user>")
    .replace(/\bsk-[\w-]{8,}/gu, "<redacted>")
    .replace(/\b(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\]):\d+[^\s"]*/gu, "<proxy-url>");
};
await NodeFSP.mkdir(fixturesDirectory, { recursive: true });
await NodeFSP.writeFile(output, redact(await NodeFSP.readFile(eventLogPath, "utf8")));
await NodeFSP.rm(root, { recursive: true, force: true });
console.log(`${state}: ${NodePath.relative(process.cwd(), output)}`);
process.exit(state === "completed" ? 0 : 1);
