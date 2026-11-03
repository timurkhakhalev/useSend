import { defineConfig } from "tsup";
import { fileURLToPath } from "node:url";
import pkg from "./package.json" with { type: "json" };

// The CLI ships as a single self-contained ESM file. `usesend-js` (webhook
// verification) and `commander` are bundled so `npm i -g usesend-cli` has no
// runtime dependencies and works without building the SDK first.
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  clean: true,
  dts: false,
  splitting: false,
  // commander is CJS; give the ESM bundle a real `require` for its node: builtins.
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __cr } from "node:module";\nconst require = __cr(import.meta.url);',
  },
  define: { __VERSION__: JSON.stringify(pkg.version) },
  noExternal: ["usesend-js", "commander", "@usesend/lib"],
  esbuildOptions(options) {
    options.alias = {
      "usesend-js": fileURLToPath(new URL("../sdk/index.ts", import.meta.url)),
    };
  },
});
