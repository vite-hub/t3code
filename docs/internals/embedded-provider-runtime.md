# Embedded provider runtime

The ViteHub fork publishes `@t3tools/provider-runtime` for Node hosts that use
T3's Codex and Claude adapters without running the T3 application server.
`packages/provider-runtime` owns the Promise interface, session cursor storage,
and package-artifact tests. Provider protocols remain in the upstream adapters.

## Orchestration V2 adapters

Upstream drives providers through `orchestration-v2/Adapters/ClaudeAdapterV2.ts`
and `CodexAdapterV2.ts`. Each adapter opens a provider session, ensures or resumes
a provider thread, and reports projection-shaped `ProviderAdapterV2Event`s
(`turn_item.updated`, `runtime_request.updated`, `turn.terminal`, ...).

`createProviderRuntime` wraps one adapter instance and keeps the host contract:

- `startSession` opens a V2 session and thread. The returned `resumeCursor` is the
  encoded `OrchestrationV2ProviderThread`; hosts store it as an opaque value.
  Cursors written before this change do not decode and start a fresh thread.
- `sendTurn` starts a V2 run. A turn sent while another runs steers that run and
  returns the active `turnId`. `interruptTurn` waits for the provider turn id the
  adapter reports through `provider_turn.updated`.
- `src/legacy-events.ts` translates adapter events into the flat
  `ProviderRuntimeEvent` stream (`item.*`, `content.delta`, `request.*`,
  `user-input.*`, `turn.completed`, `turn.aborted`, `thread.token-usage.updated`,
  `task.*`). Retry items become recoverable `runtime.warning`s; the run's
  outcome comes from `turn.terminal`. A failed event stream becomes
  `session.exited` with `exitKind: "error"`.
- When a host omits `model`, the runtime uses `DEFAULT_PROVIDER_RUNTIME_MODELS`.

## Inspect an account without a turn

```ts
import { inspectProvider } from "@t3tools/provider-runtime";

const status = await inspectProvider({
  provider: "codex",
  settings: { homePath: "/var/lib/my-agent/codex" },
  environment: process.env,
  signal: AbortSignal.timeout(15_000),
});
```

Use the same provider settings and environment as `createProviderRuntime`.
Inspection uses the host's current working directory and T3's existing bounded
status probes. It does not persist a session, submit a prompt, or cache a result.
Temporary provider processes are scoped to the call, including cancellation.
Claude remains opt-in: install its SDK in the host when using that provider.

Authentication and quota are separate:
an authenticated account can have exhausted windows or unavailable quota data.
`usageLimits.unavailable.reason` distinguishes unsupported accounts from a
failed probe. These observations cannot guarantee a future model response.
Consumers decide freshness, readiness, and display policy. Treat account
identity in `auth` as private operational data.

## Synchronizing the fork

`origin/main` is the ViteHub fork; `upstream/main` is `pingdotgg/t3code`.
The scheduled/manual `Sync upstream` workflow merges upstream, preserves
fork-owned workflows, installs from the lockfile, builds the published packages,
typechecks the runtime, and runs focused provider and package-artifact tests.
It pushes `main` only after those checks pass, then publishes preview packages.
A conflict or failed check leaves remote `main` unchanged.

Keep fork adaptations localized. Current upstream-file changes:

- `ClaudeAdapterV2.ts` and `ClaudeProvider.ts` load `@anthropic-ai/claude-agent-sdk`
  through `Drivers/ClaudeSdk.ts` on first use, so Codex-only hosts do not install
  it. `ClaudeAdapterV2.lazy.test.ts` guards the import graph.
- `packages/contracts` publishes declaration files. `OrchestrationV2RpcSchemas`
  and `WsRpcGroup` carry explicit type annotations because their inferred types
  exceed the TypeScript serialization limit (TS7056), and `CodexInstallationService`
  and `CodexAppServerClientRaw` are exported so the runtime bundle can name them.
- `scripts/lib/cli-external-packages.ts` stages the Claude SDK in desktop
  artifacts because the computed import hides it from the bundler.

When upstream implements one of these requirements, remove the corresponding
fork change and retain the package-level behavioral check. Review upstream
workflow changes from the sync job summary separately.

Consumers pin an immutable verified package revision. Synchronizing this fork
does not update a consuming application or redeploy its stable environment.
