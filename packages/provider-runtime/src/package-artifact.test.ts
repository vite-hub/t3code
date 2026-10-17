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
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

describe("provider-runtime package artifact", () => {
  it(
    "installs from the registry tarball and starts a Codex-only consumer without the Claude SDK",
    { timeout: 120_000 },
    async () => {
      const temporaryDirectory = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "vitehub-provider-runtime-package-"),
      );
      const consumerDirectory = NodePath.join(temporaryDirectory, "consumer");

      try {
        await run(vp, ["pack"], packageDirectory);
        const bundle = await NodeFSP.readFile(
          NodePath.join(packageDirectory, "dist/index.mjs"),
          "utf8",
        );
        const declarations = await NodeFSP.readFile(
          NodePath.join(packageDirectory, "dist/index.d.mts"),
          "utf8",
        );
        expect(bundle).not.toContain("@anthropic-ai/claude-agent-sdk");
        // The private T3 workspace packages must ship inside the bundle.
        for (const output of [bundle, declarations]) {
          expect(output).not.toMatch(/from\s*["']@t3tools\//u);
          expect(output).not.toMatch(/import\s*\(\s*["']@t3tools\//u);
        }

        const { stdout } = await run(
          "pnpm",
          ["pack", "--pack-destination", temporaryDirectory, "--json"],
          packageDirectory,
        );
        const tarball = (JSON.parse(stdout) as { readonly filename: string }).filename;
        await run("tar", ["-xzf", tarball, "-C", temporaryDirectory], temporaryDirectory);
        const manifest = JSON.parse(
          await NodeFSP.readFile(NodePath.join(temporaryDirectory, "package/package.json"), "utf8"),
        ) as PackageManifest;
        // pnpm 12 rejects URL, git and file dependencies below the root (blockExoticSubdeps).
        const specifiers = Object.entries({
          ...manifest.dependencies,
          ...manifest.optionalDependencies,
          ...manifest.peerDependencies,
        });
        expect(specifiers.map(([name]) => name)).toEqual(["effect"]);
        for (const [, specifier] of specifiers) {
          expect(specifier).toMatch(/^\^?\d+\.\d+\.\d+/u);
        }

        await NodeFSP.mkdir(consumerDirectory);
        await NodeFSP.writeFile(
          NodePath.join(consumerDirectory, "package.json"),
          JSON.stringify({
            name: "provider-runtime-codex-consumer",
            private: true,
            type: "module",
            dependencies: { [manifest.name]: `file:${tarball}` },
          }),
        );
        await NodeFSP.writeFile(
          NodePath.join(consumerDirectory, "verify.mjs"),
          [
            'import { registerHooks } from "node:module";',
            "registerHooks({ resolve(specifier, context, nextResolve) {",
            '  if (context.conditions.includes("require") && /^(node:)?(process|buffer)$/.test(specifier)) {',
            '    throw new Error(`No such module "${specifier}"`);',
            "  }",
            "  return nextResolve(specifier, context);",
            "} });",
            `const { createProviderRuntime } = await import(${JSON.stringify(manifest.name)});`,
            'const runtime = await createProviderRuntime({ provider: "codex" });',
            "await runtime.close();",
          ].join("\n"),
        );

        await run(
          "pnpm",
          [
            "install",
            "--prefer-offline",
            "--ignore-scripts",
            "--config.ignore-workspace=true",
            "--strict-peer-dependencies",
            "--config.minimumReleaseAge=0",
          ],
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
