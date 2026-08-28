// @effect-diagnostics nodeBuiltinImport:off - This test verifies the packed Node package boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { describe, expect, it } from "vite-plus/test";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const packageDirectory = NodePath.resolve(import.meta.dirname, "..");
const repositoryDirectory = NodePath.resolve(packageDirectory, "../..");
const vp = NodePath.join(repositoryDirectory, "node_modules", ".bin", "vp");

async function run(command: string, args: ReadonlyArray<string>, cwd: string) {
  return execFile(command, args, {
    cwd,
    env: { ...process.env, COREPACK_ENABLE_PROJECT_SPEC: "0" },
    maxBuffer: 10 * 1024 * 1024,
  });
}

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly [key: string]: unknown;
}

async function readManifest(packageJsonPath: string): Promise<PackageManifest> {
  return JSON.parse(await NodeFSP.readFile(packageJsonPath, "utf8")) as PackageManifest;
}

function publishedManifest(
  manifest: PackageManifest,
  dependencies: Readonly<Record<string, string>>,
  peerDependencies?: Readonly<Record<string, string>>,
) {
  const { devDependencies: _devDependencies, scripts: _scripts, ...published } = manifest;
  return {
    ...published,
    dependencies,
    ...(peerDependencies ? { peerDependencies } : {}),
  };
}

describe("provider-runtime package artifact", () => {
  it(
    "installs and starts a Codex-only consumer without the Claude SDK",
    { timeout: 120_000 },
    async () => {
      const temporaryDirectory = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "t3-provider-runtime-package-"),
      );
      const consumerDirectory = NodePath.join(temporaryDirectory, "consumer");
      const contractsDirectory = NodePath.join(repositoryDirectory, "packages/contracts");
      const contractsPackageDirectory = NodePath.join(temporaryDirectory, "contracts-package");
      const providerRuntimePackageDirectory = NodePath.join(
        temporaryDirectory,
        "provider-runtime-package",
      );

      try {
        const packageArtifacts = [
          [contractsDirectory, contractsPackageDirectory],
          [packageDirectory, providerRuntimePackageDirectory],
        ] satisfies ReadonlyArray<readonly [string, string]>;
        await Promise.all(
          packageArtifacts.map(([sourceDirectory, artifactDirectory]) =>
            run(
              vp,
              ["pack", "--out-dir", NodePath.join(artifactDirectory, "dist")],
              sourceDirectory,
            ),
          ),
        );

        const bundle = await NodeFSP.readFile(
          NodePath.join(providerRuntimePackageDirectory, "dist/index.mjs"),
          "utf8",
        );
        expect(bundle).not.toMatch(
          /import\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)?["']@anthropic-ai\/claude-agent-sdk["']\s*\)/u,
        );
        expect(bundle).not.toContain("@anthropic-ai/claude-agent-sdk");

        const contractsManifest = await readManifest(
          NodePath.join(contractsDirectory, "package.json"),
        );
        const providerRuntimeManifest = await readManifest(
          NodePath.join(packageDirectory, "package.json"),
        );
        const effectManifest = await readManifest(
          NodePath.join(packageDirectory, "node_modules/effect/package.json"),
        );
        const platformNodeManifest = await readManifest(
          NodePath.join(packageDirectory, "node_modules/@effect/platform-node/package.json"),
        );
        expect(providerRuntimeManifest.dependencies).not.toHaveProperty(
          "@anthropic-ai/claude-agent-sdk",
        );
        expect(providerRuntimeManifest.devDependencies).toHaveProperty(
          "@anthropic-ai/claude-agent-sdk",
        );
        await Promise.all([
          NodeFSP.writeFile(
            NodePath.join(contractsPackageDirectory, "package.json"),
            JSON.stringify(
              publishedManifest(contractsManifest, {}, { effect: effectManifest.version }),
            ),
          ),
          NodeFSP.writeFile(
            NodePath.join(providerRuntimePackageDirectory, "package.json"),
            JSON.stringify(
              publishedManifest(providerRuntimeManifest, {
                "@effect/platform-node": platformNodeManifest.version,
                "@t3tools/contracts": contractsManifest.version,
                effect: effectManifest.version,
              }),
            ),
          ),
        ]);

        await NodeFSP.mkdir(consumerDirectory);
        await NodeFSP.writeFile(
          NodePath.join(consumerDirectory, "package.json"),
          JSON.stringify({
            name: "provider-runtime-codex-consumer",
            private: true,
            type: "module",
            dependencies: {
              "@t3tools/contracts": "file:../contracts-package",
              "@t3tools/provider-runtime": "file:../provider-runtime-package",
            },
          }),
        );
        await NodeFSP.writeFile(
          NodePath.join(consumerDirectory, "pnpm-workspace.yaml"),
          'overrides:\n  "@t3tools/contracts": "file:../contracts-package"\n',
        );
        await NodeFSP.writeFile(
          NodePath.join(consumerDirectory, "verify.mjs"),
          [
            'import { createProviderRuntime } from "@t3tools/provider-runtime";',
            'const runtime = await createProviderRuntime({ provider: "codex" });',
            "await runtime.close();",
          ].join("\n"),
        );

        await run(
          "pnpm",
          ["install", "--prefer-offline", "--ignore-scripts", "--config.ignore-workspace=true"],
          consumerDirectory,
        );
        await expect(
          NodeFSP.access(
            NodePath.join(consumerDirectory, "node_modules/@anthropic-ai/claude-agent-sdk"),
          ),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await run(process.execPath, ["verify.mjs"], consumerDirectory);
      } finally {
        await NodeFSP.rm(temporaryDirectory, { recursive: true, force: true });
      }
    },
  );
});
