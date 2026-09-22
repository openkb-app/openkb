# The collab server: how Nitro and Hocuspocus work together

The realtime collaboration backend is a [Hocuspocus](https://tiptap.dev/docs/hocuspocus)
server **embedded inside the Nuxt/Nitro process**. One deploy unit serves SSR,
the API proxy layer, and the Y.js sync endpoint.

Why embedded: same-origin cookie auth (the Drupal session cookie rides the
WS handshake — no token relay), in-process access (`useHocuspocus()`,
`openDirectConnection` for the agent adapter), zero extra infra for the
single-replica shape (see [Constraints](#constraints)). Hosting rules live in
the README under "Hosting the collab server".

## Component map

| Piece | File | Job |
|---|---|---|
| Hocuspocus instance | `frontend/server/plugins/hocuspocus.ts` | Nitro plugin: SQLite persistence, auth, load/reconcile, attribution ledger |
| WS transport bridge | `frontend/server/routes/collaboration.ts` | h3 `defineWebSocketHandler` → `hp.handleConnection()` |
| Instance accessor + flush | `frontend/server/utils/hocuspocus.ts` | `useHocuspocus()`, `flushPendingStores()` |
| Health / flush endpoints | `frontend/server/api/collab/{health.get,flush.post}.ts` | compose healthcheck; loopback-gated force-flush |
| Dev signal wrapper | `frontend/scripts/dev-server.sh` | traps SIGTERM in dev containers, flushes before exit |
| Commit service | `frontend/server/utils/commit.ts` | `commitDocument()`: Y.Doc → markdown → `POST /openkb/node/<nid>/commit`; dirty check, concurrency check, pipeline seams |
| Commit schema | `frontend/server/utils/editor-schema.ts` | Vue-free ProseMirror schema — server serializes byte-identically to the browser |
| Checkpoint scheduler | `frontend/server/utils/commit-scheduler.ts` | per-doc quiet + max-dirty timers; deduped |
| Attribution ledger | `frontend/server/utils/collab-attribution.ts` | per-block writer sets + session window (ADR 0002) |
| Commit RPC | `frontend/server/api/node/[id]/commit.post.ts` | manual Save under the caller's cookie; one checkpoint, landing as a draft revision |
| Client provider | `frontend/app/composables/useLiveCollab.ts` | `HocuspocusProvider` + `y-indexeddb` mirror |
| Flush proof | `scripts/collab-flush-test.sh` | edit → stop inside debounce → restart → edit is in SQLite |
| Bridge integration test | `frontend/server/collaboration.integration.test.ts` | real WS handshake against a running stack (vitest `integration` project) |

## Connection flow

```
Browser (TipTap + HocuspocusProvider)
   │  wss://<frontend-host>/collaboration        Drupal session cookie rides along
   ▼
Nitro route /collaboration (crossws)             routes/collaboration.ts
   ▼
Hocuspocus onAuthenticate                        plugins/hocuspocus.ts
   │  document name must match  node:<nid>
   │  cookie → GET {drupal}/openkb/node/<nid>/join-access; grant only with
   │  node update access AND no denied session field (per cookie+nid,
   │  cached 60s)
   ▼
Hocuspocus onLoadDocument
   │  live session in memory? → join · SQLite snapshot? → load + reconcile
   │  else → empty doc; client seeds from Drupal markdown
   ▼
Y.js sync — edits fan out to peers, debounced onStoreDocument → SQLite
```

## Storage model: hot vs cold

The Y.Doc is the authority *while editing*, Drupal *at rest*:

| Layer | Holds | Written | Is a revision? |
|---|---|---|---|
| **Hot** — SQLite (`var/hocuspocus.sqlite`, `HOCUSPOCUS_SQLITE`) | Y.Doc binary per document | continuously, debounced ~2s | No — crash-safety only |
| **Cold** — Drupal `field_kb_body` | committed comark markdown | by the commit service | Yes — one commit, one revision |

Inside each document (synced to peers like any CRDT data):

- `_meta` Y.Map — session coordination: `drupal_changed`, `last_save_at`,
  `last_commit_hash` (dirty check, seeded from Drupal so an unedited doc is
  clean), `last_commit` (confirmed-checkpoint signal; clients clear their
  y-indexeddb mirror on it), `commit_error`, `fields_baseline`,
  `external_change_detected` (Drupal refused a commit as stale; renders the
  banner), `reset_at`.
- `_attribution` Y.Map — the ledger's durable half (open writer-set episodes +
  Drupal's last-stored prints, ADR 0005). Persisted with the document, adopted
  on load: an undelivered window survives a restart and is stated by the next
  checkpoint.
- `fields` Y.Map — entity fields (below).
- `comments` Y.Map — inline review threads (ADR 0006).

A hot document was seeded from Drupal by whatever code was running when it
opened, and the stored `# <title>` line never enters it (the title is a node
field — `frontend/server/utils/title-heading.ts`). A deploy that changes what a
document is meant to hold — which of the stored bytes reach it, how a block is
spelled — leaves every hot document holding the old shape, and its next
checkpoint writes that back. Follow such a deploy with
`./scripts/reset-collab-store.sh`: it drops the snapshot store and restarts
`frontend`, so each document is seeded from Drupal again.

An external write to the node surfaces at the next commit: Drupal refuses a
stale commit with 409, and the commit service records that in
`external_change_detected` so every connected peer sees the banner. A
successful commit clears it.

## Admission: update access, and the fields

Admission is the security boundary (ADR 0003): the Y.Doc is a shared buffer, so
whoever joins can influence content a later checkpoint commits — under someone
else's credentials. Node update access is not the whole question: Drupal
decides field edit access separately (`FieldItemList::access()`,
`hook_entity_field_access()`), per field and per entity, so a field the joiner
may not edit would be editable through the session all the same.

So the gate asks one route, `GET /openkb/node/<nid>/join-access`
(`openkb_collab_api`'s `JoinAccessController`), which answers both halves and
names the account it answered for — the identity the session is captured
under. Any denied field refuses the join, and Drupal logs a warning naming the
account and the fields. A response carrying no readable answer is refused too:
admission is a security decision, and one Drupal did not make is not a grant.

The fields are the session's own: the title, `field_kb_body`, and everything
the frontmatter exposure contract lists. Refusal is whole — a per-field partial
session does not exist. The agent gate asks the same route
(`server/utils/session-router.ts`), so an agent token whose owner lacks field
access is refused like any other joiner.

## Entity fields in the session

The `fields` Y.Map holds the title and every field the `frontmatter` form
display exposes — that display is the exposure contract, published as JSON
Schema by `GET /openkb/schema` (`x-field-name` = JSON:API name). No field name
appears in frontend code. The values are not a read of their own: they are
mapped off the props of the CE working-copy page the body lane already
fetched, so both lanes describe one revision. Pieces: `entity-fields.ts`
(value model, diffing, `mapCeFieldValues`), `drupal-fields.ts` (the exposure
contract, cached 60s), `doc-seed.ts` (`seedFields()` on session-less
reconcile), `useEntityFields.ts` (client bindings).

Scalars as themselves; references as `{id, label}` (id = UUID); multi-value as
whole arrays (an array mutated in place has no merge identity). Concurrent
edits to different fields both survive; same field settles last-writer-wins.
Drupal wins whenever no session is live. Awareness carries `editingField` — a
hint, not a lock.

## Checkpoint flow: Y.Doc → markdown → revision

The commit service is the one path from hot to cold. It reads the live Y.Doc,
serializes through the editor's own schema, and writes
`POST /openkb/node/<nid>/commit` (`CommitResource`, extending core's JSON:API
resource — deserialization, access, validation and error documents are
JSON:API's). Each write bases on the **latest** revision, so a checkpoint
cannot revert an earlier one's draft (core refuses forward-draft PATCHes:
[#2795279](https://www.drupal.org/project/drupal/issues/2795279)).

```
commitDocument(docName, { trigger, identity })
   │  Y.Doc → ProseMirror JSON → editorSchema → serializeDocToMarkdown
   │  pre-serialize seam (OKB-42)
   ▼
dirty check: sha256(markdown) === _meta.last_commit_hash ?  → clean, no write
   │  concurrency: Drupal changed === _meta.drupal_changed ?  → else 409
   │  payload extenders (OKB-9 field diff)
   │  POST /openkb/node/<nid>/commit      carrier + session statement
   ▼
update _meta · discharge the stated window (if honored) · post-commit hooks
   ▼
peers observe last_commit → clear y-indexeddb mirror; history chip advances
```

The schema and serializer are the editor's exact definitions, so server output
is byte-identical to the browser's (tripwire:
`server/utils/editor-schema.test.ts`).

### The checkpoint's carrier and its statement

The **carrier** answers *may this write happen* — access, roster, validation.
It is the collaboration server's own Bearer token (ADR 0001,
`server/utils/collab-identity.ts`) for every checkpoint but one: an agent
ending its session carries its own. A captured peer cookie is never replayed
onto a write; the manual RPC's cookie only identifies the caller.

The **session statement** is a member of the same request body and answers *who
is acting* and *who wrote what*: the acting account (`acting_uid` — the peer
who saved, or the human the window elected where nobody did) and per-block
writer sets (`session.blocks`, membership only). Drupal performs the write as
the acting account (`account_switcher`), so its own page access, transition
permissions and revision attribution apply; it unions the sets into each
changed block's episode and seeds four-eyes from them (ADR 0002). A changed
block the statement does not name gets an empty set — approvable only by a
global admin, healed by an identified edit (ADR 0004).

**The state a checkpoint lands in is Drupal's to decide.** A payload naming
`moderation_state` is a deliberate editorial act — publish, revert — and is
honoured as sent, unless the review gate holds it (`docs/space-access.md`). A
checkpoint names none and lands as a draft revision
(`CommitResource::commitState()`), Save included. So the frontend asks nothing
about the policy before saving, and no checkpoint can publish (ADR 0003/0004).

**Who is believed is an identity, not a permission.** Drupal reads a statement
only where the request's OAuth token carries the collaboration client's own
`collab` scope (`\Drupal\openkb_workflow\CollabServerIdentity`) — the
client-credentials-only scope `openkb_recipe_collab` ships and
`scripts/setup-collab-oauth.sh` provisions the consumer with. A cookie carries
no token and therefore no scope, so no browser save can be read as a
checkpoint whatever the account behind it holds — uid 1 included. An agent's
token cannot either: the scope enables `client_credentials` alone, and an
agent's is issued by the authorization-code grant.
`use collaboration api` remains the access floor a checkpoint's writes answer
to, and says nothing about belief.

So a **save is one write**: the text, the window that accounts for it and the
fact that the user asked reach Drupal together, under one carrier, as one
account. Drupal is never left holding a paragraph without its writer set, which
is the window in which the paragraph's own author could approve it.

An **agent's session-end checkpoint states nothing**: its own token is the
carrier and Drupal reads a statement nowhere but the collaboration client's
connection, so it is an ordinary save by the token's owner, credited for every
block it changed. The window it did not state is written by the next checkpoint
this server carries, normally the disconnect one the agent's departure fires.
Such a write moves no text, so Drupal books it onto the revision it describes
rather than beside it (`CommitResource::statesOnly()`), leaving that revision's
log, its author and the page's `changed` where the content write put them.

Writers without a browser seat — the `.md` PUT, MCP tools, the agent adapter —
tag their transactions (`AgentOrigin`, `server/utils/agent-peer.ts`) and enter
the writer sets like any peer, agents with their `via` (ADR 0003). The tag is
a writer boundary: the interrupted peer is paid before those bytes land.

The client credentials have **no committed default**
(`OKB_COLLAB_CLIENT_ID` / `OKB_COLLAB_CLIENT_SECRET`, generated per environment
by `phapp setup` and provisioned into Drupal by
`scripts/setup-collab-oauth.sh`). Without them the server has no identity, and
a checkpoint reports `no-credentials` rather than writing under somebody
else's name. The same pair carries the registration relay
(`server/routes/register.post.ts`) onto Drupal's bridge.

### One revision, one author

A checkpoint serializes the whole document, so it can only be credited to one
actor — and only to the one whose ops it carries. Agent sessions on a node
therefore hand the document's pending work over
(`server/utils/agent-sessions.ts`): a second credential writing the same node
checks the previous writer's work in under *that* writer before its own ops join
it, and the document's captured carrier follows. A session that handed the
document on never checkpoints it again. When the handover cannot commit — a
browser peer is in the room, whose own checkpoint rules own persistence — no
agent session signs that document, and the quiet timer carries it under the
peers' carrier.

### Conversations, beside the checkpoint

Inline comments are live in the `comments` Y.Map and durable in Drupal's
generic `inline_comment` storage (ADR 0006). Every checkpoint states the whole
map with one `PUT /api/inline-comments` — a request of its own, so a note adds
no revision and a session that only reads and comments still delivers what was
said. The map is a mirror: coordinates the statement omits are dropped, so the
block sweep on this side is what removes a conversation from Drupal too.

The `PUT` goes out under the server's own token, like the checkpoint beside
it, and each message names its own author — which the endpoint takes every
caller at its word about. So a review pass whose peers have all disconnected
still delivers what they said. A document is stated only after a seed has read
Drupal for it (`_meta.comments_synced`) — a full set from a map that was never
filled would delete what Drupal holds.

### The review mark, ahead of the checkpoint

A review mark is drawn from the `blockMeta` Y.Map, and everything in that map
is a copy of Drupal's `field_block_meta`, re-read after each checkpoint
(`syncSidecarFromDrupal`). A mark that waited for that would appear one quiet
timer and two Drupal round trips after the edit that earns it.

So the attribution pass also mirrors what it has witnessed
(`server/utils/collab-sidecar.ts`): the flags the open window will earn, by
Drupal's own widening rule (`PageBlocks::markPending()` — every writer joins
the peer step's baseline, a writer carrying a `via` raises the agent step,
approvals the edit outdates are dropped). Leading-edge throttled by
`OKB_COLLAB_MARK_THROTTLE_MS`, so the first write of a burst is mirrored at
once and continuous typing costs one pass per window.

The mark is drawn and acted on like any other. Its baseline is the writer set
this server witnessed — the very set the checkpoint will state — so four-eyes
reads the same answer off it before the sign-off, and the sign-off itself
rides the checkpoint that puts the episode on Drupal's record (see below).

**Which** rule applies per block stays the checkpoint's decision, and the pass
always assumes the first of `BlockAttribution::projected()`'s four: a changed
block is stamped, one the window names but the diff does not is carried, one
whose bytes end up equal to the published revision takes that revision's entry
back, and one changed with no writers is stamped unaccounted. So a paragraph
edited back to the published wording draws a mark in a second and loses it at
the checkpoint. Best-effort data healing on the authoritative answer, per ADR
0004.

Two things hold that answer authoritative:

- **The estimate reaches Drupal on no path.** The checkpoint body carries the
  text, the window and `based_on_changed`; the sidecar is not a member of it,
  and Drupal refuses the field from a payload anyway
  (`openkb_workflow_entity_field_access()`, `CommitResource::buildDocument()`).
  It is written into the Y.Doc, so the SQLite snapshot holds it across a
  restart — and a load drops it, because `onLoadDocument` seeds from Drupal.
- **Drupal's answer replaces it whole.** `writeBlockMeta` aligns the map to
  exactly what Drupal stores and deletes every key Drupal does not have, so no
  estimate outlives the next checkpoint of any kind. `estimated`, a key Drupal
  never writes, is how the pass tells its own flags from Drupal's.

### Signing a block off

A sign-off is an act, and the act happens in the session. A Y.Doc is a buffer
every peer may write and awareness is client-declared, so neither can say who
signed off; the connection can, because `onAuthenticate` resolved it against
Drupal. So the sign-off is a **hocuspocus stateless message**
(`{type:'review.approve', block, step}`), recorded in server memory on the
document's ledger under `connection.context.user.uid`, never in the document.
It carries the block's print at the reviewer's click, so an action on a block
edited since is dropped before the statement is built — that edit has re-opened
the step anyway.

The sign-off then triggers a `manual` checkpoint, and the statement carries it
as `session.actions`. Drupal applies ADR 0002's rules against the sidecar that
same commit produced and answers per action in the response's `meta.review`,
which the commit service relays into `_meta.review` so every peer sees it. A
refusal is reported, never fatal: the text is the peers' work and is already
saved. The recorded sign-offs reach the marks through the ordinary sidecar
re-read.

One checkpoint may carry a sign-off and a publish operation: Drupal records
the sign-off while computing the sidecar the save writes, and the publish gate
reads that same sidecar. A sign-off on its own never changes whether the
page is published.

### Two blocks wearing one id

Block ids come off the client, so a modified client can hand in two blocks
wearing one id. **The id belongs to the block that already wears it**: the
ledger resolves collisions against the previous pass (chaining back to what
Drupal stores), and the commit's `dedupeBlockIds` applies that same answer
(`sharedIdKeepers`) — every other occurrence is re-minted (`b-x` → `b-x-2`,
deterministic) and arrives in review, named by nobody on a checkpoint and by
the saver on a user-carried Save. A duplicate cannot take another block's
history or credit.

Accepted residual: a byte-identical decoy (or a split from a minter-less
client) falls to document order — the attacker gains only that another's block
re-enters review, which delete access already gains; no unreviewed text
publishes, no credit moves.

### Canonicalization drift

comark has one canonical output style; imported or hand-written bodies differ
byte-wise on blocks that drift. Opening such a page is a clean no-op (the
dirty-check baseline is seeded with the markdown a commit *would* write). But
the first real edit checkpoints the whole document, canonicalization included:
every drifted block arrives changed-and-unnamed and is stamped for nobody —
one healing edit each. Closing this needs the checkpoint to mark
canonical-equal changes as unwitnessed-but-harmless, which nothing does yet.

### Triggers

| Trigger | Fires | Authorized by |
|---|---|---|
| `manual` | `POST /api/node/:id/commit` (Save), Publish, Revert, a peer's sign-off | the server's own Bearer token, acting as the caller |
| `agent` | an agent ends its session | the agent's own token |
| `disconnect` | last peer leaves | the server's own Bearer token |
| `quiet` | `OKB_COLLAB_COMMIT_QUIET_MS` (default 5 min) after the last edit | the server's own Bearer token |
| `max-dirty` | `OKB_COLLAB_COMMIT_MAX_DIRTY_MS` (default 30 min) backstop | the server's own Bearer token |

Only writes under the server's own token state a window, which is why an
agent's leaves one owed. A window whose writers Drupal has not recorded yet is
itself a reason to write: the next
checkpoint goes out on an unchanged body, and Drupal carries the sets onto
blocks it leaves alone. A Save made while unpublished changes stand
(`/openkb/node/<nid>/moderation`) is a second such reason: a wiki space
publishes on that Save, and what it publishes is the standing draft's text.
With nothing unpublished standing, a clean checkpoint stays clean; Drupal's
stored bytes need not match the editor's baseline byte for byte, so writing
anyway would cost a revision for a body nobody moved. Both reasons are checked
at each exit where the commit decides it has nothing to write: the body hash
matching, and the baseline adopted onto a Drupal already holding this body.
CI shortens the timers
(`dotenv/app--lupus-ci.env`: 15s/25s, `OKB_QUIET_E2E=1` un-skips the
quiet-timer specs). The `CheckpointScheduler` dedupes concurrent triggers; the
dirty check makes every trigger idempotent. See [Tuning](#tuning).

`disconnect` is the document's last checkpoint — the unload waits on it
(`beforeUnloadDocument`), so nothing after it asks again and nothing destroys
the document while it is still reading it. It therefore does not defer to a
timer when it collides with a running commit (it runs as soon as that one
settles), and its session re-verification re-asks an unreachable Drupal a few
times rather than skipping the write. What it still cannot write is logged as
`final checkpoint wrote nothing`.

## Shutdown: getting the last 2 seconds to disk

All shutdown paths funnel into one idempotent `flushPendingStores()`:

| Runtime | Signal path |
|---|---|
| **Production** | SIGTERM/SIGINT → Nitro `close` hook → flush (backed up by in-plugin `process.once` handlers) |
| **Dev containers** | signals never reach the worker thread — `frontend/scripts/dev-server.sh` traps them and calls `POST /api/collab/flush` on loopback |

`scripts/collab-flush-test.sh` proves the chain: edit → stop inside the
debounce → restart → the edit is in SQLite.

## Operational endpoints

`GET /api/collab/health` — document/connection counts + uptime; the `frontend`
container healthcheck (no auth, no document names). `GET
/api/collab/health/node/<nid>` — `{ live, connections }` for one document,
for a caller waiting on its own page to wind down; requires VIEW access on
the node and answers 404 to everyone else, since per-document detail confirms
the node exists. `POST /api/collab/flush` — loopback-gated, for shutdown
wrappers only.

## Tuning

Every timing window an operator may set lives in
`frontend/server/utils/collab-timing.ts`, read once at process start. A value
that is unset, unparseable or not a positive number falls back to the default,
so an environment that sets nothing runs exactly the table below and none of
these knobs has an off position. `dotenv/app.env` spells the defaults out;
`dotenv/app--lupus-ci.env` overrides the checkpoint thresholds and the agent
session lifetimes for e2e.

| Knob | Meaning | Default | Trade-off |
|---|---|---|---|
| `OKB_COLLAB_IDLE_MS` | Settle window: how long a retiring document's `_meta.deleted_at` broadcast gets before its peers' sockets are closed. | 100 ms | Shorter, a peer on a slow event loop learns its session ended only from the closed socket, which carries no reason. Longer, every delete of a live page waits that much before the node can be removed. |
| `OKB_COLLAB_COMMIT_QUIET_MS` | Auto-checkpoint this long after the last edit. | 5 min | Shorter = faster persistence and a smaller crash window, at more Drupal writes and more revisions per editing session. Longer = fewer writes, but more unsaved work living only in the SQLite snapshot. Below the time an editor needs to reach Save, the quiet timer beats them to it and the manual save has nothing left to write. |
| `OKB_COLLAB_COMMIT_MAX_DIRTY_MS` | Hard backstop from the first edit of a dirty window, so continuous typing still reaches Drupal. | 30 min | Shorter = a bounded worst case for an uninterrupted writer, at a checkpoint landing mid-sentence. Must stay above the quiet threshold, or it fires first and the quiet trigger never runs. |
| `OKB_COLLAB_MARK_THROTTLE_MS` | Shortest gap between two runs of the review-mark mirror. | 1 s | The first write of a burst mirrors on the leading edge whatever this says, so it bounds the worst case *inside* a burst, not the first mark. Shorter = a mark that keeps up with fast typing across many blocks, at more attribution passes — one pass is a fragment→ProseMirror conversion plus a print of every block, proportional to document size (0.9 ms on a 117 KiB page, 2.8 ms on 391 KiB). Longer = fewer passes on a big document, and a mark that lags the keystroke by up to this much after the first. |
| `OKB_AGENT_SESSION_IDLE_MS` | How long an agent stays in a document's session after its last call ends. A call still running holds the window open, so a `waitForChanges` long-poll keeps its seat up to the age cap. | 3 min | Shorter = a crashed agent frees the presence strip and the document sooner, at re-authorizing (two Drupal calls) whenever a thinking agent overshoots it. Longer = a cheaper editing run, and a stale agent sitting in the strip for that much longer. |
| `OKB_AGENT_SESSION_MAX_MS` | Longest an agent session may hold the authorization it opened with, however busy. | 15 min | This is the revocation lag: a token revoked, or a space withdrawing write access, is noticed only when the session closes. Shorter = a tighter bound, at one gate round-trip per window per busy agent. Must stay above the idle window, or it is the only thing that ever closes a session. |

Not tunable, deliberately: the store debounce (hocuspocus' own 2s, mirrored by
`scripts/collab-flush-test.sh`), the edit-permission cache TTL and the agent
presence cadence, which is pinned under y-protocols' 30s outdated timeout.

## Constraints

- **Exactly one replica.** Y.Doc state is in-process; a second replica
  split-brains every document. Never enable the node-cluster preset; don't set
  Nitro `baseURL` (breaks WS, nitrojs/nitro#2347).
- **The SQLite directory must be a persistent volume** in hosted environments
  — it is the only crash-safe copy of uncommitted edits (and of open
  episodes, ADR 0005). Multi-env replacement: `@hocuspocus/extension-database`
  on the project DB.
- **The store is coupled to the database** (ADR 0008): reinstalling or
  restoring the DB must wipe or restore the store with it —
  `scripts/site-install.sh` wipes it on every install.
- **Embedded mode never fires `onRequest`/`onUpgrade`/`onListen`** — check
  before adopting a hocuspocus extension that relies on them.
- **Dev-server file replacement kills in-memory docs** — SQLite + y-indexeddb
  + auto-reconnect absorb it.
- Long-lived WS through ingress needs idle timeouts above the 60s ping — see
  the README hosting section.

## Testing

```sh
docker compose exec -T frontend npx vitest run --project unit          # unit
docker compose exec -T frontend npx vitest run --project integration   # WS bridge
scripts/collab-flush-test.sh                                                  # shutdown flush
```

The integration test doubles as the drift tripwire for the crossws bridge —
run it after any `@hocuspocus/*`, Nitro, or h3 upgrade.
