const pendingHeightFrames = new WeakMap<HTMLTextAreaElement, number>();

export function adjustTextareaHeight(target: HTMLTextAreaElement) {
  target.style.height = "auto";
  target.style.height = `${Math.min(target.scrollHeight, 160)}px`;
}

export function scheduleTextareaHeightAdjust(target: HTMLTextAreaElement) {
  const pending = pendingHeightFrames.get(target);
  if (pending !== undefined) cancelAnimationFrame(pending);
  pendingHeightFrames.set(
    target,
    requestAnimationFrame(() => {
      pendingHeightFrames.delete(target);
      adjustTextareaHeight(target);
    }),
  );
}
