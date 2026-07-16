import { Loader2 } from "lucide-react";
import { useEffect, useState, useRef } from "react";

import { ProgressLog } from "./progress-log.js";

// ── Action detection from progress lines ────────────────────────────────────

type LoadingAction = "reading" | "writing" | "editing" | "running" | "general";

function detectAction(line: string): LoadingAction {
  if (/^Reading/i.test(line)) return "reading";
  if (/^Writing/i.test(line)) return "writing";
  if (/^Editing/i.test(line)) return "editing";
  if (/^Running/i.test(line)) return "running";
  return "general";
}

// ── Fun loading messages per action ──────────────────────────────────────────

// Voice: talk to the user, react to the tool stream below, make the wait lively.
// Fake-outs, stage fright, and "go do something else" land better than slogans.
const LOADING_TEXTS: Record<LoadingAction, string[]> = {
  reading: [
    "Shhh… I'm reading...",
    "Quiet in the library, please. I'm concentrating.",
    "Reading every line. Yes, every single one.",
    "You can leave. I'll still be here, reading...",
    "So. Much. Code. To. Read. So little coffee in your cup.",
    "Reading… and comprehending. Mostly reading.",
    "I'll read this in a sec — oh wait, I already finished. Onto the next.",
    "These files aren't going to read themselves. I checked.",
    "Found something interesting. Don't ask yet. Still reading.",
    "I'm learning so much right now. So, so much.",
  ],
  writing: [
    "I feel some kind of pressure, you looking at me write code, go get some coffee…",
    "Done writing, your code is ready! …Nah, still have much to do. But I got you.",
    "Stop hovering. Seriously. Go stretch. I've got this.",
    "Performance anxiety is real. Even for me. Especially for me.",
    "You're staring. I'm typing. This is a weird relationship.",
    "I write better when nobody's looking. Hint.",
    "If I mess this up, just pretend you weren't watching…",
    "My fingers are a blur (wait, I don't have fingers). Carry on.",
    "I'm writing a bit of code I stole, don't tell anyone.",
    ".><#290#$@!$>!@# ← yeah, that's coding. You're welcome.",
  ],
  editing: [
    "Caught me mid-edit. Look away for a second so I can fix my mistake.",
    "I'm not rewriting it, I'm *improving* it. Totally different.",
    "Fixing things I definitely didn't break. Definitely.",
    "Surgical edit in progress — precise, delicate, slightly nervy.",
    "One line out, one line in. Perfectly balanced. Trust me.",
    "This isn't the final version. Wait — now it might be. Still look elsewhere.",
    "Snipping here, tweaking there… like digital bonsai.",
    "Almost done editing… oh wait, one more tweak. Classic.",
    "Ninja edit underway. When you look back, something will have changed.",
  ],
  running: [
    "The terminal and I need a moment alone. It's personal.",
    "Pressing enter and hoping for the best. You hoping too would help.",
    "If this works on the first try I'll be genuinely surprised.",
    "Running commands… hope they work. Said every developer ever.",
    "Compiling… and praying. Quietly. You can pray louder if you want.",
    "Making the computer do things it may or may not want to do.",
    "Command finished successfully! …Checking if that was a lie.",
    "The shell is thinking. I'm also thinking. Mostly about you watching.",
    "Executing important things. Very important. Still waiting with you.",
  ],
  general: [
    "This is the boring part for you. For me it's the whole movie. Go make tea.",
    "I'll ping you when it's interesting. Until then: bathroom, snack, whatever.",
    "Standing here watching progress scroll by is a hobby I don't recommend.",
    "Hang on — this takes a couple of minutes. Tool calls below; freedom for you.",
    "Thinking really hard right now — you can almost hear the gears.",
    "Doing computer things. Very technical computer things. You're allowed to blink.",
    "Almost done! …Okay that was optimistic. Still on it though.",
    "Hold my virtual beer, I got this.",
    "The bits are aligning… almost there. Or somewhere near almost.",
    "Good things come to those who wait. Or leave and come back. Same outcome.",
  ],
};

const ROTATION_INTERVAL_MS = 9_000;

// ── Hook: cycle through messages, resetting when the action changes ──────────

function useCyclingMessages(
  action: LoadingAction,
  messages: Record<LoadingAction, string[]>,
): string {
  const pool = messages[action];
  const [index, setIndex] = useState(0);
  const prevActionRef = useRef<LoadingAction>(action);

  // Reset index when the action changes.
  useEffect(() => {
    if (prevActionRef.current !== action) {
      prevActionRef.current = action;
      setIndex(0);
    }
  }, [action]);

  // Cycle every ROTATION_INTERVAL_MS.
  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((i) => (i + 1) % pool.length);
    }, ROTATION_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pool.length]);

  return pool[index];
}

// ── Component ────────────────────────────────────────────────────────────────

interface WizardLoadingProps {
  /** Accumulated progress lines from the wizard session. */
  progressLines: string[];
  /** Longer hint shown once above the rotating text. */
  headerText?: string;
  /** Spinner / accent color variant. */
  variant?: "working" | "retrying";
}

/** Full-screen wizard loading state with a spinning icon, a header line,
 *  and a rotating fun message that reacts to the agent's current tool activity. */
export function WizardLoading({
  progressLines,
  headerText = "Hang on there, I'm working, this will take some time...",
  variant = "working",
}: WizardLoadingProps) {
  // Detect the latest action from the most recent progress line.
  const latestLine = progressLines.length > 0 ? progressLines[progressLines.length - 1] : "";
  const action = detectAction(latestLine);
  const cyclingText = useCyclingMessages(action, LOADING_TEXTS);

  const isRetrying = variant === "retrying";

  return (
    <div className="w-full">
      {/* Spinner + header + cycling text — left-aligned */}
      <div className="flex items-start gap-3">
        {/* Spinner icon */}
        <div
          className={
            isRetrying
              ? "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-400"
              : "bg-signal/10 text-signal flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
          }
        >
          <Loader2 size={20} className="animate-spin" />
        </div>

        {/* Text column */}
        <div className="min-w-0 flex-1 pt-0.5">
          <p className={isRetrying ? "text-sm font-medium text-amber-300" : "text-text text-sm font-medium"}>
            {headerText}
          </p>
          <p className="text-dim mt-1 text-sm leading-relaxed">{cyclingText}</p>
        </div>
      </div>

      <ProgressLog lines={progressLines} className="mt-5" />
    </div>
  );
}
