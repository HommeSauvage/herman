import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createTestTempDir } from "../helpers/temp-dir.js";
import {
  allocatePorts,
  buildExportEnv,
  ensurePreviewStarted,
  findFreePort,
  getDevServerStatus,
  probeUrlForPort,
  setPreviewStatusHandler,
  startAllDevServers,
  startDevServer,
  stopAllDevServers,
  stopDevServer,
  waitForReady,
} from "../../src/bun/preview-server.js";
import type { PreviewServerSnapshot } from "../../src/shared/preview.js";
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

function waitForStatus(
  folderPath: string,
  predicate: (payload: PreviewServerSnapshot) => boolean,
  timeoutMs = 10_000,
): Promise<PreviewServerSnapshot> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      setPreviewStatusHandler(() => undefined);
      reject(new Error(`Timed out waiting for preview status (${timeoutMs}ms)`));
    }, timeoutMs);

    setPreviewStatusHandler((payload) => {
      if (payload.folderPath !== folderPath) return;
      if (!predicate(payload)) return;
      clearTimeout(timer);
      setPreviewStatusHandler(() => undefined);
      resolve(payload);
    });
  });
}

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
  afterEach(async () => {
    setPreviewStatusHandler(() => undefined);
    await stopAllDevServers();
  });

  it("injects sibling exportUrlAs env into spawned children", async () => {
    const dir = createTestTempDir("herman-preview-export-");
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

    const ready = waitForStatus(dir, (p) => p.phase === "ready" && Boolean(p.url));

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
      expect(result.starting).toBe(true);
      await ready;

      await waitForReady(probeUrlForPort(result.port!), 5_000);
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

  it("passes quoted command arguments intact via sh -c", async () => {
    const dir = createTestTempDir("herman-preview-quoted-");
    mkdirSync(join(dir, "node_modules"), { recursive: true });

    const scriptPath = join(dir, "ready.ts");
    writeFileSync(
      scriptPath,
      `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(dir, "args.json"))}, JSON.stringify(process.argv.slice(2)));
const port = Number(process.env.PORT);
createServer((_req, res) => { res.writeHead(200); res.end("ok"); }).listen(port, "127.0.0.1");
`,
    );

    const port = await findFreePort(46600);
    const ready = waitForStatus(dir, (p) => p.phase === "ready");
    try {
      await startDevServer(dir, {
        serverId: "web",
        command: `bun ${scriptPath} --label "hello world"`,
        resolvedPort: port,
        primary: true,
        readyTimeoutMs: 10_000,
      });
      await ready;
      const args = JSON.parse(await Bun.file(join(dir, "args.json")).text()) as string[];
      expect(args).toContain("--label");
      expect(args).toContain("hello world");
    } finally {
      await stopDevServer(dir);
    }
  });
});

