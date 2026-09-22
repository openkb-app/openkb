# ADR 0003: Agents write as live session peers, never to Drupal directly

Status: accepted (fago, 18.08.2026)

## Context

Agent output is a draft contribution to a shared session: humans see it
while it happens and rework it before it reaches Drupal.

## Decision

- An agent joins the document's live Y.js session in-process
  (`openDirectConnection`, the agent-peer adapter) and edits as
  ordinary CRDT ops; it never PATCHes page content itself while a
  session exists. Persistence is the normal checkpoint machinery.
- Admission is the session router's job — and is write control, since
  `openDirectConnection` has no auth handshake.
- The agent appears in presence ("fago via claude") and enters each
  touched block's writer set with its `via` label (ADR 0002).
- **An agent may initiate the session.** No human needs to be
  connected; humans can join the live session at any time and find the
  agent's edits as working copy.
- **Committing works without humans; publishing is always somebody's
  explicit act.** An agent-only session checkpoints under the agent's
  token (ADR 0001), and every content checkpoint — agent, auto or the
  Save button — lands as a draft: nothing publishes unless a person
  asked for a publish, which is a payload naming the state, and that
  write still passes the gate (ADR 0004).

## Consequences

- Humans see agent edits stream in and edit over them like any peer's;
  no external-change banner, since nothing lands in Drupal behind the
  session's back. Undo is per-session — the Y.js UndoManager takes back
  only what this client wrote — so an agent's or a peer's write is
  changed by editing it, not by Ctrl+Z.
- Agent work is never blocked on human presence, and never reaches
  readers past a review the space requires.
- A personal consumer acts as its owner's account (OKB-58):
  `revision_uid` names the human; `via` distinguishes "fago" from
  "fago via claude", which is how the revision log and the page both name
  it.
