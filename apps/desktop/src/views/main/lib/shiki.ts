import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import bash from "shiki/langs/bash.mjs";
import css from "shiki/langs/css.mjs";
import go from "shiki/langs/go.mjs";
import html from "shiki/langs/html.mjs";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import jsx from "shiki/langs/jsx.mjs";
import markdown from "shiki/langs/markdown.mjs";
import python from "shiki/langs/python.mjs";
import rust from "shiki/langs/rust.mjs";
import shell from "shiki/langs/shell.mjs";
import sql from "shiki/langs/sql.mjs";
import tsx from "shiki/langs/tsx.mjs";
import typescript from "shiki/langs/typescript.mjs";
import yaml from "shiki/langs/yaml.mjs";
import githubDark from "shiki/themes/github-dark.mjs";
import getWasmInstance from "shiki/wasm";

const LANGUAGES = [
  bash,
  css,
  go,
  html,
  javascript,
  json,
  jsx,
  markdown,
  python,
  rust,
  shell,
  sql,
  tsx,
  typescript,
  yaml,
];

const ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  sh: "bash",
  zsh: "bash",
  "": "text",
};

let highlighterPromise: Promise<HighlighterCore> | undefined;

export function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [githubDark],
      langs: LANGUAGES,
      engine: createOnigurumaEngine(getWasmInstance),
    });
  }
  return highlighterPromise;
}

export async function highlightCode(code: string, lang?: string): Promise<string> {
  const highlighter = await getHighlighter();
  const normalized = lang ? (ALIASES[lang] ?? lang) : "text";
  const loadedLangs = highlighter.getLoadedLanguages();
  const effectiveLang = loadedLangs.includes(normalized) ? normalized : "text";
  return highlighter.codeToHtml(code.trim(), {
    lang: effectiveLang,
    theme: "github-dark",
  });
}
