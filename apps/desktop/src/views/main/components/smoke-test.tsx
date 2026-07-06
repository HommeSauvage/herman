import { useState } from "react";

import { CodeBlock } from "./code-block.js";

const SAMPLE_CODE = `// Smoke test code block
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

console.log(greet("Herman"));`;

export function SmokeTest() {
  const [count, setCount] = useState(0);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-8 text-sm">
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.04] p-4">
        <h1 className="mb-2 text-lg font-semibold text-[#f2f2f2]">Herman Desktop Smoke Test</h1>
        <p className="text-faint">
          If you can see this text, React is rendering. Try the counter below to verify
          interactivity.
        </p>
      </div>

      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => setCount((c) => c + 1)}
          className="rounded-md bg-white/[0.08] px-4 py-2 text-[#f2f2f2] transition hover:bg-white/[0.12] active:scale-[0.96]"
        >
          Count: {count}
        </button>
        <span className="text-faint">Clicked {count} time(s)</span>
      </div>

      <div>
        <h2 className="mb-2 font-medium text-[#f2f2f2]">Code block</h2>
        <CodeBlock code={SAMPLE_CODE} language="ts" />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-md bg-red-500/20 p-3 text-center text-red-200">Red</div>
        <div className="rounded-md bg-green-500/20 p-3 text-center text-green-200">Green</div>
        <div className="rounded-md bg-blue-500/20 p-3 text-center text-blue-200">Blue</div>
      </div>
    </div>
  );
}
