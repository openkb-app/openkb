# ADR 0004: Drupal stays in control of trust, publish, and review

Status: accepted (fago, 18.08.2026)

## Context

Writer sets and review flags decide who may approve and whether an
page may publish. Any other party able to write them bypasses the
review model.

## Decision

Every trust, publish, and review decision is Drupal's:

- **Gate data** (the `field_block_meta` sidecar) is written by Drupal
  alone. Clients have no field edit access; the collab server
  contributes only the credentialed statement (ADR 0001/0002), which
  Drupal validates and applies itself.
- **Publishing** is its own operation and passes one gate. Saving
  writes a draft and is never refused for a review somebody else owes.
  A publish is possible only while no block still owes a step the
  space enforces; otherwise Drupal refuses it with a machine-readable
  422 naming the blocking blocks, in every space — a wiki space
  enforces fewer steps, not none. Nothing publishes on its own: a
  sign-off completes a review, and a user publishes.
- **Sign-off** is a collab action carried by the checkpoint statement
  and applied by Drupal. The collaboration server records it under the
  connection it arrived on — never read out of the document, which
  every peer may write — and Drupal applies ADR 0002's rules to it
  while computing the sidecar this save will write, after the save's
  own writers are on the changed blocks. That is what keeps four-eyes:
  a reviewer who typed in the block during this checkpoint is in its
  writer set and is refused. A refused sign-off is reported back with
  its reason; it does not refuse the save. An agent's seat may not
  sign off: the agent step asks for a human, and Drupal refuses it on
  its own side of the wire whatever the collaboration server forwards.
  Because the publish gate reads that same sidecar, one checkpoint may
  carry the last sign-off and the publish it completes.
- A changed block a *stated* window does not name gets an **empty
  writer set**: approvable only by an admin, healed by any identified
  edit — Drupal never guesses an author. ADR 0005 keeps this path
  theoretical. A write that states no window is nobody's checkpoint and
  is credited to the account that made it, so no ordinary save can
  empty a block's set.

## Consequences

- The worst failure mode is a blocked publish — never misattribution,
  never self-approval, and never lost text.
- Chips and bylines are best-effort display; only Drupal-produced gate
  data is trusted.
