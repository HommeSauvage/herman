import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findFreePort, waitForReady } from "./preview-server.js";

let server: ReturnType<typeof createServer> | undefined;
const testPort = 45991;

beforeAll(async () => {
  server = createServer();
  await new Promise<void>((resolve) => {
    server!.listen(testPort, "127.0.0.1", () => resolve());
  });
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
});

describe("preview server helpers", () => {
  it("finds a free port when preferred is taken", async () => {
    const free = await findFreePort(testPort);
    expect(free).toBeGreaterThan(testPort);
  });

  it("waits for an HTTP endpoint to become ready", async () => {
    const httpPort = await findFreePort(46020);
    const http = createHttpServer((_req, res) => {
      res.statusCode = 200;
      res.end("ok");
    });
    await new Promise<void>((resolve) => http.listen(httpPort, "127.0.0.1", () => resolve()));
    await waitForReady(`http://127.0.0.1:${httpPort}`, 3000);
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
});
