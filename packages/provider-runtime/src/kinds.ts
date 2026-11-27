import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

/** Every built-in T3 driver the embedded runtime can run, by its runtime name. */
export const PROVIDER_RUNTIME_KINDS = [
  "claude-code",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
  "pi",
  "kiro",
  "fx",
  "muse",
  "acp",
] as const;

export type ProviderRuntimeKind = (typeof PROVIDER_RUNTIME_KINDS)[number];

interface ProviderRuntimeKindInfo {
  /** The T3 driver behind the kind; events and sessions report it as their provider. */
  readonly driverKind: string;
  /**
   * Model a session runs when the host names none. ACP agents take "default" as
   * their own default model. Undefined means the host must choose one.
   */
  readonly defaultModel: string | undefined;
  readonly supportsSkillRoots: boolean;
}

const KINDS: Readonly<Record<ProviderRuntimeKind, ProviderRuntimeKindInfo>> = {
  "claude-code": {
    driverKind: "claudeAgent",
    defaultModel: "claude-sonnet-5-5",
    supportsSkillRoots: false,
  },
  codex: { driverKind: "codex", defaultModel: "gpt-6-astra", supportsSkillRoots: true },
  cursor: { driverKind: "cursor", defaultModel: undefined, supportsSkillRoots: false },
  grok: { driverKind: "grok", defaultModel: "default", supportsSkillRoots: false },
  opencode: { driverKind: "opencode", defaultModel: undefined, supportsSkillRoots: false },
  antigravity: { driverKind: "antigravity", defaultModel: "default", supportsSkillRoots: false },
  pi: { driverKind: "pi", defaultModel: undefined, supportsSkillRoots: false },
  kiro: { driverKind: "kiro", defaultModel: "default", supportsSkillRoots: false },
  fx: { driverKind: "fx", defaultModel: "default", supportsSkillRoots: false },
  muse: { driverKind: "muse", defaultModel: undefined, supportsSkillRoots: false },
  acp: { driverKind: "acpRegistry", defaultModel: "default", supportsSkillRoots: false },
};

export function providerRuntimeKindInfo(kind: ProviderRuntimeKind) {
  const info = Object.hasOwn(KINDS, kind) ? KINDS[kind] : undefined;
  if (info === undefined) {
    throw new Error(
      `Unknown T3 provider runtime kind ${JSON.stringify(kind)}. Expected one of: ${PROVIDER_RUNTIME_KINDS.join(", ")}.`,
    );
  }
  const driverKind = ProviderDriverKind.make(info.driverKind);
  return {
    ...info,
    driverKind,
    instanceId: ProviderInstanceId.make(info.driverKind),
  };
}

/** What inspectProvider reports: install, version, account and usage, without a model turn. */
export type ProviderInspection = Pick<
  ServerProvider,
  "enabled" | "installed" | "version" | "status" | "auth" | "checkedAt" | "message" | "usageLimits"
>;
