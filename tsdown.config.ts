/**
 * tsdown config for the dsh-document-review client bundle.
 *
 * Replicates DSH's packages/client/tsdown.client.ts `clientConfig`: a CJS
 * closure-factory artifact that calls window.__ModuleLoader__.load({ id,
 * factory }) and resolves externals through the injected require (the loader's
 * frozen module table). The platform externals list is copied from
 * packages/client/web/src/platform.ts of the targeted DSH checkout.
 */

import { fileURLToPath } from "node:url";
import { dirname, relative, resolve as resolvePath, sep } from "node:path";
import type { UserConfig } from "tsdown";

const PLUGIN_ID = "dsh-document-review";

// Platform module table seeded by the DSH web shell (copy from
// packages/client/web/src/platform.ts). These stay external — the frozen
// module table answers them at runtime.
const CLIENT_EXTERNALS = [
  "react", "react/jsx-runtime", "react-dom", "react-dom/client", "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-web-react",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-attachment",
  "@deepseek-ai/dsh-client-schema-form",
  "@deepseek-ai/dsh-client-runtime/client",
];

const REPOSITORY_ROOT = dirname(fileURLToPath(import.meta.url));

function browserSourcePath(source: string, sourcemapPath: string): string {
  if (!source.startsWith(".")) return source;
  const physicalSource = resolvePath(dirname(sourcemapPath), source);
  const repositoryPath = relative(REPOSITORY_ROOT, physicalSource).split(sep).join("/");
  return repositoryPath.startsWith("src/") ? repositoryPath : source;
}

export default {
  name: `${PLUGIN_ID}/client`,
  entry: { client: "lib/client/index.js" },
  outDir: "lib",
  format: ["cjs"],
  platform: "browser",
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
  },
  outputOptions: {
    entryFileNames: "client.js",
    sourcemapPathTransform: browserSourcePath,
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: "return module.exports; } });",
    intro: "var module = { exports: {} }; var exports = module.exports;",
  },
} as UserConfig;
