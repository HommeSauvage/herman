import { describe, expect, it } from "vitest";

import { encodeSessionInfoRequest, parseSessionInfoResponse } from "../../src/shared/session-info-protocol.js";
import { resolveSessionInfoHostReply } from "../../src/bun/session-info-host.js";

describe("resolveSessionInfoHostReply", () => {
  it("returns a reply with live preview URL for a session-info request", () => {
    const event = {
      type: "extension_ui_request" as const,
      id: "req-session-1",
      method: "editor",
      prefill: encodeSessionInfoRequest(),
    };

    const reply = resolveSessionInfoHostReply(
      event,
      {
        folderPath: "/Users/me/Herman/.worktrees/tab-1",
        projectRoot: "/Users/me/Herman/my-blog",
        worktree: {
          branch: "herman/tab-1",
          baseBranch: "main",
          mainFolderPath: "/Users/me/Herman/my-blog",
        },
        mode: "rookie",
      },
      {
        folderPath: "/Users/me/Herman/.worktrees/tab-1",
        primaryServerId: "web",
        phase: "ready",
        servers: [
          {
            folderPath: "/Users/me/Herman/.worktrees/tab-1",
            serverId: "web",
            phase: "ready",
            url: "http://localhost:3001",
            port: 3001,
          },
        ],
      },
    );

    expect(reply).toBeDefined();
    expect(reply?.requestId).toBe("req-session-1");

    const parsed = parseSessionInfoResponse(reply?.value);
    expect(parsed?.preview.primaryUrl).toBe("http://localhost:3001");
    expect(parsed?.preview.servers[0]?.port).toBe(3001);
    expect(parsed?.projectPath).toBe("/Users/me/Herman/.worktrees/tab-1");
    expect(parsed?.projectRoot).toBe("/Users/me/Herman/my-blog");
    expect(parsed?.mode).toBe("rookie");
    expect(parsed?.worktree?.branch).toBe("herman/tab-1");
    expect(parsed?.error).toBeUndefined();
  });

  it("returns undefined for non-session-info editor requests (must not steal UI)", () => {
    expect(
      resolveSessionInfoHostReply(
        {
          type: "extension_ui_request",
          id: "req-editor",
          method: "editor",
          prefill: "edit this prose",
        },
        { folderPath: "/tmp/project" },
        { folderPath: "/tmp/project", phase: "stopped", servers: [] },
      ),
    ).toBeUndefined();

    expect(
      resolveSessionInfoHostReply(
        {
          type: "extension_ui_request",
          id: "req-wizard",
          method: "editor",
          prefill: JSON.stringify({
            __herman_wizard__: true,
            version: 1,
            questions: [],
          }),
        },
        { folderPath: "/tmp/project" },
        { folderPath: "/tmp/project", phase: "stopped", servers: [] },
      ),
    ).toBeUndefined();
  });

  it("includes an error when no project is open", () => {
    const reply = resolveSessionInfoHostReply(
      {
        type: "extension_ui_request",
        id: "req-empty",
        method: "editor",
        prefill: encodeSessionInfoRequest(),
      },
      {},
      { folderPath: "", phase: "stopped", servers: [] },
    );

    const parsed = parseSessionInfoResponse(reply?.value);
    expect(parsed?.error).toBe("No project is open in this tab.");
    expect(parsed?.preview.phase).toBe("stopped");
  });

  it("reports stopped preview without inventing a URL", () => {
    const reply = resolveSessionInfoHostReply(
      {
        type: "extension_ui_request",
        id: "req-stopped",
        method: "editor",
        prefill: encodeSessionInfoRequest(),
      },
      { folderPath: "/tmp/project", mode: "normal" },
      { folderPath: "/tmp/project", phase: "stopped", servers: [] },
    );

    const parsed = parseSessionInfoResponse(reply?.value);
    expect(parsed?.preview.primaryUrl).toBeUndefined();
    expect(parsed?.preview.phase).toBe("stopped");
    expect(parsed?.projectPath).toBe("/tmp/project");
  });
});
