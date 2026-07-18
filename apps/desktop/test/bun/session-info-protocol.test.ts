import { describe, expect, it } from "vitest";

import { tryParseSessionInfoRequest } from "../../src/shared/agent-protocol.js";
import {
  SESSION_INFO_SENTINEL,
  buildSessionInfoResponse,
  encodeSessionInfoRequest,
  encodeSessionInfoResponse,
  parseSessionInfoResponse,
  tryParseSessionInfoRequestEnvelope,
} from "../../src/shared/session-info-protocol.js";

describe("session-info-protocol", () => {
  it("round-trips a request envelope through encode/parse", () => {
    const encoded = encodeSessionInfoRequest();
    const parsed = tryParseSessionInfoRequestEnvelope(encoded);
    expect(parsed).toEqual({
      __herman_session_info__: true,
      version: 1,
    });
  });

  it("rejects non-session-info prefill", () => {
    expect(tryParseSessionInfoRequestEnvelope(undefined)).toBeUndefined();
    expect(tryParseSessionInfoRequestEnvelope("just some text")).toBeUndefined();
    expect(tryParseSessionInfoRequestEnvelope(JSON.stringify({ foo: 1 }))).toBeUndefined();
    expect(
      tryParseSessionInfoRequestEnvelope(
        JSON.stringify({ __herman_session_info__: false, version: 1 }),
      ),
    ).toBeUndefined();
    expect(
      tryParseSessionInfoRequestEnvelope(
        JSON.stringify({ __herman_session_info__: true, version: 99 }),
      ),
    ).toBeUndefined();
  });

  it("round-trips a response", () => {
    const response = buildSessionInfoResponse({
      projectPath: "/Users/me/Herman/my-blog",
      projectRoot: "/Users/me/Herman/my-blog",
      mode: "rookie",
      preview: {
        folderPath: "/Users/me/Herman/my-blog",
        primaryServerId: "web",
        phase: "ready",
        servers: [
          {
            folderPath: "/Users/me/Herman/my-blog",
            serverId: "web",
            phase: "ready",
            url: "http://localhost:3001",
            port: 3001,
          },
        ],
      },
    });
    const encoded = encodeSessionInfoResponse(response);
    const parsed = parseSessionInfoResponse(encoded);
    expect(parsed?.preview.primaryUrl).toBe("http://localhost:3001");
    expect(parsed?.preview.servers[0]?.port).toBe(3001);
    expect(parsed?.mode).toBe("rookie");
  });

  it("sets error when no project path", () => {
    const response = buildSessionInfoResponse({
      preview: {
        folderPath: "",
        phase: "stopped",
        servers: [],
      },
    });
    expect(response.error).toBe("No project is open in this tab.");
    expect(response.projectPath).toBe("");
  });

  it("includes worktree details when present", () => {
    const response = buildSessionInfoResponse({
      projectPath: "/Users/me/Herman/.worktrees/tab-1",
      projectRoot: "/Users/me/Herman/my-blog",
      worktree: {
        branch: "herman/tab-1",
        baseBranch: "main",
        mainFolderPath: "/Users/me/Herman/my-blog",
      },
      mode: "rookie",
      preview: {
        folderPath: "/Users/me/Herman/.worktrees/tab-1",
        primaryServerId: "web",
        phase: "ready",
        servers: [
          {
            folderPath: "/Users/me/Herman/.worktrees/tab-1",
            serverId: "web",
            phase: "ready",
            url: "http://localhost:3000",
            port: 3000,
          },
        ],
      },
    });
    expect(response.projectRoot).toBe("/Users/me/Herman/my-blog");
    expect(response.worktree).toEqual({
      folderPath: "/Users/me/Herman/.worktrees/tab-1",
      mainFolderPath: "/Users/me/Herman/my-blog",
      branch: "herman/tab-1",
      baseBranch: "main",
    });
  });

  it("sentinel constant is stable on the wire", () => {
    expect(SESSION_INFO_SENTINEL).toBe("__herman_session_info__");
  });
});

describe("tryParseSessionInfoRequest", () => {
  it("extracts a session-info envelope from an editor extension_ui_request", () => {
    const event = {
      type: "extension_ui_request" as const,
      id: "req-1",
      method: "editor",
      prefill: encodeSessionInfoRequest(),
    };
    const parsed = tryParseSessionInfoRequest(event);
    expect(parsed?.requestId).toBe("req-1");
    expect(parsed?.envelope.__herman_session_info__).toBe(true);
  });

  it("returns undefined for a real editor request", () => {
    expect(
      tryParseSessionInfoRequest({
        type: "extension_ui_request",
        id: "req-2",
        method: "editor",
        prefill: "edit this prose please",
      }),
    ).toBeUndefined();
  });

  it("returns undefined for wizard envelopes", () => {
    expect(
      tryParseSessionInfoRequest({
        type: "extension_ui_request",
        id: "req-3",
        method: "editor",
        prefill: JSON.stringify({
          __herman_wizard__: true,
          version: 1,
          questions: [],
        }),
      }),
    ).toBeUndefined();
  });
});
