import { cp, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { dispose, getLogger } from "@logtape/logtape";
import { $ } from "bun";

import { configureLogging } from "../src/logging.js";

const logger = getLogger(["herman-desktop", "prebuild"]);

/**
 * The photon wasm is used by pi's image-resize path (read tool). The JS is
 * bundled into the compiled agent binary, but the wasm file must be co-located
 * next to the binary — pi's own build:binary does the same copy. Without it,
 * loadPhoton() degrades gracefully (images are omitted rather than resized),
 * but we copy it to preserve full image-reading functionality.
 */
async function copyPhotonWasm(agentDist: string): Promise<void> {
  const desktopPkg = join(process.cwd(), "package.json");
  let wasmSrc: string | undefined;
  try {
    // @silvia-odwyer/photon-node is a transitive dep of @earendil-works/pi-coding-agent.
    // Resolve through that chain, then walk to the package root for the wasm.
    const piPkg = Bun.resolveSync("@earendil-works/pi-coding-agent", desktopPkg);
    const photonEntry = Bun.resolveSync("@silvia-odwyer/photon-node", piPkg);
    wasmSrc = join(
      await resolvePkgRoot("@silvia-odwyer/photon-node", photonEntry),
      "photon_rs_bg.wasm",
    );
  } catch {
    logger.warning(
      "Could not resolve @silvia-odwyer/photon-node; image resize will be unavailable",
    );
    return;
  }
  try {
    await cp(wasmSrc, join(agentDist, "photon_rs_bg.wasm"), { force: true });
    logger.info(
      `Copied photon wasm -> ${relative(process.cwd(), join(agentDist, "photon_rs_bg.wasm"))}`,
    );
  } catch {
    logger.warning(`Could not copy photon wasm from ${wasmSrc}; image resize will be unavailable`);
  }
}

async function resolvePkgRoot(spec: string, entry: string): Promise<string> {
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
    logger.info("Building Herman agent (compiled binary)…");
    await $`bun run --filter=@herman/agent build`;
    const agentDist = join(process.cwd(), "..", "..", "packages", "agent", "dist");
    logger.info("Copying photon wasm for image resize…");
    await copyPhotonWasm(agentDist);
    logger.info("Building Herman renderer…");
    await $`bun node_modules/vite/dist/node/cli.js build`;
    logger.info("Herman prebuild complete.");
  }
} finally {
  await dispose();
}
