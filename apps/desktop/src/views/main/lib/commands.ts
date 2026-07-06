const TAB_ACTIVATION_COMMANDS = [
  "tab.activate.1",
  "tab.activate.2",
  "tab.activate.3",
  "tab.activate.4",
  "tab.activate.5",
  "tab.activate.6",
  "tab.activate.7",
  "tab.activate.8",
  "tab.activate.9",
] as const;

export const COMMANDS = [
  "view.home",
  "view.settings",
  "tab.new",
  "tab.close",
  "tab.activate.previous",
  "tab.activate.next",
  ...TAB_ACTIVATION_COMMANDS,
  "project.open",
  "sidebar.toggle",
  "model.selector.toggle",
] as const;

export type CommandId = (typeof COMMANDS)[number];

type KeybindingShortcut = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  modKey: boolean;
};

export type ResolvedKeybinding = {
  command: CommandId;
  shortcut: KeybindingShortcut;
};

type Keybinding = {
  key: string;
  command: CommandId;
};

export const DEFAULT_KEYBINDINGS: ReadonlyArray<Keybinding> = [
  { key: "mod+t", command: "tab.new" },
  { key: "mod+w", command: "tab.close" },
  { key: "mod+shift+[", command: "tab.activate.previous" },
  { key: "mod+shift+]", command: "tab.activate.next" },
  { key: "mod+1", command: "tab.activate.1" },
  { key: "mod+2", command: "tab.activate.2" },
  { key: "mod+3", command: "tab.activate.3" },
  { key: "mod+4", command: "tab.activate.4" },
  { key: "mod+5", command: "tab.activate.5" },
  { key: "mod+6", command: "tab.activate.6" },
  { key: "mod+7", command: "tab.activate.7" },
  { key: "mod+8", command: "tab.activate.8" },
  { key: "mod+9", command: "tab.activate.9" },
  { key: "mod+o", command: "project.open" },
  { key: "mod+b", command: "sidebar.toggle" },
  { key: "mod+shift+m", command: "model.selector.toggle" },
  { key: "mod+,", command: "view.settings" },
];

export function isMacPlatform(platform = navigator.platform): boolean {
  return /Mac|iPod|iPhone|iPad/.test(platform);
}

function normalizeKeyToken(token: string): string {
  const normalized = token.toLowerCase().trim();
  if (normalized === "esc") return "escape";
  return normalized;
}

export function parseKeybindingShortcut(value: string): KeybindingShortcut | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const rawTokens = trimmed.toLowerCase().split("+");
  const tokens = [...rawTokens];
  let trailingEmptyCount = 0;
  while (tokens[tokens.length - 1] === "") {
    trailingEmptyCount += 1;
    tokens.pop();
  }
  if (trailingEmptyCount > 0) {
    tokens.push("+");
  }
  if (tokens.some((token) => token.length === 0)) return null;
  if (tokens.length === 0) return null;

  let key: string | null = null;
  let metaKey = false;
  let ctrlKey = false;
  let shiftKey = false;
  let altKey = false;
  let modKey = false;

  for (const token of tokens) {
    switch (token) {
      case "cmd":
      case "meta":
        metaKey = true;
        break;
      case "ctrl":
      case "control":
        ctrlKey = true;
        break;
      case "shift":
        shiftKey = true;
        break;
      case "alt":
      case "option":
        altKey = true;
        break;
      case "mod":
        modKey = true;
        break;
      default: {
        if (key !== null) return null;
        key = normalizeKeyToken(token);
      }
    }
  }

  if (key === null) return null;
  return { key, metaKey, ctrlKey, shiftKey, altKey, modKey };
}

export function compileResolvedKeybindings(
  keybindings: ReadonlyArray<Keybinding>,
): ResolvedKeybinding[] {
  const resolved: ResolvedKeybinding[] = [];
  for (const binding of keybindings) {
    const shortcut = parseKeybindingShortcut(binding.key);
    if (shortcut) {
      resolved.push({ command: binding.command, shortcut });
    }
  }
  return resolved;
}

export const DEFAULT_RESOLVED_KEYBINDINGS = compileResolvedKeybindings(DEFAULT_KEYBINDINGS);

function resolveEventKeys(event: { key: string; code?: string }): Set<string> {
  const keys = new Set([normalizeKeyToken(event.key)]);

  if (event.key === "{") keys.add("[");
  if (event.key === "}") keys.add("]");

  const code = event.code;
  if (code?.startsWith("Digit")) {
    keys.add(code.slice(5));
  }
  if (code === "BracketLeft") keys.add("[");
  if (code === "BracketRight") keys.add("]");

  return keys;
}

function matchesShortcutModifiers(
  event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): boolean {
  const useMetaForMod = isMacPlatform(platform);
  const expectedMeta = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const expectedCtrl = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);

  return (
    event.metaKey === expectedMeta &&
    event.ctrlKey === expectedCtrl &&
    event.shiftKey === shortcut.shiftKey &&
    event.altKey === shortcut.altKey
  );
}

function matchesShortcut(
  event: {
    key: string;
    code?: string;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  },
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): boolean {
  if (!matchesShortcutModifiers(event, shortcut, platform)) return false;
  return resolveEventKeys(event).has(shortcut.key);
}

export function resolveShortcutCommand(
  event: {
    key: string;
    code?: string;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  },
  keybindings: ReadonlyArray<ResolvedKeybinding> = DEFAULT_RESOLVED_KEYBINDINGS,
  platform = navigator.platform,
): CommandId | null {
  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (!binding) continue;
    if (matchesShortcut(event, binding.shortcut, platform)) {
      return binding.command;
    }
  }
  return null;
}

function formatKeyLabel(key: string): string {
  if (key.length === 1) return key.toUpperCase();
  if (key === "escape") return "Esc";
  if (key === "arrowup") return "↑";
  if (key === "arrowdown") return "↓";
  if (key === "arrowleft") return "←";
  if (key === "arrowright") return "→";
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export function formatShortcutLabel(
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): string {
  const useMetaForMod = isMacPlatform(platform);
  const showMeta = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const showCtrl = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);
  const showAlt = shortcut.altKey;
  const showShift = shortcut.shiftKey;
  const keyLabel = formatKeyLabel(shortcut.key);

  if (useMetaForMod) {
    return `${showCtrl ? "⌃" : ""}${showAlt ? "⌥" : ""}${showShift ? "⇧" : ""}${showMeta ? "⌘" : ""}${keyLabel}`;
  }

  const parts: string[] = [];
  if (showCtrl) parts.push("Ctrl");
  if (showAlt) parts.push("Alt");
  if (showShift) parts.push("Shift");
  if (showMeta) parts.push("Meta");
  parts.push(keyLabel);
  return parts.join("+");
}

export function getShortcutLabelForCommand(
  command: CommandId,
  keybindings: ReadonlyArray<ResolvedKeybinding> = DEFAULT_RESOLVED_KEYBINDINGS,
  platform = navigator.platform,
): string | null {
  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (binding?.command === command) {
      return formatShortcutLabel(binding.shortcut, platform);
    }
  }
  return null;
}
