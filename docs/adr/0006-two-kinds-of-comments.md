# ADR 0006: Inline review comments ride editing; document comments ride the page

Status: accepted (fago, 18.08.2026)

## Context

Two different conversations happen on a page. Editors converse
about blocks while reviewing — anchored to working-copy text, resolved
and archived. Readers and members discuss the published page —
permanent, unanchored. Confluence, Notion and Google Docs
all carry both kinds; underneath they are different lifecycles.

## Decision

- **Inline review comments are part of editing.** Their live truth is
  the collaboration session, per page translation. Their durable
  home is own storage beside the page, never on the page entity
  and never in its revisions. Readers never see them.
- **The storage is generic per-entity storage, and nothing else.** The
  `inline_comment` module stores a message under
  `entity_type + entity_id + langcode + anchor + thread_id + msg_id`,
  plus its author and the clock. Everything else — what was said, the
  agent label, the quoted range, whether the thread is resolved —
  rides an opaque `data` map it never reads. It knows nothing of
  blocks, agents, sessions or review.
- **One API per entity translation, three verbs.** `GET` loads,
  `PUT` states the set (stated coordinates are stored, unstated ones
  are dropped), `DELETE` drops it. Every verb answers exactly the
  accounts that may `update` the commented entity; there is no
  permission beside that.
- **One server credential names authors.** A `PUT` presenting the
  configured secret is trusted for the author each message states;
  any other caller's messages are filed under the sending account.
  That is what lets one delivery carry what several people said.
- **The collaboration server owns the flow.** It seeds the session's
  live map from the `GET`, and states the whole map back with a `PUT`
  at every checkpoint — a request of its own, beside the commit, so a
  note adds no revision and a session that only reads and comments
  still delivers what was said. Thread standing is derived from the
  messages, on the client. Drupal's workflow model is comment-blind.
- **Document-level comments are discussion of the published page,**
  not part of editing: core `comment` entities, permanent, no session
  involvement. They arrive once space roles define their audience
  (viewers read, members write).

## Consequences

- Page loads, revisions, and reverts are untouched by any volume of
  discussion; reverting a page never rolls conversations back.
- The durable set mirrors the live one, so restating it is free and a
  message that outlives what it annotated leaves without the storage
  knowing what that was.
- Review chatter stays out of the published record; a thread worth
  keeping is promoted to a document comment, not retained by default.
- The server names authors under its own identity — ADR 0001.
- Core comments serve exactly the kind their machinery fits; the
  collaborative kind stays on the session + witnessed-delivery model.
