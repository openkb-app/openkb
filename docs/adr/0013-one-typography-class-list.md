# ADR 0013: One typography class list for the read view and the editor

Status: accepted (fago, 07.09.2026)

## Context

- A page's content is read and edited in the same place; pressing Edit swaps
  the rendered body for a ProseMirror surface, and the swap must move
  nothing.
- Both surfaces carry the same elements: `app/comark/components.ts`
  pins every comark tag to its native element, ProseMirror emits the
  same set.
- Nuxt UI styles an editable surface with one list of element selectors
  on the ProseMirror root (`ui.editor.slots.base`); its Prose components
  carry a second, unrelated list. Two lists drift.

## Decision

- `main.css` holds the typography as two Tailwind `@utility` blocks:
  `okb-prose` for the page content, `okb-prose-compact` for a body inside a
  box (callout, infobox, chat and search answers).
- `okb-prose` goes on the editor root (via `ui.editor.slots.base`), the
  rendered body and the answer surfaces; `okb-prose-compact` on a box
  body in both modes. `app.config.ts` adds only what an editable surface
  needs (gutter, selection tint, node decorations).
- `@tailwindcss/typography` and Nuxt UI's Prose components are not used
  for page prose.

## Consequences

- Parity is a property of the markup: both roots carry the same class;
  Nuxt UI's tokens reach every prose surface at once.
- `okb-prose-compact` sits inside an `okb-prose` root at equal
  specificity, so every class it states for an element the page content also
  names carries `!` (pinned by a unit test).
- Nuxt UI's editor theme merges its own element list onto the same root
  (`tv({ extend })`) at equal specificity and later source order, so
  where the two state the same property on the same element differently,
  ours is important (the paragraph line box, the image radius; pinned by a test).
- CSS that must out-rank the list is important *and* in
  `@layer utilities`: for important declarations the cascade weighs
  layers in reverse and unlayered styles weakest.
