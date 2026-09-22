# Editing, review and publishing

How a page moves from an edit to the live page. The rules are the same in every space; a space only decides which review steps it enforces.

## The three operations

| Operation | Who | What it does |
|---|---|---|
| **Save** | anyone who may edit the page | Writes a draft revision. Never publishes. Auto-save and the Save button do the same thing. |
| **Publish** | anyone who may publish in the space | Publishes the current draft. Only possible when no change still waits for a review step the space enforces. Offered on the edit page only. |
| **Sign-off** | a second pair of eyes | Records that one change's review step is done. Writes its own revision with a log message. Does not change whether the page is published. |

Nothing publishes on its own. A sign-off completes a review, and the user publishes.

## Review items

Every difference between the draft and the published revision is a review
item, and every item owes the same steps (ADR 0017):

| Change | The item it is reviewed under |
|---|---|
| A block's text, or a block added | the block |
| A block moved to another place | the block, marked `moved` |
| A block removed | the block's own record, kept and marked `deleted` |
| The title | `field:title` |

A removed block and the title carry no text of their own, so their record is
what holds Publish back and what a sign-off names. It stands until the live
page agrees with the draft again.

## Review steps

Every review item records who wrote it and which review steps it owes:

- **Peer review**: a block written by a person needs a sign-off from somebody who did not write it (four-eyes). An admin may sign off their own block.
- **Agent review**: a block written by an agent needs a sign-off from a person. Any person may give it.

Which steps hold a Publish back is the space's choice:

| Space setting | Peer review holds Publish | Agent review holds Publish |
|---|---|---|
| Moderation on | yes | yes, when agent review is on |
| Moderation off (wiki) | no | yes, when agent review is on |

Both steps are always recorded, so turning a setting on later finds the history there. An item changed after its sign-off owes the step again.

## What the user sees

- While changes lack a review, the Publish button is greyed and says which changes are waiting and why. Pressing it does nothing.
- The sign-off control on a block is greyed with the reason when the rule refuses this user (their own block, or a block nobody is on record for).
- A removed block and the title have no text to carry a control, so the review panel lists them as rows of their own and each row carries its sign-off. The title also draws its pills under the heading in the editor.
- The versions tab lists every revision with a plain log: an edit, a sign-off ("Signed off 2 changes (peer) by editor2"), a publish.

## How it is enforced

- **Save**: the commit endpoint writes every content change as a draft revision. Field-level access keeps the review record (`field_block_meta`) out of every client's hands; Drupal writes it alone.
- **Publish**: a request that would publish is checked against the review record the save will leave behind. Any enforced step still pending refuses the request with 422 and the blocking items, each named in `meta.item`. This runs on the commit endpoint and as an entity constraint, so a JSON:API PATCH meets the same refusal.
- **Sign-off**: the reviewer's click reaches the collaboration server on their own authenticated connection. The server states it inside the next checkpoint under that connection's account, and Drupal applies it while computing the review record for that save, after recording the save's own writers. A reviewer who edited the block in the same session is therefore in its writer list and refused. A refused sign-off comes back in the checkpoint's answer with the reason; the save stands.
- One checkpoint may carry a sign-off and a Publish. The sign-off is applied first, so a Publish that it completes goes through in the same save.

Decisions behind this: ADR 0002 (writer sets), ADR 0004 (Drupal decides trust, publish and review), ADR 0017 (every change is a review item). Per-space settings: [space-access.md](space-access.md), "Moderation, per space". The checkpoint mechanics: [collab-server.md](collab-server.md).
