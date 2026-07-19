import { memo } from "react";

import { scheduleTextareaHeightAdjust } from "../lib/composer-textarea-height.js";

type ComposerInputProps = {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onInput: (textarea: HTMLTextAreaElement) => void;
  onBlur: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste?: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
};

export const ComposerInput = memo(function ComposerInput({
  textareaRef,
  onInput,
  onBlur,
  onKeyDown,
  onPaste,
}: ComposerInputProps) {
  return (
    <textarea
      ref={textareaRef}
      data-composer-input
      onInput={(event) => {
        scheduleTextareaHeightAdjust(event.currentTarget);
        onInput(event.currentTarget);
      }}
      onPaste={onPaste}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      placeholder="Ask Herman anything… (@ for files)"
      rows={1}
      className="text-text placeholder:text-ghost max-h-40 min-h-[44px] flex-1 resize-none bg-transparent px-3 py-2.5 text-sm focus:outline-none"
    />
  );
});
