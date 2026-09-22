# ADR 0010: Search against OpenSearch, queried from Drupal

Status: accepted (fago, 24.08.2026); amended (fago, 08.09.2026);
amended (OKB-309, 20.09.2026)

## Context

- Search and read performance is a core product concern.
- The `kb_chunks` OpenSearch index holds one row per section of a
  published page, the section's text beside its vector, populated on
  save through the Nuxt comark tree passes — the frontend is in the
  indexing loop.
- AI retrieval's callers are inside Drupal: the chat runs there, and
  an MCP tool call has bootstrapped Drupal before it searches.
- A hybrid query needs the section's vector, which only the store
  holds, and the embedding of the query, which only Drupal can ask a
  provider for.
- Page access is space-scoped, and Drupal is the access authority
  (ADR 0004).

## Decision

- **One index, one read path, one access rule.** Every search and
  listing read goes to OpenSearch (`kb_chunks`) through the Drupal
  read path: the search page and the `[[` picker through
  `GET /openkb/search`, AI retrieval through the same retrieval
  service. No entity queries on the search route. The database serves
  writes, access grants and page rendering only. The frontend
  forwards the caller's own credentials and filters nothing of its
  own.
- **Access is enforced where the query runs, from the one
  authority.** A Search API processor on the index reads the
  `SpaceAccessMap` service.
- **Fail closed**: on an empty readable set the query is aborted and
  answers nothing, and a Drupal that cannot be reached is an error on
  the frontend, never an empty success.
- The index carries published content only; drafts and unpublished
  revisions stay out. A draft is readable only through the editing
  session, which runs its own access gate.
- **`GET /openkb/search` is the product UI's one search endpoint.**
  AI retrieval stays reachable as a tool as well: in-process for the
  chat, over `/mcp` for agents. The `searchPages` tool executes in
  Drupal by ADR 0009's default rule.
- The index is a serving contract for every consumer.

## Consequences

- Test coverage must prove the boundary, not the happy path: a caller
  receives no hit from a space they cannot read (shown across two
  accounts, and by inversion — with the filter removed, the spec
  fails), and the frontend's fail-closed path answers an error, not an
  empty success.
- Every consumer answers the same hits for the same account and query,
  because they run the same read.
- Index schema changes are reviewed as API changes — the index serves
  the search page, the picker and AI retrieval alike.
- **One exception:** the search page's empty-query listing runs an
  entity query under Drupal's own node grants, until OKB-312 moves it
  onto the chunk index with the facets.
- A search costs a Drupal bootstrap. A title prefix — the picker's
  offers and the search box's suggest — runs the lexical clause alone
  and embeds nothing, so it is cheap enough to ask for per keystroke;
  the hybrid search is submit-on-Enter.
- A retrieval score gate is relative to the turn's top hit: BM25
  scores are unbounded, so no absolute number means the same thing
  across two queries.

## Open

- Whether the product UI consolidates onto the Drupal retrieval tool
  through the generic forward (ADR 0011).
