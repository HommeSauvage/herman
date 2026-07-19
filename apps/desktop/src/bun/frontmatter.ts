/**
 * Shared frontmatter parsing for .md files (skills, prompt templates, etc.).
 *
 * Parses YAML-style frontmatter delimited by --- lines. Only handles simple
 * top-level key: value pairs — nested YAML and complex values are left as-is.
 */

export type Frontmatter = {
  description?: string;
  "argument-hint"?: string;
  [key: string]: unknown;
};

/**
 * Parse YAML frontmatter from markdown content.
 * Returns the parsed frontmatter and the body (content after the closing ---).
 */
export function parseFrontmatter(rawContent: string): {
  frontmatter: Frontmatter;
  body: string;
} {
  const normalized = rawContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) {
    return { frontmatter: {}, body: normalized };
  }
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { frontmatter: {}, body: normalized };
  }
  const yamlString = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 4).trim();
  const frontmatter: Frontmatter = {};
  for (const line of yamlString.split("\n")) {
    const match = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (match) {
      const key = match[1];
      const value = match[2].trim();
      // Remove surrounding quotes
      const cleanValue = value.replace(/^['"](.*)['"]$/, "$1");
      frontmatter[key] = cleanValue;
    }
  }
  return { frontmatter, body };
}
