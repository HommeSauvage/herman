import { getLogger } from "@logtape/logtape";
import { $ } from "bun";
import { parseArgs } from "node:util";

import { configureLogging } from "../src/logging.js";

const logger = getLogger(["herman-desktop", "prebuild"]);

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    dev: { type: "boolean", default: false },
  },
  strict: false,
});

const isDev = values.dev ?? false;

await configureLogging();

if (isDev) {
  logger.info("Herman dev prebuild complete (renderer handled by electrobun dev).");
} else {
  logger.info("Building Herman agent…");
  await $`bun run --filter=@herman/agent build`;
  logger.info("Building Herman renderer…");
  await $`bun node_modules/vite/dist/node/cli.js build`;
  logger.info("Herman prebuild complete.");
}
