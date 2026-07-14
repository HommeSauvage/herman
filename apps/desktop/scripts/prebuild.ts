import { dispose, getLogger } from "@logtape/logtape";
import { $ } from "bun";
import { parseArgs } from "node:util";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { configureLogging } from "../src/logging.js";

const logger = getLogger(["herman-desktop", "prebuild"]);

/**
 * Pi's extension loader uses `import.meta.resolve` (ESM resolution) to alias
 * these packages. They must be resolvable from the bundled agent's location.
 * The agent is a `bun build` bundle (not `--compile`), so these aren't in its
 * node_modules. Copy dereferenced copies into `packages/agent/dist/node_modules/`
 * so the wizard extension (and any future external extension) can load in
 * production. Each specifier matches what getAliases() resolves.
 */
const AGENT_EXT_DEPS: [packageName: string, resolveSpec: string][] = [
  ["typebox", "typebox"],
  ["@earendil-works/pi-ai", "@earendil-works/pi-ai/compat"],
  ["@earendil-works/pi-tui", "@earendil-works/pi-tui"],
  ["@earendil-works/pi-agent-core", "@earendil-works/pi-agent-core"],
];

async function copyAgentExtensionDeps(): Promise<void> {
  // Resolve using Bun's ESM resolution from @herman/agent's location.
  const workspaceRoot = join(process.cwd(), "..", "..");
  const agentPkg = join(workspaceRoot, "packages", "agent", "package.json");
  const agentDist = join(workspaceRoot, "packages", "agent", "dist");
  const destModules = join(agentDist, "node_modules");
  await rm(destModules, { recursive: true, force: true });
  for (const [pkgName, resolveSpec] of AGENT_EXT_DEPS) {
    const entry = Bun.resolveSync(resolveSpec, agentPkg);
    const srcPkgRoot = await resolvePkgRoot(pkgName, entry);
    const destPkgRoot = join(destModules, pkgName);
    await mkdir(dirname(destPkgRoot), { recursive: true });
    await cp(srcPkgRoot, destPkgRoot, { recursive: true, dereference: true });
    logger.info(`Copied agent ext dep ${pkgName} -> ${relative(process.cwd(), destPkgRoot)}`);
  }
}

async function resolvePkgRoot(spec: string, entry: string): Promise<string> {
  // Walk up from the resolved entry to the nearest package.json whose name matches the spec.
  const { readFile } = await import("node:fs/promises");
  let dir = dirname(entry);
  while (dir !== "/") {
    const pkgPath = join(dir, "package.json");
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf-8")) as { name?: string };
      if (pkg.name === spec) return dir;
    } catch {
      // not a package.json here — keep walking
    }
    dir = dirname(dir);
  }
  throw new Error(`Could not locate package root for ${spec} (from ${entry})`);
}

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    dev: { type: "boolean", default: false },
  },
  strict: false,
});

const isDev = values.dev ?? false;

await configureLogging();

try {
  if (isDev) {
    logger.info("Herman dev prebuild complete (renderer handled by electrobun dev).");
  } else {
    logger.info("Building Herman agent…");
    await $`bun run --filter=@herman/agent build`;
    logger.info("Copying agent extension deps…");
    await copyAgentExtensionDeps();
    logger.info("Building Herman renderer…");
    await $`bun node_modules/vite/dist/node/cli.js build`;
    logger.info("Herman prebuild complete.");
  }
} finally {
  await dispose();
}
