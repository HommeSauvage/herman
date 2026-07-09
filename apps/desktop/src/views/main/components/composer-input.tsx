import { memo } from "react";

type ComposerInputProps = {
  defaultValue: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onInput: (textarea: HTMLTextAreaElement) => void;
  onBlur: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste?: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
};

function adjustHeight(target: HTMLTextAreaElement) {
  target.style.height = "auto";
  target.style.height = `${Math.min(target.scrollHeight, 160)}px`;
}

export const ComposerInput = memo(function ComposerInput({
  defaultValue,
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
      defaultValue={defaultValue}
      onInput={(event) => {
        adjustHeight(event.currentTarget);
        onInput(event.currentTarget);
      }}
      onPaste={onPaste}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      placeholder="Ask Herman anything… (@ for files)"
      rows={1}
      autoFocus
      className="text-text placeholder:text-ghost max-h-40 min-h-[44px] flex-1 resize-none bg-transparent px-3 py-2.5 text-sm focus:outline-none"
    />
  );
});
