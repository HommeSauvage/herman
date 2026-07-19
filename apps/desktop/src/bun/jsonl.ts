/**
 * Strip ANSI escape codes so terminal color sequences don't leak into JSON.
 */
function stripAnsi(str: string): string {
  const ESC = String.fromCharCode(27);
  return str.replace(new RegExp(`${ESC}(?:[@-Z\\-_]|\\[[0-?]*[ -/]*[@-~])`, "g"), "");
}

/**
 * Strict LF-delimited JSONL parser.
 *
 * MUST split on \n (U+000A) only — NEVER use readline.
 * readline splits on U+2028 and U+2029 which are valid inside JSON string payloads.
 */
export class JsonlParser {
  private buffer = "";

  constructor(private readonly onLine: (line: string) => void) {}

  feed(chunk: string): void {
    this.buffer += stripAnsi(chunk);

    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const rawLine = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.length > 0) {
        this.onLine(line);
      }

      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const line = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
    if (line.length > 0) {
      this.onLine(line);
    }
    this.buffer = "";
  }

  reset(): void {
    this.buffer = "";
  }
}

export function serializeJsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
