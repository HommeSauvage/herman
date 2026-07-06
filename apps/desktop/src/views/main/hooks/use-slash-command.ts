import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SkillInfo } from "../../../shared/rpc.js";
import { desktopRpc } from "../lib/desktop-rpc.js";
import { useAgentStore } from "../lib/agent-store.js";

export type SlashCommandItem =
  | { type: "command"; id: string; label: string; description: string; shortcut?: string }
  | { type: "skill"; id: string; label: string; description: string; skillName: string };

const BUILTIN_COMMANDS: SlashCommandItem[] = [
  {
    type: "command",
    id: "new",
    label: "/new",
    description: "Open a new session tab",
    shortcut: "⌘T",
  },
  {
    type: "command",
    id: "model",
    label: "/model",
    description: "Change the response model",
    shortcut: "⌘⇧M",
  },
];

function skillsToItems(skills: SkillInfo[]): SlashCommandItem[] {
  return skills.map((skill) => ({
    type: "skill" as const,
    id: skill.name,
    label: `/${skill.name}`,
    description: skill.description,
    skillName: skill.name,
  }));
}

function filterItems(
  query: string,
  skills: SlashCommandItem[],
): {
  commands: SlashCommandItem[];
  skills: SlashCommandItem[];
} {
  const q = query.toLowerCase().trim();
  if (!q) {
    return { commands: BUILTIN_COMMANDS, skills };
  }

  const matchItem = (item: SlashCommandItem): boolean =>
    item.label.toLowerCase().includes(q) || item.description.toLowerCase().includes(q);

  return {
    commands: BUILTIN_COMMANDS.filter(matchItem),
    skills: skills.filter(matchItem),
  };
}

export type SlashCommandState = {
  open: boolean;
  commands: SlashCommandItem[];
  skills: SlashCommandItem[];
  activeSectionIndex: number; // 0 = commands, 1 = skills
  activeItemIndex: number; // within the active section
  totalItems: number;
};

export function useSlashCommand() {
  const [state, setState] = useState<SlashCommandState>({
    open: false,
    commands: [],
    skills: [],
    activeSectionIndex: 0,
    activeItemIndex: 0,
    totalItems: 0,
  });

  // Dynamic skills loaded from the filesystem / agent
  const [availableSkills, setAvailableSkills] = useState<SlashCommandItem[]>([]);
  const availableSkillsRef = useRef<SlashCommandItem[]>([]);

  const openRef = useRef(false);
  const createTab = useAgentStore((s) => s.createTab);
  const setModelSelectorOpen = useAgentStore((s) => s.setModelSelectorOpen);

  const activeTabFolderPath = useAgentStore((s) => {
    const activeTabId = s.activeTabId;
    return activeTabId ? s.tabs[activeTabId]?.folderPath : undefined;
  });

  // Load skills on mount and when the active project changes
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await desktopRpc.request.getSkills({
          projectDir: activeTabFolderPath,
        });
        if (cancelled) return;
        const items = skillsToItems(result.skills);
        setAvailableSkills(items);
        availableSkillsRef.current = items;
      } catch {
        // Silently keep existing skills on error
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTabFolderPath]);

  const close = useCallback(() => {
    openRef.current = false;
    setState((s) => (s.open ? { ...s, open: false } : s));
  }, []);

  const reset = useCallback(() => {
    openRef.current = false;
    setState({
      open: false,
      commands: [],
      skills: [],
      activeSectionIndex: 0,
      activeItemIndex: 0,
      totalItems: 0,
    });
  }, []);

  const onInputSlice = useCallback((query: string) => {
    const { commands, skills } = filterItems(query, availableSkillsRef.current);
    const totalItems = commands.length + skills.length;

    if (!openRef.current) {
      openRef.current = true;
      setState({
        open: true,
        commands,
        skills,
        activeSectionIndex: 0,
        activeItemIndex: 0,
        totalItems,
      });
    } else {
      setState((s) => ({
        ...s,
        open: true,
        commands,
        skills,
        totalItems,
        activeSectionIndex:
          commands.length > 0
            ? 0
            : skills.length > 0
              ? 1
              : s.activeSectionIndex,
        activeItemIndex: 0,
      }));
    }
  }, []);

  const moveActive = useCallback((delta: number) => {
    setState((s) => {
      if (s.totalItems === 0) return s;

      const commandsLen = s.commands.length;
      const skillsLen = s.skills.length;

      let { activeSectionIndex, activeItemIndex } = s;

      // Move within current section if possible
      const currentSectionLen = activeSectionIndex === 0 ? commandsLen : skillsLen;
      const newIndex = activeItemIndex + delta;

      if (newIndex >= 0 && newIndex < currentSectionLen) {
        return { ...s, activeItemIndex: newIndex };
      }

      // Try to cross to the other section
      if (delta > 0 && activeSectionIndex === 0 && skillsLen > 0) {
        return { ...s, activeSectionIndex: 1, activeItemIndex: 0 };
      }
      if (delta < 0 && activeSectionIndex === 1) {
        // Move to last command if available
        if (commandsLen > 0) {
          return { ...s, activeSectionIndex: 0, activeItemIndex: commandsLen - 1 };
        }
        // Otherwise wrap to last skill
        if (skillsLen > 0) {
          return { ...s, activeSectionIndex: 1, activeItemIndex: skillsLen - 1 };
        }
      }

      return s;
    });
  }, []);

  const activeItem = useMemo((): SlashCommandItem | null => {
    const section = state.activeSectionIndex === 0 ? state.commands : state.skills;
    return section[state.activeItemIndex] ?? null;
  }, [state.activeSectionIndex, state.activeItemIndex, state.commands, state.skills]);

  const setActiveHover = useCallback((sectionIndex: number, itemIndex: number) => {
    setState((s) => {
      const nextLen = sectionIndex === 0 ? s.commands.length : s.skills.length;
      if (nextLen === 0) return s;
      const clampedIndex = Math.min(itemIndex, nextLen - 1);
      if (s.activeSectionIndex === sectionIndex && s.activeItemIndex === clampedIndex) return s;
      return { ...s, activeSectionIndex: sectionIndex, activeItemIndex: clampedIndex };
    });
  }, []);

  const handleSelect = useCallback(
    (item: SlashCommandItem | null): string | null => {
      if (!item) return null;

      if (item.type === "command") {
        // Action commands don't insert text, they perform actions.
        // Return empty string to clear the composer input.
        if (item.id === "new") {
          createTab();
        } else if (item.id === "model") {
          setModelSelectorOpen(true);
        }
        reset();
        return "";
      }

      // Skills: use /skill:name format which pi-agent expands to the full SKILL.md content
      const skillText = `/skill:${item.skillName} `;
      reset();
      return skillText;
    },
    [createTab, setModelSelectorOpen, reset],
  );

  return {
    ...state,
    activeItem,
    onInputSlice,
    close,
    reset,
    moveActive,
    setActiveHover,
    handleSelect,
  };
}
