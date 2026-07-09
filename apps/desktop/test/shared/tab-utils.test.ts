import { describe, expect, it } from "vitest";

import {
  getProjectColor,
  getProjectInitial,
  getProjectName,
  hasUserOrAssistantMessage,
  PROJECT_COLORS,
} from "../../src/shared/tab-utils.js";

describe("getProjectName", () => {
  it("returns the basename of a unix path", () => {
    expect(getProjectName("/home/user/my-project")).toBe("my-project");
  });

  it("returns the basename of a windows path", () => {
    expect(getProjectName("C:\\Users\\user\\my-project")).toBe("my-project");
  });

  it("handles paths without separators", () => {
    expect(getProjectName("my-project")).toBe("my-project");
  });

  it("returns the original path for root", () => {
    expect(getProjectName("/")).toBe("/");
  });

  it("returns an empty string for an empty path", () => {
    expect(getProjectName("")).toBe("");
  });
});

describe("getProjectInitial", () => {
  it("returns the uppercase first letter of the project name", () => {
    expect(getProjectInitial("/home/user/my-project")).toBe("M");
  });

  it("returns an empty string when there is no project name", () => {
    expect(getProjectInitial("")).toBe("");
  });
});

describe("getProjectColor", () => {
  it("is deterministic for the same folder path", () => {
    const folderPath = "/home/user/my-project";
    expect(getProjectColor(folderPath)).toBe(getProjectColor(folderPath));
  });

  it("returns a color from the project color palette", () => {
    const color = getProjectColor("/home/user/my-project");
    expect(PROJECT_COLORS).toContain(color);
  });

  it("produces different colors for different paths", () => {
    const colorA = getProjectColor("/project-a");
    const colorB = getProjectColor("/project-b");
    expect(colorA).not.toBe(colorB);
  });
});

describe("hasUserOrAssistantMessage", () => {
  it("returns false for an empty message list", () => {
    expect(hasUserOrAssistantMessage([])).toBe(false);
  });

  it("returns false when only tool messages exist", () => {
    expect(hasUserOrAssistantMessage([{ role: "tool" }, { role: "tool" }])).toBe(false);
  });

  it("returns true when a user message exists", () => {
    expect(hasUserOrAssistantMessage([{ role: "tool" }, { role: "user" }])).toBe(true);
  });

  it("returns true when an assistant message exists", () => {
    expect(hasUserOrAssistantMessage([{ role: "assistant" }])).toBe(true);
  });
});
