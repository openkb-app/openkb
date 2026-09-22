# ADR 0014: Stored comark keeps the serializer's HTML entities

Status: accepted (fago, 11.09.2026)

## Context

- Page bodies travel as comark, a markdown dialect. The editor writes it
  with `@tiptap/markdown`, which HTML-encodes `&`, `<` and `>` in every text
  node (`AT&T` is stored as `AT&amp;T`) and then backslash-escapes markdown
  syntax. The encoding is what keeps a literal `<span>` or `&copy;` from being
  read back as HTML or an entity.
- Entities are valid CommonMark; comark decodes them, so the rendered page is
  unaffected. Only readers of the stored form see them: diffs, JSON:API, the
  collaboration session.
- The library offers no option for the text encoding, and swapping it for
  backslash escapes means overriding a private method and keeping a copy of
  the escaping rules.

## Decision

- Text nodes carry HTML entities for `&`, `<` and `>` in the stored comark, as
  the serializer writes them. No override, no second set of escaping rules.

## Consequences

- The entities stay inside the system: stored comark, the collaboration
  session, the editor, JSON:API. The boundary is every surface that hands
  page content to a model or serves it as source — the tools and the `.md`
  lanes (`GET …/*.md`, `PUT …/draft.md`, `POST /api/agent/edit`). Each decodes
  the entities on the way out and encodes on the way in, so whoever reads there
  reads characters and can send the same text back.
- The encode is not the decode's inverse. What comes in only needs to parse to
  the document its sender wrote, so it spells the two things the parser would
  otherwise read as markup — an `&` opening an entity reference, a `<` opening
  a tag — and leaves the rest to the parser; the next editor save writes the
  serializer's full spelling.
- Tests on the stored form assert the entity form; tests on what a boundary
  serves or accepts assert the plain form.
