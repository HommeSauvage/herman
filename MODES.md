# Herman UI Modes

Herman ships with two distinct UI modes. **Every UI feature must be scoped to one of them.**

## Rookie Mode

- **Audience**: First-time or non-technical users
- **Experience**: Guided, opinionated, preview-first
- **Surface area**: Reduced
- **Key components**:
  - Wizard-driven onboarding: `apps/desktop/src/views/main/components/onboarding-wizard.tsx`
  - Rookie shell: `apps/desktop/src/views/main/components/rookie-shell.tsx`
  - Rookie home: `apps/desktop/src/views/main/components/rookie-home-view.tsx`
- **Use for**: onboarding, templates, guided questions, simplified workflows

## Normal Mode

- **Audience**: Experienced developers
- **Experience**: Full control over projects, models, and tools
- **Surface area**: Full
- **Key components**:
  - Normal shell: `apps/desktop/src/views/main/components/shell.tsx`
  - Normal home: `apps/desktop/src/views/main/components/home-view.tsx`
- **Use for**: advanced project management, power tools, full configuration

## Decision checklist

When adding or changing UI, decide where it belongs before implementing:

1. Does it help a first-time user get started or guide them through a task?  
   → **Rookie Mode**
2. Is it a power-user, advanced, or full-control feature?  
   → **Normal Mode**
3. Is it shared chrome (tab bar, status bar, model selector, settings, etc.)?  
   → **Both modes**
4. Does it already exist in `rookie-shell.tsx` or `shell.tsx`?  
   Scope it to the shell where it lives; if it lives in both, keep it shared.

## Unsure?

**If you are unsure whether a UI feature belongs in Rookie Mode, Normal Mode, or both, do not guess. Ask the user before implementing.**
