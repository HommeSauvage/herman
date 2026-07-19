import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PromptTemplateInfo, SkillInfo } from "../../../shared/rpc.js";
import { useAgentStore } from "../lib/agent-store.js";
import { desktopRpc } from "../lib/desktop-rpc.js";

export type SlashCommandItem =
  | { type: "command"; id: string; label: string; description: string; shortcut?: string }
  | { type: "skill"; id: string; label: string; description: string; skillName: string }
  | {
      type: "prompt-template";
      id: string;
      label: string;
      description: string;
      argumentHint?: string;
      templateName: string;
    };

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

function templatesToItems(templates: PromptTemplateInfo[]): SlashCommandItem[] {
  return templates.map((tpl) => ({
    type: "prompt-template" as const,
    id: tpl.name,
    label: `/${tpl.name}`,
    description: tpl.argumentHint ? `${tpl.argumentHint}  — ${tpl.description}` : tpl.description,
    argumentHint: tpl.argumentHint,
    templateName: tpl.name,
  }));
}

function filterItems(
  query: string,
  skills: SlashCommandItem[],
  templates: SlashCommandItem[],
): {
  commands: SlashCommandItem[];
  skills: SlashCommandItem[];
  templates: SlashCommandItem[];
} {
  const q = query.toLowerCase().trim();
  if (!q) {
    return { commands: BUILTIN_COMMANDS, skills, templates };
  }

  const matchItem = (item: SlashCommandItem): boolean =>
    item.label.toLowerCase().includes(q) || item.description.toLowerCase().includes(q);

  return {
    commands: BUILTIN_COMMANDS.filter(matchItem),
    skills: skills.filter(matchItem),
    templates: templates.filter(matchItem),
  };
}

export type SlashCommandState = {
  open: boolean;
  commands: SlashCommandItem[];
  skills: SlashCommandItem[];
  templates: SlashCommandItem[];
  activeSectionIndex: number; // 0 = commands, 1 = skills, 2 = templates
  activeItemIndex: number; // within the active section
  totalItems: number;
};

export function useSlashCommand() {
  const [state, setState] = useState<SlashCommandState>({
    open: false,
    commands: [],
    skills: [],
    templates: [],
    activeSectionIndex: 0,
    activeItemIndex: 0,
    totalItems: 0,
  });

  // Dynamic skills loaded from the filesystem / agent
  const [_availableSkills, setAvailableSkills] = useState<SlashCommandItem[]>([]);
  const availableSkillsRef = useRef<SlashCommandItem[]>([]);

  // Dynamic prompt templates loaded from pi's prompt directories
  const [_availableTemplates, setAvailableTemplates] = useState<SlashCommandItem[]>([]);
  const availableTemplatesRef = useRef<SlashCommandItem[]>([]);

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

  // Load prompt templates on mount and when the active project changes
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await desktopRpc.request.getPromptTemplates({
          projectDir: activeTabFolderPath,
        });
        if (cancelled) return;
        const items = templatesToItems(result.templates);
        setAvailableTemplates(items);
        availableTemplatesRef.current = items;
      } catch {
        // Silently keep existing templates on error
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
      templates: [],
      activeSectionIndex: 0,
      activeItemIndex: 0,
      totalItems: 0,
    });
  }, []);

  const onInputSlice = useCallback((query: string) => {
    const { commands, skills, templates } = filterItems(
      query,
      availableSkillsRef.current,
      availableTemplatesRef.current,
    );
    const totalItems = commands.length + skills.length + templates.length;

    const initialSectionIndex =
      commands.length > 0 ? 0 : skills.length > 0 ? 1 : templates.length > 0 ? 2 : 0;

    if (!openRef.current) {
      openRef.current = true;
      setState({
        open: true,
        commands,
        skills,
        templates,
        activeSectionIndex: initialSectionIndex,
        activeItemIndex: 0,
        totalItems,
      });
    } else {
      setState((s) => ({
        ...s,
        open: true,
        commands,
        skills,
        templates,
        totalItems,
        activeSectionIndex: initialSectionIndex,
        activeItemIndex: 0,
      }));
    }
  }, []);

  const moveActive = useCallback((delta: number) => {
    setState((s) => {
      if (s.totalItems === 0) return s;

      const commandsLen = s.commands.length;
      const skillsLen = s.skills.length;
      const templatesLen = s.templates.length;

      // Helper to get section length
      const sectionLen = (sectionIndex: number): number =>
        sectionIndex === 0 ? commandsLen : sectionIndex === 1 ? skillsLen : templatesLen;

      const { activeSectionIndex, activeItemIndex } = s;

      // Move within current section if possible
      const currentSectionLen = sectionLen(activeSectionIndex);
      const newIndex = activeItemIndex + delta;

      if (newIndex >= 0 && newIndex < currentSectionLen) {
        return { ...s, activeItemIndex: newIndex };
      }

      // Try to cross to the next/prev section
      if (delta > 0) {
        // Forward: 0->1, 1->2, 2 wraps or stays
        if (activeSectionIndex === 0 && skillsLen > 0) {
          return { ...s, activeSectionIndex: 1, activeItemIndex: 0 };
        }
        if (activeSectionIndex <= 1 && templatesLen > 0) {
          return { ...s, activeSectionIndex: 2, activeItemIndex: 0 };
        }
      } else {
        // Backward: 2->1, 1->0, 0 wraps or stays
        if (activeSectionIndex === 2) {
          if (skillsLen > 0) {
            return { ...s, activeSectionIndex: 1, activeItemIndex: skillsLen - 1 };
          }
          if (commandsLen > 0) {
            return { ...s, activeSectionIndex: 0, activeItemIndex: commandsLen - 1 };
          }
        }
        if (activeSectionIndex === 1 && commandsLen > 0) {
          return { ...s, activeSectionIndex: 0, activeItemIndex: commandsLen - 1 };
        }
        // Wrap from section 0 to last non-empty section
        if (activeSectionIndex === 0) {
          if (templatesLen > 0) {
            return { ...s, activeSectionIndex: 2, activeItemIndex: templatesLen - 1 };
          }
          if (skillsLen > 0) {
            return { ...s, activeSectionIndex: 1, activeItemIndex: skillsLen - 1 };
          }
        }
      }

      return s;
    });
  }, []);

  const activeItem = useMemo((): SlashCommandItem | null => {
    const section =
      state.activeSectionIndex === 0
        ? state.commands
        : state.activeSectionIndex === 1
          ? state.skills
          : state.templates;
    return section[state.activeItemIndex] ?? null;
  }, [
    state.activeSectionIndex,
    state.activeItemIndex,
    state.commands,
    state.skills,
    state.templates,
  ]);

  const setActiveHover = useCallback((sectionIndex: number, itemIndex: number) => {
    setState((s) => {
      const nextLen =
        sectionIndex === 0
          ? s.commands.length
          : sectionIndex === 1
            ? s.skills.length
            : s.templates.length;
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

      if (item.type === "skill") {
        // Skills: use /skill:name format which pi-agent expands to the full SKILL.md content
        const skillText = `/skill:${item.skillName} `;
        reset();
        return skillText;
      }

      if (item.type === "prompt-template") {
        // Prompt templates: insert /name which pi expands to the template content
        const templateText = `/${item.templateName} `;
        reset();
        return templateText;
      }

      reset();
      return null;
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
