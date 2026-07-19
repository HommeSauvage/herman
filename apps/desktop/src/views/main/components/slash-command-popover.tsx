import { cn } from "@herman/ui/lib/utils";
import { ArrowRight, FileText, Wand2, Zap } from "lucide-react";

import type { SlashCommandItem } from "../hooks/use-slash-command.js";

export type SlashCommandPopoverProps = {
  open: boolean;
  commands: SlashCommandItem[];
  skills: SlashCommandItem[];
  templates: SlashCommandItem[];
  activeSectionIndex: number;
  activeItemIndex: number;
  onSelect: (item: SlashCommandItem) => void;
  onHover: (sectionIndex: number, itemIndex: number) => void;
};

function SlashCommandRow({
  item,
  isActive,
  onSelect,
  onHover,
}: {
  item: SlashCommandItem;
  isActive: boolean;
  onSelect: () => void;
  onHover: () => void;
}) {
  const isCommand = item.type === "command";
  const isTemplate = item.type === "prompt-template";

  return (
    <button
      type="button"
      data-active={isActive ? "" : undefined}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition",
        isActive
          ? "text-text bg-white/[0.06]"
          : "text-dim hover:text-text hover:bg-white/[0.04]",
      )}
      onClick={onSelect}
      onMouseMove={onHover}
    >
      {isCommand ? (
        <Zap size={14} className="text-signal shrink-0" />
      ) : isTemplate ? (
        <FileText size={14} className="text-faint shrink-0" />
      ) : (
        <Wand2 size={14} className="text-faint shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <span className="text-text font-medium">{item.label}</span>
        <span className="text-dim ml-1.5 text-xs">{item.description}</span>
      </div>
      {isCommand && item.shortcut ? (
        <span className="text-ghost shrink-0 text-[10px] tracking-wider">{item.shortcut}</span>
      ) : (
        <span className="text-ghost shrink-0 text-[10px]">
          <ArrowRight size={12} />
        </span>
      )}
    </button>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="text-ghost px-2 pt-2 pb-1 text-[10px] font-bold tracking-[0.08em] uppercase">
      {label}
    </div>
  );
}

export function SlashCommandPopover({
  open,
  commands,
  skills,
  templates,
  activeSectionIndex,
  activeItemIndex,
  onSelect,
  onHover,
}: SlashCommandPopoverProps) {
  if (!open) return null;

  const hasCommands = commands.length > 0;
  const hasSkills = skills.length > 0;
  const hasTemplates = templates.length > 0;
  const isEmpty = !hasCommands && !hasSkills && !hasTemplates;

  return (
    <div
      className="bg-surface absolute inset-x-0 bottom-full z-20 mb-2 max-h-80 overflow-y-auto rounded-xl border border-white/[0.06] p-1.5 shadow-2xl"
      onMouseDown={(event) => event.preventDefault()}
    >
      {isEmpty && (
        <div className="text-dim px-3 py-4 text-center text-xs">
          No matching commands, skills, or templates.
        </div>
      )}

      {hasCommands && (
        <>
          <SectionHeader label="Commands" />
          {commands.map((item, index) => (
            <SlashCommandRow
              key={item.id}
              item={item}
              isActive={activeSectionIndex === 0 && activeItemIndex === index}
              onSelect={() => onSelect(item)}
              onHover={() => onHover(0, index)}
            />
          ))}
        </>
      )}

      {hasCommands && (hasSkills || hasTemplates) && (
        <div className="border-t border-white/[0.06] mx-1 my-1" />
      )}

      {hasSkills && (
        <>
          <SectionHeader label="Skills" />
          {skills.map((item, index) => (
            <SlashCommandRow
              key={item.id}
              item={item}
              isActive={activeSectionIndex === 1 && activeItemIndex === index}
              onSelect={() => onSelect(item)}
              onHover={() => onHover(1, index)}
            />
          ))}
        </>
      )}

      {hasSkills && hasTemplates && (
        <div className="border-t border-white/[0.06] mx-1 my-1" />
      )}

      {hasTemplates && (
        <>
          <SectionHeader label="Prompt Templates" />
          {templates.map((item, index) => (
            <SlashCommandRow
              key={item.id}
              item={item}
              isActive={activeSectionIndex === 2 && activeItemIndex === index}
              onSelect={() => onSelect(item)}
              onHover={() => onHover(2, index)}
            />
          ))}
        </>
      )}
    </div>
  );
}
