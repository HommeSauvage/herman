import { describe, expect, it } from "vitest";

import {
  compileResolvedKeybindings,
  DEFAULT_KEYBINDINGS,
  formatShortcutLabel,
  getShortcutLabelForCommand,
  parseKeybindingShortcut,
  resolveShortcutCommand,
} from "../../../../src/views/main/lib/commands.js";

function makeKeyEvent(init: {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
} {
  return {
    key: init.key,
    code: init.code,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
  };
}

describe("parseKeybindingShortcut", () => {
  it("parses a simple key", () => {
    expect(parseKeybindingShortcut("t")).toEqual({
      key: "t",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: false,
    });
  });

  it("parses mod modifiers", () => {
    expect(parseKeybindingShortcut("mod+t")).toEqual({
      key: "t",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: true,
    });
  });

  it("parses compound modifiers", () => {
    expect(parseKeybindingShortcut("mod+shift+[")).toEqual({
      key: "[",
      metaKey: false,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      modKey: true,
    });
  });

  it("normalizes escape", () => {
    expect(parseKeybindingShortcut("esc")?.key).toBe("escape");
  });

  it("returns null for invalid bindings", () => {
    expect(parseKeybindingShortcut("")).toBeNull();
    expect(parseKeybindingShortcut("mod+t+k")).toBeNull();
  });

  it("parses a literal plus key", () => {
    expect(parseKeybindingShortcut("mod++")).toEqual({
      key: "+",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: true,
    });
  });
});

describe("compileResolvedKeybindings", () => {
  it("compiles only valid bindings", () => {
    const result = compileResolvedKeybindings([
      { key: "mod+t", command: "tab.new" },
      { key: "mod+t+k", command: "tab.close" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.command).toBe("tab.new");
  });
});

const RESOLVED_KEYBINDINGS = compileResolvedKeybindings(DEFAULT_KEYBINDINGS);

describe("resolveShortcutCommand", () => {
  it("resolves mod+t to tab.new", () => {
    const event = makeKeyEvent({ key: "t", metaKey: true });
    expect(resolveShortcutCommand(event, RESOLVED_KEYBINDINGS, "MacIntel")).toBe("tab.new");
  });

  it("resolves mod+shift+[ to tab.activate.previous", () => {
    const event = makeKeyEvent({ key: "{", code: "BracketLeft", metaKey: true, shiftKey: true });
    expect(resolveShortcutCommand(event, RESOLVED_KEYBINDINGS, "MacIntel")).toBe(
      "tab.activate.previous",
    );
  });

  it("resolves mod+digit to tab activation", () => {
    const event = makeKeyEvent({ key: "3", code: "Digit3", metaKey: true });
    expect(resolveShortcutCommand(event, RESOLVED_KEYBINDINGS, "MacIntel")).toBe("tab.activate.3");
  });

  it("returns null for unmatched shortcuts", () => {
    const event = makeKeyEvent({ key: "z", metaKey: true });
    expect(resolveShortcutCommand(event, RESOLVED_KEYBINDINGS, "MacIntel")).toBeNull();
  });

  it("returns null when typing without modifiers", () => {
    const event = makeKeyEvent({ key: "t" });
    expect(resolveShortcutCommand(event, RESOLVED_KEYBINDINGS, "MacIntel")).toBeNull();
  });
});

describe("formatShortcutLabel", () => {
  it("formats mac shortcuts with symbols", () => {
    const shortcut = parseKeybindingShortcut("mod+shift+m")!;
    expect(formatShortcutLabel(shortcut, "MacIntel")).toBe("⇧⌘M");
  });

  it("formats windows shortcuts with text", () => {
    const shortcut = parseKeybindingShortcut("mod+shift+m")!;
    expect(formatShortcutLabel(shortcut, "Win32")).toBe("Ctrl+Shift+M");
  });

  it("formats simple keys", () => {
    const shortcut = parseKeybindingShortcut("mod+1")!;
    expect(formatShortcutLabel(shortcut, "MacIntel")).toBe("⌘1");
  });
});

describe("getShortcutLabelForCommand", () => {
  it("returns the label for a bound command", () => {
    expect(getShortcutLabelForCommand("tab.new", RESOLVED_KEYBINDINGS, "MacIntel")).toBe("⌘T");
  });

  it("returns null for an unbound command", () => {
    expect(getShortcutLabelForCommand("view.home", RESOLVED_KEYBINDINGS, "MacIntel")).toBeNull();
  });
});