describe("async preview start", () => {
  afterEach(async () => {
    setPreviewStatusHandler(() => undefined);
    await stopAllDevServers();
  });

  it("returns before HTTP ready and emits ready only after probe succeeds", async () => {
    const dir = createTestTempDir("herman-preview-async-");
    mkdirSync(join(dir, "node_modules"), { recursive: true });

    const scriptPath = join(dir, "delay-ready.ts");
    writeFileSync(
      scriptPath,
      `
import { createServer } from "node:http";
const port = Number(process.env.PORT);
setTimeout(() => {
  createServer((_req, res) => { res.writeHead(200); res.end("ok"); })
    .listen(port, "127.0.0.1");
}, 500);
`,
    );

    const port = await findFreePort(46200);
    const readyPromise = waitForStatus(dir, (p) => p.phase === "ready" && Boolean(p.url), 10_000);

    const result = await startDevServer(dir, {
      serverId: "web",
      command: `bun ${scriptPath}`,
      resolvedPort: port,
      primary: true,
      readyTimeoutMs: 10_000,
    });

    expect(result.phase === "starting" || result.starting).toBe(true);
    expect(result.starting).toBe(true);
    expect(getDevServerStatus(dir, "web").servers[0]?.phase).not.toBe("ready");

    try {
      const ready = await readyPromise;
      expect(ready.phase).toBe("ready");
      expect(ready.url).toBe(`http://localhost:${port}`);
      expect(getDevServerStatus(dir, "web").servers[0]?.phase).toBe("ready");
    } finally {
      await stopDevServer(dir);
    }
  });

  it("resumes an existing server after readiness timeout without spawning twice", async () => {
    const dir = createTestTempDir("herman-preview-resume-");
    mkdirSync(join(dir, "node_modules"), { recursive: true });

    const scriptPath = join(dir, "delay-ready.ts");
    writeFileSync(
      scriptPath,
      `
import { createServer } from "node:http";
const port = Number(process.env.PORT);
setTimeout(() => {
  createServer((_req, res) => { res.writeHead(200); res.end("ok"); })
    .listen(port, "127.0.0.1");
}, 2500);
`,
    );

    const command = `bun ${scriptPath}`;
    const port = await findFreePort(46100);

    const first = await startDevServer(dir, {
      serverId: "web",
      command,
      resolvedPort: port,
      primary: true,
      readyTimeoutMs: 800,
    });
    expect(first.starting).toBe(true);

    const timeoutStatus = await waitForStatus(
      dir,
      (p) => p.phase === "failed" && Boolean(p.error && /did not become ready/.test(p.error)),
      5_000,
    );
    expect(timeoutStatus.error).toMatch(/did not become ready/);

    const status = getDevServerStatus(dir, "web");
    expect(status.servers.length).toBe(1);
    expect(status.servers[0]?.url).toBe(`http://localhost:${port}`);

    try {
      const second = await startDevServer(dir, {
        serverId: "web",
        command,
        resolvedPort: port,
        primary: true,
        readyTimeoutMs: 10_000,
      });
      expect(second.port).toBe(port);
      expect(second.starting || second.phase === "ready").toBe(true);

      const ready = await waitForStatus(dir, (p) => p.phase === "ready" && Boolean(p.url), 10_000);
      expect(ready.url).toBe(`http://localhost:${port}`);
    } finally {
      await stopDevServer(dir);
    }
  });

  it("single-flights ensurePreviewStarted so concurrent kicks do not double-spawn", async () => {
    const dir = createTestTempDir("herman-preview-flight-");
    mkdirSync(join(dir, "node_modules"), { recursive: true });

    const scriptPath = join(dir, "delay-ready.ts");
    writeFileSync(
      scriptPath,
      `
import { createServer } from "node:http";
const port = Number(process.env.PORT);
setTimeout(() => {
  createServer((_req, res) => { res.writeHead(200); res.end("ok"); })
    .listen(port, "127.0.0.1");
}, 800);
`,
    );

    const port = await findFreePort(46400);
    const ready = waitForStatus(dir, (p) => p.phase === "ready" && Boolean(p.url));

    const [a, b] = await Promise.all([
      ensurePreviewStarted(dir, {
        serverId: "web",
        command: `bun ${scriptPath}`,
        port,
        readyTimeoutMs: 10_000,
      }),
      ensurePreviewStarted(dir, {
        serverId: "web",
        command: `bun ${scriptPath}`,
        port,
        readyTimeoutMs: 10_000,
      }),
    ]);

    expect(a.starting || a.phase === "ready").toBe(true);
    expect(b.starting || b.phase === "ready").toBe(true);

    try {
      await ready;
      const status = getDevServerStatus(dir, "web");
      expect(status.servers.length).toBe(1);
    } finally {
      await stopDevServer(dir);
    }
  });

  it("does not surface SIGTERM as an error when stopDevServer kills the process", async () => {
    const dir = createTestTempDir("herman-preview-sigterm-");
    mkdirSync(join(dir, "node_modules"), { recursive: true });

    const scriptPath = join(dir, "ready.ts");
    writeFileSync(
      scriptPath,
      `
import { createServer } from "node:http";
const port = Number(process.env.PORT);
createServer((_req, res) => { res.writeHead(200); res.end("ok"); }).listen(port, "127.0.0.1");
`,
    );

    const port = await findFreePort(46500);
    const errors: string[] = [];
    setPreviewStatusHandler((p) => {
      if (p.folderPath === dir && p.phase === "failed" && p.error) errors.push(p.error);
    });

    await startDevServer(dir, {
      serverId: "web",
      command: `bun ${scriptPath}`,
      resolvedPort: port,
      primary: true,
      readyTimeoutMs: 10_000,
    });
    await waitForStatus(dir, (p) => p.phase === "ready" && Boolean(p.url), 10_000);

    await stopDevServer(dir);
    await new Promise((r) => setTimeout(r, 200));

    expect(errors).toEqual([]);
  });

  it("skips installCommand when node_modules exists", async () => {
    const dir = createTestTempDir("herman-preview-skip-install-");
    mkdirSync(join(dir, "node_modules"), { recursive: true });

    const scriptPath = join(dir, "ready.ts");
    writeFileSync(
      scriptPath,
      `
import { createServer } from "node:http";
const port = Number(process.env.PORT);
createServer((_req, res) => { res.writeHead(200); res.end("ok"); }).listen(port, "127.0.0.1");
`,
    );

    const port = await findFreePort(46300);
    const ready = waitForStatus(dir, (p) => p.phase === "ready" && Boolean(p.url));
    try {
      const result = await startDevServer(dir, {
        serverId: "web",
        command: `bun ${scriptPath}`,
        resolvedPort: port,
        primary: true,
        installCommand: "exit 1",
        readyTimeoutMs: 10_000,
      });
      expect(result.url).toBe(`http://localhost:${port}`);
      await ready;
    } finally {
      await stopDevServer(dir);
    }
  });
});
