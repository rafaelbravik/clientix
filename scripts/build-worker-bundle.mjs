// @ts-check
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const esbuildPath = require.resolve("esbuild", { paths: [require.resolve("tsx")] });
const esbuild = require(esbuildPath);

const target = process.argv[2]; // "worker" | "voice-agent" | "sonda"

const aliasPlugin = {
  name: "alias-plugin",
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => {
      const rel = args.path.slice(2);
      const full = path.resolve(process.cwd(), rel);
      for (const ext of ["", ".ts", ".tsx", ".js", "/index.ts", "/index.js"]) {
        const candidate = full + ext;
        if (fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory()) {
          return { path: candidate };
        }
      }
      return { path: full };
    });
  },
};

const entries = {
  worker: {
    entryPoints: ["workers/agent-worker/main.ts"],
    outfile: "dist/worker/main.js",
  },
  "voice-agent": {
    entryPoints: ["workers/voice-agent/index.ts"],
    outfile: "dist/voice-agent/index.js",
  },
  sonda: {
    entryPoints: ["scripts/sonda-do-laco-de-event-log.ts"],
    outfile: "dist/sonda/sonda.js",
  },
};

const config = entries[target];
if (!config) {
  console.error("Uso: node scripts/build-worker-bundle.mjs <worker|voice-agent|sonda>");
  process.exit(1);
}

fs.mkdirSync(path.dirname(config.outfile), { recursive: true });

try {
  await esbuild.build({
    entryPoints: config.entryPoints,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: config.outfile,
    sourcemap: false,
    packages: "external",
    plugins: [aliasPlugin],
  });
  console.log(`[build-worker-bundle] ${target} -> ${config.outfile} OK`);
} catch (err) {
  console.error(`[build-worker-bundle] Falha ao compilar ${target}:`, err);
  process.exit(1);
}
