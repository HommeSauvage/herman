import { $ } from "bun";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    dev: { type: "boolean", default: false },
  },
  strict: false,
});

const isDev = values.dev ?? false;

if (isDev) {
  console.log("Herman dev prebuild complete (renderer handled by electrobun dev).");
} else {
  console.log("Building Herman agent…");
  await $`bun run --filter=@herman/agent build`;
  console.log("Building Herman renderer…");
  await $`bun node_modules/vite/dist/node/cli.js build`;
  console.log("Herman prebuild complete.");
}
