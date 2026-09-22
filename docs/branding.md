# Branding

The OpenKnowledgebase brand identity, as the frontend implements it. The book
itself is OKB-218, B5 · Slate Indigo & Mint (sections 01 logo system, 02
colour, 03 typography, 05 applications, 06 tokens); this describes where each
part lives in the code.

## Token layers

Everything is in `frontend/app/assets/css/main.css`, in three layers. Read one
layer down, never across: a component reads a role, a role reads a ramp step, a
ramp step is a hex.

| Layer | Where | What it holds |
|---|---|---|
| **Ramps** | `@theme` | The full ladders — slate indigo, the brand neutral, agent mint, the verified mint, amber, red, cyan. Hexes live here and nowhere else. |
| **Roles** | `:root` + `.dark` | The brand's named tokens, each set to a ramp step. One block per scheme. |
| **Bridge** | `:root` + `.dark` | Nuxt UI's `--ui-*` chain, mapped onto the roles. This is what puts the brand on `UButton`, `UCard`, the dashboard chrome and everything else the library draws. |

A contrast problem is fixed by moving a role to a different step of its ramp —
never by writing a colour into a component.

## Roles

| Role | Light | Dark | Used for |
|---|---|---|---|
| `--okb-primary` | primary-800 `#4c5a9e` | primary-300 `#a6b3d9` | Links, primary buttons, the focus ring, the mark's circle |
| `--okb-primary-hover` / `--okb-primary-pressed` | primary-900 / primary-950 | primary-200 / primary-100 | Hover and pressed steps of the same ramp |
| `--okb-agent` | agent-500 `#10b981` | agent-400 `#34d399` | The mark's block, and agent presence |
| `--okb-agent-text` | agent-700 `#047857` | agent-400 `#34d399` | Agent attribution as text or icon |
| `--okb-verified` | success-700 `#047857` | success-400 `#34d399` | A signed-off review step, always with `✔` |
| `--okb-pending` | warning-700 `#b45309` | warning-400 `#fbbf24` | A review step still owed, always with `◔` |
| `--okb-text` | neutral-950 `#171a26` | neutral-100 `#eef0f5` | Body and headings |
| `--okb-text-muted` | neutral-600 `#5a5f76` | neutral-400 `#a3a7ba` | Secondary text, meta |
| `--okb-ground` | neutral-50 `#f5f6f9` | neutral-975 `#141620` | The page canvas |
| `--okb-surface` | neutral-0 `#ffffff` | neutral-900 `#1d202c` | Cards, panels, inputs |
| `--okb-border` | neutral-200 `#e0e2ea` | neutral-800 `#2c3040` | Hairlines, dividers |
| `--okb-radius` | `10px` | — | Buttons, inputs and popovers (`rounded-md`), cards and dialogs (`rounded-lg`) |

The book's `--okb-primary-text` (`#3e4b86` light / `#a6b3d9` dark) is not a
role here. Nuxt UI derives primary text and primary fill from one
`--ui-primary`, and `--okb-primary` clears the text floor on both surfaces in
both schemes (5.95:1 at its worst, slate indigo on the light ground), so the
app names one primary. Both of the book's steps are on the ramp anyway:
`primary-900` in light, which `--okb-primary-hover` takes, and `primary-300` in
dark, which is `--okb-primary` itself.

`--okb-agent` and `--okb-verified` are the same hue: the book gives the
verified state the agent's mint, one step darker than the mark. They stay two
ramps because a Nuxt UI success toast reads the second and carries no agent
meaning.

The mark's mint (`agent-500`) is 2.5:1 on white, so it fills the mark's block
and nothing else. Anything that has to be read — an agent badge, a "via"
label, an icon — takes `--okb-agent-text`, which is the same mint two steps
darker at 5.5:1.

### The agent colour is not an accent

The mint says one thing: an agent had a hand in this. It is the mark's block,
the agent review step's rule and pill, the tint and rule of the search page's
AI summary, the "working here" wash in the editor, the presence chip on an
agent peer, the read page's byline on an agent-authored block, and the
assistant's own badge. Ordinary controls — including the buttons that open the
assistant — are `--okb-primary`. A general-purpose accent is a bug.

