# ADR 0001: The collab server is an OAuth client

Status: accepted (fago, 21.08.2026)

## Context

- The collab server writes on behalf of editing sessions: checkpoints,
  inline comments, seeds.
- Its statements name other users (writers, comment authors), so
  Drupal must know the caller is the server.

## Decision

- One required simple_oauth client (`client_credentials`) is the
  collab server's identity, provisioned from env credentials on
  install/update.
- Server requests carry its Bearer token. Peers authenticate their
  websocket with their own session.
- Trust is the client's own identity, read off the connection: a
  checkpoint's writer sets are believed where the request's token
  carries the client's `collab` scope, and nowhere else. A cookie
  carries no scope, so no browser save can claim it whatever the
  account behind it holds.
- The service role is access, not belief: writing without a roster
  seat, and stating comment authors — which the inline-comment
  endpoint takes every caller at its word about.
- The APIs are one surface for all callers; the server is an
  authenticated caller with its own client.

## Consequences

- A checkpoint needs no peer credential; a note survives every peer
  disconnecting.
- The acting account and per-block credit come from the statement
  (ADR 0002); the carrier never decides either.
- The server sends every checkpoint and names the human acting through
  it. Drupal switches to that account (`account_switcher`), so their
  own access, transitions and attribution apply. Text, credit and any
  publish are one write.
- An agent's session-end checkpoint carries the agent's own token,
  which states nothing: no account switch, and the write is the
  token owner's.
- A checkpoint says whether a person pressed Save; Drupal reads the
  space's policy and publishes on that alone. Every timer-driven
  checkpoint lands as a draft (ADR 0003/0004).
