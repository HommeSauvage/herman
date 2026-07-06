export type Question = {
  id: string;
  question: string;
  placeholder: string;
  /** Optional hint text shown below the input */
  hint?: string;
};

export type StyleOption = {
  id: string;
  title: string;
  icon: string;
  /** CSS/Tailwind-oriented description the AI can use */
  description: string;
};

export type DeploymentConfig = {
  /** Deployment target identifier */
  target: "cloudflare-pages" | "cloudflare-workers" | "hetzner-vps" | "vercel" | "netlify";
  /** Command to start the dev server */
  devCommand: string;
  /** Command to build for production */
  buildCommand: string;
  /** Directory containing the built output */
  outputDir: string;
  /** Port the dev server runs on */
  devPort: number;
  /** Extra env vars or config needed */
  env?: Record<string, string>;
};

export type TemplateManifest = {
  id: string;
  title: string;
  icon: string;
  description: string;
  /** Long description shown in the plan step */
  longDescription?: string;
  /** Questions to ask during onboarding */
  questions: Question[];
  /** Visual style options */
  styleOptions: StyleOption[];
  /** Deployment instructions */
  deployment: DeploymentConfig;
  /** Key features the template provides (shown in the plan step) */
  features: string[];
  /** Brief system prompt addendum for the AI */
  systemPromptHint: string;
};