Which of the two steps a surface takes follows from what sits on it:
`--okb-agent` where the colour is the mark, a rule or a tint, and
`--okb-agent-text` wherever a word, a glyph or an icon has to be read — the
assistant's badge and launcher, the agent presence chip, every agent label.

### Colours that are not brand tokens

Two palettes name people and things rather than states, so no brand token
applies to them: the awareness colours a collaborator's caret and avatar carry
(`shared/utils/presence.ts`), and the per-space identity colours
(`shared/utils/kb-spaces.ts`).

## Schemes

The scheme follows `prefers-color-scheme` (`colorMode.preference: 'system'` in
`nuxt.config.ts`, `classSuffix: ''`), so the class on `<html>` is the plain
`.dark` the role block is keyed on.

A reader who wants the other one takes it: `<UColorModeButton>` sits in the
sidebar footer, right of the account trigger, and writes the choice to
`@nuxtjs/color-mode`'s store, which outlives the reload. It is offered where
the sidebar is expanded; the collapsed rail has room for the account trigger
alone.

## Type

Manrope for UI and body, JetBrains Mono for code, block ids, owner strings and
hashes. Both are variable woff2 (OFL 1.1) in `frontend/public/fonts/`, with
each licence text beside its file; `main.css` declares the two faces itself,
with `font-display: swap`. There is no font package and no CDN — one file per
family covers every weight the book uses.

`--font-sans` and `--font-mono` in `@theme` are the only place a family is
named, so the `okb-prose` and `okb-prose-compact` utilities pick the faces up
through `font-mono` and the inherited body font rather than naming them again.

Weights are the book's: 400 body, 500 emphasis and H2/H3, 600 display, H1 and
labels. The wordmark is `Open` at 400 beside `Knowledgebase` at 600.

`@nuxt/fonts` arrives with Nuxt UI and provisions any family it finds named in
CSS. `fonts.provider: 'local'` in `nuxt.config.ts` leaves it the local provider
alone — which serves only what `public/fonts` holds, and that is nothing — so
the bundle stays the only source of the faces.

## Logo

`frontend/app/components/chrome/Logo.vue` — `<ChromeLogo />` — draws the mark
and the horizontal lockup inline, filled from `--okb-agent` and
`--okb-primary`, so the reversed dark-scheme lockup is the same markup under
the dark role block. `variant="mark"` is the compact form, used where the
sidebar is collapsed. The sidebar lockup is a 28px mark beside the wordmark at
`text-base`. The mark never renders below 16px; the lockup never below 100px
wide.

## Icons

`frontend/public/`:

| File | Where it is used |
|---|---|
| `favicon.svg` | `<link rel="icon">`, the primary favicon |
| `favicon-32.png`, `favicon-16.png` | PNG fallbacks for browsers that take no SVG icon |
| `apple-touch-icon.png` | iOS home screen (180px) |
| `okb-app-icon.svg`, `okb-app-icon-192.png`, `okb-app-icon-512.png` | `site.webmanifest` |
| `site.webmanifest` | Installed-app name, icons, `theme_color` |
| `fonts/Manrope.woff2`, `fonts/JetBrainsMono.woff2` | The two faces `main.css` declares, each with its OFL text beside it |

The favicon is the two-colour mark on nothing; the app icon is the book's tile
— the mark reversed out of a slate-indigo square. The tile draws the gap
between circle and block with a stroke in the tile's own colour rather than a
mask, because that is what survives rasterising to the PNG sizes.

Drupal serves no logo or favicon of its own — the backend answers `/ce-api`
and admin routes only, and no recipe carries a theme setting.

## Titles and voice

Every tab reads `<Page> · OpenKnowledgebase`; the template is in
`frontend/app/app.vue` and pages set their own bare title.

The voice is calm and specific: full sentences, no exclamation marks, claims
that can be checked. State what the system does rather than how it feels.

## Proof

`tests/playwright/tests/brand-theme.spec.ts` asserts the lockup in both
schemes, the icon links, the computed font families, the agent and review
tokens, the focus ring, and that no surface paints a retired accent.
