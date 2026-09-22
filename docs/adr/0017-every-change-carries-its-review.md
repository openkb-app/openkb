# ADR 0017: Every change carries its review

Status: accepted (fago, 13.09.2026); built by
[OKB-264](https://drunomics.youtrack.cloud/issue/OKB-264)

## Context

A review step exists to put a second pair of eyes on what the live
page will say. The sidecar records that per block (ADR 0002), and a
block is a stretch of text with an id — so a gate built on the blocks
a body holds only sees the kinds of change that leave one behind.

Three kinds do not. Taking a block out removes the very thing a
review step would be recorded on. Moving a block changes what the page
says while every block's bytes stay identical. The title is a node
field, split off from the body's markdown at the read boundary, so no
block carries it. Each of them alters what a reader sees; none of them
alters a block.

## Decision

Where a space enforces review steps, **the publish operation requires
every difference between the draft and the published revision to carry
the sign-off of every enforced step** — peer and agent alike. No kind
of change is exempt: block text, block added, block removed, block
moved, title, and every other reviewed field.

That makes a **review item**, not a block, the unit the sidecar works
in:

- A block the body holds is a review item.
- A **removed block** keeps its entry, marked `deleted`. The entry is
  what a reviewer is shown and what the gate holds, because the text
  is gone. The mark comes off again when the body holds the block.
- A **reviewed field** takes an entry of its own, keyed `field:<name>`
  — `field:title` today. A block id is `[\w-]+`, so the colon keeps
  the two namespaces apart.
- A block that **moved** is a changed block, marked `moved` so the row
  can say which difference it stands for. Order is compared as the
  longest common subsequence of the two id sequences, so inserting one
  block does not re-open the blocks below it, and swapping two blocks
  yields one item, not two.

Every item takes the same `pending:<step>` entry, the same four-eyes
rule, the same sign-off, and is named the same way in a refusal. Its
writers are recorded as the save operation is written, from the same
credential: a checkpoint states them per item, the title's from the
fields lane.

An item with no text of its own stands for as long as the live page
still disagrees with the draft about it: a removed block's entry while
the live page still shows the block, a field's entry while the live
page still shows the other value. Retiring an entry takes its settled
`review:<step>` record with it — the difference that was reviewed is
no longer there to review.

### Writers of an item with no text

A change a checkpoint's window names no writer for is stamped with an
empty writer set, which nobody but an admin may sign off (ADR 0004).
For a block that is a hold with a way out: the next identified edit
re-stamps it. An item with no text has no such edit, so a window
naming nobody falls back to the accounts the entry already records a
contribution for — the wider answer, and the one that always holds
whoever wrote what is being removed or replaced. An entry recording
nobody either keeps the empty set.

A block that only changed place is a third case: its content never
moved, so the window witnesses no writing on it at all. The account the
checkpoint acts as made the move and is stamped for it, which is what
lets a peer clear it.

### One word for it

`item` names a review item wherever code or the wire says which one: a
refusal's `meta.item`, a stated sign-off's `item`, the sidecar's keys.
Prose the user reads says **change**, because "3 change(s) are waiting
for review" is what a refusal is about. `block` keeps its own meaning —
a stretch of text with an id — and is not used for the other two.

Drupal decides at the save operation, as ADR 0004 says. A client
cannot publish past it, and the admin exception is ADR 0002's,
unchanged.

## Consequences

- A title fix and a deleted paragraph each ask for a second pair of
  eyes where a space enforces the peer step.
- A refusal names items rather than blocks (`meta.item`), so a client
  reads one list whatever the change was.
- A reviewer is shown something for a change with no text: the entry
  is the only place a removal or a title edit can be reviewed from.
- A title-only save is a publication event, so a page whose live
  body carries id-less text is refused a re-publish after a mere
  rename. That is ADR 0004's structural refusal, reached by one more
  road.
