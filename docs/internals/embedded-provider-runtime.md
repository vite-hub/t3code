# Embedded provider runtime

The ViteHub fork publishes `@t3tools/provider-runtime` for Node hosts that use
T3's Codex and Claude adapters without running the T3 application server.
`packages/provider-runtime` owns the Promise interface, session cursor storage,
and package-artifact tests. Provider protocols remain in the upstream adapters.

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

Keep fork adaptations localized. Current upstream-file changes support optional
Claude SDK loading, host-provided Codex session timestamps, and publishable
contracts metadata. When upstream implements one of these requirements, remove
the corresponding fork change and retain the package-level behavioral check.
Review upstream workflow changes from the sync job summary separately.

Consumers pin an immutable verified package revision. Synchronizing this fork
does not update a consuming application or redeploy its stable environment.
