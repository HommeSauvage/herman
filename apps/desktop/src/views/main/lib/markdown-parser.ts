import DOMPurify from "dompurify";
import { Marked, marked } from "marked";
import markedShiki from "marked-shiki";

import { LRUCache } from "./lru-cache.js";
import { getHighlighter } from "./shiki.js";

const ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  sh: "bash",
  zsh: "bash",
  "": "text",
};

const cache = new LRUCache<string, string>(200);

/** Async parser with Shiki syntax highlighting for final renders. */
const asyncParser = marked.use(
  markedShiki({
    async highlight(code, lang) {
      const highlighter = await getHighlighter();
      const normalized = lang ? (ALIASES[lang] ?? lang) : "text";
      const loadedLangs = highlighter.getLoadedLanguages();
      const effectiveLang = loadedLangs.includes(normalized) ? normalized : "text";
      return highlighter.codeToHtml(code.trim(), {
        lang: effectiveLang,
        theme: "github-dark",
      });
    },
  }),
);

/** Sync parser without extensions — fast enough for streaming updates. */
const syncParser = new Marked();

function sanitize(raw: string): string {
  return DOMPurify.sanitize(raw, {
    // Restrict to markdown-rendered + Shiki HTML elements.
    // Default ALLOWED_ATTR already includes style, class, href,
    // tabindex — we don't override it so Shiki's inline styles pass through.
    ALLOWED_TAGS: [
      "pre",
      "code",
      "span",
      "div",
      "p",
      "ul",
      "ol",
      "li",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "a",
      "strong",
      "em",
      "del",
      "blockquote",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "hr",
      "br",
      "img",
    ],
  }) as unknown as string;
}

export async function parseMarkdown(content: string): Promise<string> {
  const cached = cache.get(content);
  if (cached) return cached;

  const raw = (await asyncParser.parse(content)) as string;
  const clean = sanitize(raw);
  cache.set(content, clean);
  return clean;
}

/**
 * Synchronous markdown → HTML for streaming updates.
 * Skips DOMPurify (trusted LLM content) and Shiki highlighting
 * to keep pacing smooth — sanitization runs on the final render.
 */
export function parseMarkdownSync(content: string): string {
  if (!content) return "";
  return syncParser.parse(content) as string;
}
