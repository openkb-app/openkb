# ADR 0005: No crucial state in memory only — nothing lost on restart

Status: accepted (fago, 18.08.2026)

## Context

The collab server holds live documents, writer sets (ADR 0002), and the
checkpoint scheduler in process memory.

## Decision

Everything the review model depends on is durable:

- Pages and gate data live in Drupal — the durable home.
- The working copy and its writer sets live in the snapshot store,
  **written in the same SQLite transaction** per document update — the
  store never holds text newer than its accounting. Undelivered windows
  persist until an accepted checkpoint discharges them.
- On load, a persisted block entry whose print does not match the
  loaded document (store corruption) drops to unwitnessed (ADR 0004).
- One replica for now, embedded in the Nitro process (OKB-11). All
  session state is **per-document** — one scheduler, one writer-set
  state per document — so scaling later means document-sharded replicas
  with sticky routing, not shared state.

## Consequences

- A graceful restart loses nothing — the shutdown flush writes every
  open document and its sets to SQLite. A hard crash loses at most the
  un-flushed debounce seconds, as text and accounting together — no
  surviving text is ever unaccounted.
- A checkpoint that could not land (Drupal down, dead cookie) is
  delivered by the next session's first checkpoint, still naming the
  original writers.
- Only decoration may live in memory alone (presence, chip totals).
- Splitting the collab server out for scale shards documents across
  replicas without redesigning the model; split triggers live in the
  README under "Hosting the collab server".
