import { Kbd } from "@herman/ui/components/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@herman/ui/components/tooltip";
import { cn } from "@herman/ui/lib/utils";
import type * as React from "react";

import { dispatchCommand } from "../lib/command-dispatch.js";
import { getShortcutLabelForCommand, type CommandId } from "../lib/commands.js";

interface CommandButtonProps extends React.ComponentProps<"button"> {
  command: CommandId;
  label: string;
  side?: React.ComponentProps<typeof TooltipContent>["side"];
}

export function CommandButton({
  command,
  label,
  side = "top",
  className,
  children,
  onClick,
  ...props
}: CommandButtonProps) {
  const shortcut = getShortcutLabelForCommand(command);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            className={cn(className)}
            onClick={(event) => {
              dispatchCommand(command);
              onClick?.(event);
            }}
            {...props}
          >
            {children}
          </button>
        }
      />
      <TooltipContent side={side} className="flex items-center gap-1.5">
        {label}
        {shortcut ? <Kbd>{shortcut}</Kbd> : null}
      </TooltipContent>
    </Tooltip>
  );
}
