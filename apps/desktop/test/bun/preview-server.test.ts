import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestTempDir } from "../helpers/temp-dir.js";
import {
  allocatePorts,
  buildExportEnv,
  findFreePort,
  startAllDevServers,
  stopDevServer,
  waitForReady,
} from "../../src/bun/preview-server.js";
import type { DevServer } from "../../src/shared/herman-manifest.js";

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
    const http = createHttpServer((_req, res) => {
      res.statusCode = 200;
      res.end("ok");
    });
    const httpPort = await new Promise<number>((resolve, reject) => {
      http.once("error", reject);
      http.listen(0, "127.0.0.1", () => {
        const address = http.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to resolve HTTP test port"));
          return;
        }
        resolve(address.port);
      });
    });
    await waitForReady(`http://127.0.0.1:${httpPort}`, 3000);
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
});

describe("allocatePorts", () => {
  it("gives distinct ports when two servers prefer the same port", async () => {
    const ports = await allocatePorts([
      { id: "a", port: testPort },
      { id: "b", port: testPort },
    ]);
    expect(ports.get("a")).toBeDefined();
    expect(ports.get("b")).toBeDefined();
    expect(ports.get("a")).not.toBe(ports.get("b"));
    expect(ports.get("a")).toBeGreaterThanOrEqual(testPort);
    expect(ports.get("b")).toBeGreaterThanOrEqual(testPort);
  });
});

describe("buildExportEnv", () => {
  it("maps exportUrlAs aliases to resolved localhost URLs", () => {
    const servers: DevServer[] = [
      {
        id: "api",
        label: "API",
        command: "bun run dev:api",
        port: 3010,
        exportUrlAs: ["API_SERVER", "API_URL"],
      },
      {
        id: "web",
        label: "Web",
        command: "bun run dev:web",
        port: 3000,
        primary: true,
      },
    ];
    const ports = new Map([
      ["api", 13110],
      ["web", 13000],
    ]);
    const env = buildExportEnv(servers, ports);
    expect(env).toEqual({
      API_SERVER: "http://localhost:13110",
      API_URL: "http://localhost:13110",
    });
  });

  it("supports a single string exportUrlAs", () => {
    const servers: DevServer[] = [
      {
        id: "api",
        label: "API",
        command: "echo",
        exportUrlAs: "API_SERVER",
      },
    ];
    const env = buildExportEnv(servers, new Map([["api", 9999]]));
    expect(env.API_SERVER).toBe("http://localhost:9999");
  });
});

describe("startAllDevServers export injection", () => {
  it("injects sibling exportUrlAs env into spawned children", async () => {
    const dir = createTestTempDir("herman-preview-export-");
    // Skip bun/npm install inside startDevServer.
    mkdirSync(join(dir, "node_modules"), { recursive: true });

    const writeScript = (path: string, role: string) => {
      writeFileSync(
        path,
        `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const port = Number(process.env.PORT);
writeFileSync(${JSON.stringify(join(dir, `${role}-env.json`))}, JSON.stringify({
  PORT: process.env.PORT,
  API_SERVER: process.env.API_SERVER,
  API_URL: process.env.API_URL,
}));
createServer((_req, res) => { res.writeHead(200); res.end("ok"); }).listen(port, "127.0.0.1");
`,
      );
    };

    const apiScript = join(dir, "api.ts");
    const webScript = join(dir, "web.ts");
    writeScript(apiScript, "api");
    writeScript(webScript, "web");

    const result = await startAllDevServers(dir, [
      {
        id: "api",
        label: "API",
        command: `bun ${apiScript}`,
        port: 46001,
        exportUrlAs: ["API_SERVER", "API_URL"],
      },
      {
        id: "web",
        label: "Web",
        command: `bun ${webScript}`,
        port: 46002,
        primary: true,
      },
    ]);

    try {
      expect(result.serverId).toBe("web");
      const apiEnv = JSON.parse(
        await Bun.file(join(dir, "api-env.json")).text(),
      ) as Record<string, string>;
      const webEnv = JSON.parse(
        await Bun.file(join(dir, "web-env.json")).text(),
      ) as Record<string, string>;

      expect(apiEnv.API_SERVER).toMatch(/^http:\/\/localhost:\d+$/);
      expect(apiEnv.API_URL).toBe(apiEnv.API_SERVER);
      expect(webEnv.API_SERVER).toBe(apiEnv.API_SERVER);
      expect(webEnv.API_URL).toBe(apiEnv.API_SERVER);
      expect(apiEnv.PORT).not.toBe(webEnv.PORT);
      expect(webEnv.API_SERVER).toContain(`:${apiEnv.PORT}`);
    } finally {
      await stopDevServer(dir);
    }
  });
});
