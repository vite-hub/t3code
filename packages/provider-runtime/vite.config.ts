import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    outDir: "dist",
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
