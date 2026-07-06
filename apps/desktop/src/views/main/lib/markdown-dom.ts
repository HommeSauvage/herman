import { Check, Copy } from "lucide-react";

/**
 * After dangerouslySetInnerHTML, inject copy buttons into code blocks.
 * Uses event delegation on the container to avoid per-button listeners.
 * Returns a cleanup function.
 */
export function setupCodeBlockButtons(container: HTMLElement): () => void {
  for (const pre of container.querySelectorAll("pre")) {
    if (pre.querySelector(".md-copy-btn")) continue;
    injectCopyButton(pre);
  }

  function onClick(e: MouseEvent) {
    const btn = (e.target as HTMLElement).closest(".md-copy-btn");
    if (!btn) return;
    const pre = btn.closest("pre");
    if (!pre) return;
    const code = pre.querySelector("code")?.textContent ?? "";
    navigator.clipboard.writeText(code);

    btn.classList.add("md-copy-btn--copied");
    const icon = btn.querySelector(".md-copy-icon");
    if (icon) icon.classList.add("hidden");
    const check = btn.querySelector(".md-check-icon");
    if (check) check.classList.remove("hidden");

    setTimeout(() => {
      btn.classList.remove("md-copy-btn--copied");
      if (icon) icon.classList.remove("hidden");
      if (check) check.classList.add("hidden");
    }, 2000);
  }

  container.addEventListener("click", onClick);
  return () => container.removeEventListener("click", onClick);
}

function injectCopyButton(pre: HTMLPreElement) {
  const btn = document.createElement("button");
  btn.className =
    "md-copy-btn absolute right-2 top-2 rounded-md p-1.5 text-faint hover:text-text transition-colors hover:bg-white/[0.08] active:scale-[0.96]";
  btn.setAttribute("aria-label", "Copy code");
  btn.innerHTML = `<svg class="md-copy-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg><svg class="md-check-icon hidden" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  pre.appendChild(btn);
}
