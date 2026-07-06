import { spawn } from "bun";

const vite = spawn({
  cmd: ["bun", "node_modules/vite/dist/node/cli.js"],
  stdout: "inherit",
  stderr: "inherit",
});

const electrobun = spawn({
  cmd: ["bunx", "electrobun", "dev"],
  env: {
    ...process.env,
    HERMAN_DESKTOP_DEV_URL: "http://localhost:3456",
  },
  stdout: "inherit",
  stderr: "inherit",
});

function shutdown() {
  vite.kill("SIGTERM");
  electrobun.kill("SIGTERM");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.all([vite.exited, electrobun.exited]);
