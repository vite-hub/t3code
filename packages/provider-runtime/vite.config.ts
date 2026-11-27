import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import { defineConfig, esmExternalRequirePlugin } from "vite-plus";

const repositoryRoot = NodePath.resolve(import.meta.dirname, "../..");
const sourceTrees = [
  "apps/server/src",
  "packages/contracts/src",
  "packages/effect-acp/src",
  "packages/effect-codex-app-server/src",
  "packages/provider-acp/src",
  "packages/provider-acp-registry/src",
  "packages/provider-core/src",
  "packages/provider-cursor/src",
  "packages/provider-fx/src",
  "packages/provider-grok/src",
  "packages/provider-kiro/src",
  "packages/provider-muse/src",
  "packages/provider-opencode/src",
  "packages/provider-pi/src",
  "packages/provider-runtime/src",
  "packages/shared/src",
].map((tree) => NodePath.join(repositoryRoot, tree));

function listDeclarationFiles(): Set<string> {
  const files = new Set<string>();
  for (const tree of sourceTrees) {
    if (!NodeFS.existsSync(tree)) continue;
    for (const entry of NodeFS.readdirSync(tree, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".d.ts")) {
        files.add(NodePath.join(entry.parentPath, entry.name));
      }
    }
  }
  return files;
}

/**
 * The bundle reaches into the server sources, and the TypeScript 7 declaration
 * generator writes a `.d.ts` beside every source it visits. Remove the files this
 * build created so the repository stays clean; files that existed before stay.
 */
let declarationsBeforeBuild = new Set<string>();

const serverSettings = NodePath.join(repositoryRoot, "apps/server/src/serverSettings.ts");
const serverSettingsKey = NodePath.join(import.meta.dirname, "src/server-settings-key.ts");
const markdownMath = NodePath.join(repositoryRoot, "packages/shared/src/markdownMath.ts");
// jsonc-parser's `main` is a UMD build whose relative requires break once bundled.
const jsoncParserEsm = NodePath.join(
  NodePath.dirname(
    NodeModule.createRequire(
      NodePath.join(repositoryRoot, "packages/provider-cursor/package.json"),
    ).resolve("jsonc-parser/package.json"),
  ),
  "lib/esm/main.js",
);

/**
 * Keeps server code the runtime never runs out of the bundle: the settings store (every
 * source-control driver and Undici) becomes its service key, and the math parser, which builds
 * a remark pipeline at load for a module Codex reads one regex from, stays out unless called.
 */
const runtimeOnly = {
  name: "provider-runtime:runtime-only",
  resolveId(source: string, importer: string | undefined) {
    if (source === "jsonc-parser") return jsoncParserEsm;
    if (!importer || !source.endsWith(".ts")) return null;
    const resolved = NodePath.resolve(NodePath.dirname(importer), source);
    if (resolved === serverSettings) return serverSettingsKey;
    if (resolved === markdownMath) return { id: resolved, moduleSideEffects: false };
    return null;
  },
};

export default defineConfig({
  pack: {
    // The ACP adapters start the bridge as a child process of the host's Node.
    entry: ["src/index.ts", "src/acp-mcp-bridge.ts"],
    outDir: "dist",
    // Workers accept these Node builtins through ESM, but not createRequire.
    plugins: [
      esmExternalRequirePlugin({ external: [/^(node:)?(?:process|buffer)$/] }),
      runtimeOnly,
    ],
    hooks: {
      "build:prepare": () => {
        declarationsBeforeBuild = listDeclarationFiles();
      },
      "build:done": () => {
        for (const file of listDeclarationFiles()) {
          if (!declarationsBeforeBuild.has(file)) NodeFS.rmSync(file, { force: true });
        }
      },
    },
    deps: {
      // Publish the Node adapters built against our locked Effect version. Their
      // transitive prerelease ranges can otherwise install incompatible adapters.
      alwaysBundle: [
        /^@effect\/platform-node(?:-shared)?(?:\/|$)/,
        /^@t3tools\/provider-[a-z-]+(?:\/|$)/,
        /^@t3tools\/shared(?:\/|$)/,
        /^effect-(?:acp|codex-app-server)(?:\/|$)/,
      ],
      onlyBundle: false,
    },
  },
});
