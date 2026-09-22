# ADR 0012: Every comark component renders as a Vue component

Status: accepted (fago, 05.09.2026)

## Context

- Page bodies and chat answers are comark markdown, and components
  appear at both levels: block-level (`::callout`, `::infobox`,
  `::image`) and inline (`:doc[…]{nid}`, an inline `:image{}`).
- A component carries behaviour the markup cannot: a document link
  navigates inside the app and resolves per reader, an image resolves
  its media, a callout has its own state. Only a mounted Vue component
  can attach that; inert HTML gives a plain anchor and a plain `<img>`.
- Block identity — the block id, its card, margin, comments and anchor
  — is a property of block-level elements. An inline component lives
  inside a block and must not become one.

## Decision

- Every comark component renders as a Vue component, the inline ones
  included. The whole body is one Vue tree, so there is no HTML-string
  stretch for a component to be stranded in.
- Inline components are not blocks. Block identity — the block id, its
  card, margin, comments and anchor — belongs to block-level elements
  only; an inline component takes part in the block it sits in.
- Rendering stays one path: the same tree passes and the same component
  map serve the read view and the chat. Server-side resolution — which
  page a link names, what the reader may see — stays on the server and
  reaches the component as props on the tree.

## Consequences

- A document link renders as a `NuxtLink`: it navigates in the app and
  can grow behaviour (prefetch, popovers) as a component.
- Inline images use the same component as block images.
- Block attributes stay on the block element, which is where the block
  card, margin, comments and anchor find them.
- Search indexing, the `.md` output and the editor are unaffected.
