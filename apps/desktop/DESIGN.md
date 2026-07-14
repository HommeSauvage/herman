# Herman Desktop Design

Visual language and layout standards for the desktop renderer (`src/views/main/`). Mode choice still follows [MODES.md](../../MODES.md) — this file is about *how* surfaces look once you know which mode owns them.

## Modes and density

| | Rookie | Normal |
|---|---|---|
| Navigation | Thin `w-14` icon rail + centered pages | `w-56` project sidebar + full-bleed lists |
| Home | Card grid (`max-w-5xl`) | Session list (no content max-width) |
| Density | Comfortable: `rounded-xl` / `2xl`, signal CTAs, light motion | Compact: `rounded-lg`, quieter `bg-peak` CTAs |
| Shared chrome | Tab bar, status bar, chat, settings, model selector | Same |

**Do not** collapse these into one layout. Standardize tokens and primitives so both modes speak the same language at different densities.

## Content width scale

Use [`ContentWidth`](src/views/main/components/ui/content-width.tsx). Do not invent a new `max-w-*` for page chrome.

| Size | Class | Use |
|---|---|---|
| `page` | `max-w-5xl` | Rookie home (projects + sessions) |
| `chat` | `max-w-3xl` | Chat message column |
| `settings` | `max-w-2xl` | Settings tab bodies |
| `form` | `max-w-md` | Wizard steps, login-style forms |
| `formWide` | `max-w-lg` | Wizard template picker, mode-choice card |

Pattern: full-bleed chrome (`border-b`, padding) → inner `ContentWidth` for the constrained column.

## Tokens

Defined in [`index.css`](src/views/main/index.css). Prefer tokens over raw opacities in new or touched code:

| Token | Role |
|---|---|
| `void` / `surface` / `ridge` / `peak` | App / panel backgrounds |
| `mist` | Default border (`border-mist`) |
| `mist-strong` | Stronger interactive border when intentional |
| `fog` | Hover / soft fills (`bg-fog`, `hover:bg-fog`) |
| `signal` / `signal-dim` | Primary accent |
| `signal-glow` / `signal-glow-soft` | Glow shadows (use CSS vars, not hand-rolled rgba) |
| `text` / `dim` / `ghost` | Title / body / meta |

Avoid copy-pasting `border-white/[0.06]` or `rgba(34,197,94,…)` in new code.

## Radius ladder

- `rounded-lg` — chips, search fields, compact controls
- `rounded-xl` — list rows (comfortable), primary CTAs
- `rounded-2xl` — cards, icon wells

## Typography roles

- **Page title** — `text-text text-lg` or `text-2xl font-semibold` (wizard steps may use `tracking-tight`)
- **Section label** — use [`SectionLabel`](src/views/main/components/ui/section-label.tsx): `text-ghost text-[10px] font-bold tracking-[0.12em] uppercase`
- **Body** — readable copy (descriptions, help, expanded accordion content): minimum `text-sm` + `text-dim` or `text-body`
- **Meta** — `text-ghost text-[11px]` (labels, timestamps, footnotes only)

Never use `text-ghost` for multi-line primary copy — ghost is meta-only (`#525252` fails contrast as body text).

## Shared primitives

Herman-specific helpers live in [`src/views/main/components/ui/`](src/views/main/components/ui/):

| Primitive | When to use |
|---|---|
| `ContentWidth` | Named content max-widths (see scale above) |
| `SectionLabel` | Date groups, sidebar/settings eyebrows |
| `SearchField` | Session / list search strips |
| `SessionRow` / `SessionDateGroups` | Session lists (pass `density`) |
| `SignalButton` | Primary green CTAs (Rookie home, wizard) |

Use [`@herman/ui`](../../packages/ui) for generic primitives (Dialog, Tooltip, Switch, Accordion, `cn`). Do not put Herman palette composition into `packages/ui`.

## Checklist for new UI

1. Mode scoped? ([MODES.md](../../MODES.md))
2. Width from the scale — not a one-off `max-w-*`
3. Prefer `components/ui` helpers over duplicating class strings
4. Prefer `mist` / `fog` / `signal-*` tokens on touched surfaces
5. Match mode density (compact vs comfortable)
