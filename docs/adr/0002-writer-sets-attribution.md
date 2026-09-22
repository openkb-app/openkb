# ADR 0002: Per-block writer sets — attribution and approval rules

Status: accepted (fago, 18.08.2026)

## Context

The review model needs two facts per block: which accounts changed it
since its last approved state (four-eyes), and whether an agent wrote
in it (agent step). Both are membership questions.

## Decision

- Per open document, the collab server keeps a **monotone writer set
  per block**: `blockId → { print, writers: Set<{uid, via}> }`. A pass
  at each writer boundary diffs content prints and adds the writer to
  each changed block's set. Agents are members like anyone else,
  carrying their `via` label.
- The checkpoint statement — `{ blocks: { id: [{uid, via}] }, acting_uid }`,
  made over the collab server's own connection (ADR 0001) — is
  **unioned** by Drupal into the block's open episode, only for blocks
  whose bytes changed. A statement on any other connection is not read
  at all, so a client cannot declare who wrote what.
- Approval: denied for set members and for an empty set, except global
  admins, who may self-approve (and approve empty-set blocks) — the
  review itself is never skipped. The agent step asks for a human, not
  a second one, so any human — the agent's owner included — may clear
  it. Where two or more accounts share an episode, mutual approval
  satisfies four-eyes: every contributor's work was seen by another
  pair of eyes. The sole author of a change never approves it alone.
  A `via` entry requires the agent step.
- Nothing stored or stated carries amounts: the sidecar records
  membership and a last-edit time, the statement `{uid, via}`. Per-uid
  character totals exist only in the collab server's in-process ledger,
  where they elect the acting account for a checkpoint nobody
  triggered.

## Consequences

- Union semantics make re-stating idempotent: re-stating a writer changes
  nothing, so discharge is one print comparison — drop the block's
  entry when its current print equals the stated one, else re-state.
- Only blocks whose stored bytes changed open an episode; text typed
  and taken back never does.
- Agent involvement survives human rework (the human is added, the
  agent stays) and any checkpoint carrier — the agent step holds in
  mixed human+agent sessions.
- No block has a main author. With no amounts there is nothing to rank
  contributors by, so read surfaces name the whole set, latest edit
  first.
