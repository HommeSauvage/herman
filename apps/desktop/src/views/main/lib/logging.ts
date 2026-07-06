import { configureSync, getConsoleSink, type LogRecord } from "@logtape/logtape";
import { getPrettyFormatter } from "@logtape/pretty";

function isSafariInspector(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent.toLowerCase();
  return ua.includes("safari") && !ua.includes("chrome") && !ua.includes("chromium");
}

function plainFormatter(record: LogRecord): string {
  const category = record.category.join("·");
  const props = record.properties
    ? Object.entries(record.properties).length > 0
      ? " " + JSON.stringify(record.properties)
      : ""
    : "";
  return `[${record.level.toUpperCase()}] ${category}: ${String(record.rawMessage)}${props}`;
}

export function configureViewLogging(): void {
  // Safari's Web Inspector does not render ANSI escape sequences, so use a
  // plain text formatter there. Other browsers/consoles get the pretty
  // formatter with colors and styles.
  const isSafari = typeof window !== "undefined" && isSafariInspector();

  configureSync({
    sinks: {
      console: getConsoleSink({
        formatter: isSafari ? plainFormatter : getPrettyFormatter(),
      }),
    },
    loggers: [
      { category: ["herman-desktop"], lowestLevel: "debug", sinks: ["console"] },
      { category: ["logtape", "meta"], lowestLevel: "warning", sinks: ["console"] },
    ],
  });
}
