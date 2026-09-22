# ADR 0011: Drupal APIs reach the browser through one generic forward

Status: accepted (fago, 04.09.2026)

## Context

- Drupal holds the session and decides access. The browser carries
  Drupal's session cookie on the frontend domain; the frontend server
  only passes it on.
- Server routes that exist only to forward one Drupal endpoint multiply
  the API surface, and once logic is added to one, nobody can tell
  whether Drupal or the frontend decided a result.

## Decision

- The frontend server forwards Drupal APIs through one generic route,
  not per endpoint. It forwards; it decides nothing.
- Only explicitly allowed Drupal APIs are forwarded, JSON only, and a
  write is subject to Drupal's own CSRF protection.
- The frontend has server routes of its own only where it owns the
  behaviour: the collaboration session and its checkpoints, login, the
  MCP wire, search (ADR 0010).

## Consequences

- What the browser receives is Drupal's answer; a state is debugged
  in one place.
- Making a further Drupal API reachable is a deliberate, reviewed
  change, not a side effect of the forward.
- A review rejects a new per-endpoint forward and a forward that
  gained logic.
