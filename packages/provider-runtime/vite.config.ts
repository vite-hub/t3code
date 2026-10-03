import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { defineConfig, esmExternalRequirePlugin } from "vite-plus";

const repositoryRoot = NodePath.resolve(import.meta.dirname, "../..");
const sourceTrees = [
  "apps/server/src",
  "packages/contracts/src",
  "packages/effect-codex-app-server/src",
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

export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    outDir: "dist",
    // Workers accept these Node builtins through ESM, but not createRequire.
    plugins: [esmExternalRequirePlugin({ external: [/^(node:)?(?:process|buffer)$/] })],
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
        /^@t3tools\/shared(?:\/|$)/,
        /^effect-codex-app-server(?:\/|$)/,
      ],
      onlyBundle: false,
    },
  },
});
