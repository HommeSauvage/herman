// Environment variable keys that contain provider API credentials.
// These must not leak from the desktop process into agent subprocesses
// (which have their own per-tab credential store) or into the Herman
// server extension (which validates no local keys are present).
//
// Keep this list alphabetically sorted and update both consumers when adding
// a new provider.
export const PROTECTED_PROVIDER_KEY_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AZURE_OPENAI_API_KEY",
  "CEREBRAS_API_KEY",
  "CLOUDFLARE_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "GEMINI_API_KEY",
  "GLM_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "HERMAN_GLM_KEYS",
  "HERMAN_KIMI_KEYS",
  "HERMAN_MINIMAX_KEYS",
  "HF_TOKEN",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  "MISTRAL_API_KEY",
  "MOONSHOT_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENCODE_API_KEY",
  "TOGETHER_API_KEY",
  "XAI_API_KEY",
  "XIAOMI_API_KEY",
] as const;

export const PROTECTED_PROVIDER_KEY_SET = new Set<string>(PROTECTED_PROVIDER_KEY_VARS);
