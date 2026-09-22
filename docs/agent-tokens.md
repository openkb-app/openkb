# Agent tokens

The other way onto the knowledge base: a client provisioned by hand, whose
secret an agent holds and issues its own tokens with.

**Use this when there is no browser and no person in the loop** — a headless
agent, a cron job, a script. It is the only path that works without an
interactive login, and the token acts as the account that provisioned it.

For a person connecting an interactive client — Claude Code, Claude.ai, any
MCP connector — use [connect by URL](agent-access.md#connect-by-url) instead:
the client registers itself and nothing here has to be done. The model both
paths share, and the scope table, are in [`agent-access.md`](agent-access.md).

URLs below are the local dev stack (`CLAUDE.md` "Bring it up"): Drupal at
`http://openkb-dev-project.localdev.space:8081`, frontend at
`http://node1.openkb-dev-project.localdev.space:8091`.

## 1. Provision a client

1. Log in as the owner-to-be — for local testing `editor1` /
   `Em_Y_12-LqnA` (`admin` is refused; every authenticated user may manage
   their own clients).
2. Open **Agents & API clients** from the account menu in the frontend
   (`http://node1.openkb-dev-project.localdev.space:8091/user/<uid>/api-clients`).
   The same page is on the Drupal side as the **Agent tokens** profile tab
   (`http://openkb-dev-project.localdev.space:8081/user/<uid>/api-clients`);
   `editor1` is uid 3 on a fresh install.
3. Create a client with a name (e.g. `claude`). The name is what attribution
   shows, one form for every reader: "editor1 via claude" on the page, in the
   assignee picker and in the revision log alike.
4. Copy the **client id** and **client secret** — the secret is shown exactly
   once, on the page that answers the submit.

Revoking a client (same page) kills its tokens and blocks new ones; the entity
stays so historical attribution keeps resolving.

## 2. Get a token

```sh
curl -s http://openkb-dev-project.localdev.space:8081/oauth/token \
  -d grant_type=client_credentials \
  -d client_id=<client id> \
  -d client_secret=<client secret>
```

Returns `{"token_type":"Bearer","expires_in":300,"access_token":"…"}`. Tokens
expire (`expires_in` seconds) — re-request as needed; the scopes default to
the client's own (`agent:read` `agent:write`), no `scope` parameter required.

Sanity check — who does this token act as:

```sh
curl -s -H "Authorization: Bearer $TOKEN" \
  http://openkb-dev-project.localdev.space:8081/openkb/agent/identity
# {"uid":2,"name":"editor1","via":"Claude","scopes":["agent_read","agent_write"]}
```

## 3. Connect an MCP client

The MCP server lives on the **frontend** (stateless streamable HTTP, Bearer
only — a request without a valid agent token gets 401/403):

```sh
claude mcp add --transport http openkb \
  http://node1.openkb-dev-project.localdev.space:8091/api/mcp \
  --header "Authorization: Bearer $TOKEN"
```

Then in Claude Code: `/mcp` lists the server, and the `openkb` tools are
available in any conversation.

Client-free smoke test with plain curl (JSON-RPC over POST):

```sh
curl -s http://node1.openkb-dev-project.localdev.space:8091/api/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Expected: a `result.tools` list of the frontend's own tools —
`getPageForEditing`, `updateFields`, `updateBlocks`, `commentOnBlock`,
`waitForChanges` — plus the ones relayed from Drupal, `tool_api__get_page`,
`tool_api__list_spaces`, `tool_api__create_page`, `tool_api__search_pages` and
`tool_api__find_drafts`.

## 4. What to try

Tool calls use `method: "tools/call"` with `params.name` + `params.arguments`.
Every result carries readable text plus the same data as `structuredContent`.

**tool_api__search_pages** — full-text search, Drupal's own tool relayed
here:

```sh
curl -s http://node1.openkb-dev-project.localdev.space:8091/api/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"tool_api__search_pages","arguments":{"q":"getting started"}}}'
```

Expected: `structuredContent.data` with `query`, `total` and `hits[]`
(`title`/`path`/`space`/`heading`/`excerpt`/`score`). Only pages the owner may
read appear.

**tool_api__list_assignments** — the comment threads assigned to this identity
that nobody has marked done and where somebody else said the last word, across
every page it may edit:

```sh
… -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"tool_api__list_assignments","arguments":{}}}'
```

Expected: `structuredContent.data.assignments[]`, each with `path`, `title`,
`blockId`, `threadId`, `text`, `assignedBy` and `at`. A thread handed to the
person rather than to the agent is not among them: the client's label is part
of who a thread is assigned to.

**tool_api__find_drafts** — the pages a search cannot answer: unpublished
pages, and published pages carrying a newer draft, matched on a fragment of
their title:

```sh
… -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"tool_api__find_drafts","arguments":{"title":"blog post"}}}'
```

Expected: `structuredContent.data.drafts[]`, each with `path`, `title`,
`space`, `state` (`draft` or `published-with-draft`), `changed` and `author`,
newest first. Only pages the owner may edit appear.

**tool_api__get_page** — read the *published* page by the `path` a hit
returned. This is Drupal's own tool, relayed here:

```sh
… -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"tool_api__get_page","arguments":{"path":"<space-slug>/<page-slug>"}}}'
```

Expected: `structuredContent.data` with `path`, `title`, `frontmatter` (the
exposed fields) and `markdown`. `markdown` is the whole page — frontmatter
block above the body — and it carries the `{#b-…}` block ids. It serves no
`versions` and no `status`: both describe the working copy, and a published
read is not what a write is based on.

**getPageForEditing** — read the *working copy*, the revision a write lands
on, including what a live editing session holds and has not committed:

```sh
… -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"getPageForEditing","arguments":{"path":"<space-slug>/<page-slug>"}}}'
```

Expected: the same four keys plus `versions`, which maps each `{#b-…}` id to
that block's current version, and — for a caller who may edit the page —
`status`, `{draft_exists, blocks_pending, can_publish}` answered for that
account, so a client states where the page stands instead of inferring it, and
`comments`, the open conversations about the page's blocks. Each thread carries
its `blockId`, its `threadId`, the `anchor` it was opened on (`from`/`to`/the
`quote`, or `null` for a note about the whole block) and its `messages`
(`id`, `uid`, `name`, `via`, `at`, `text`). Resolved threads are left out; pass
`includeResolved: true` to see them too.

**updateBlocks** — the agent write. Name the block to change by its
`{#b-…}` id from `getPageForEditing`, and send its version as `expect`:

```sh
… -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"updateBlocks","arguments":{"path":"<space-slug>/<page-slug>","blocks":[{"id":"b-…","expect":"<version>","markdown":"Replacement paragraph."}]}}}'
```

Expected:
`{"ok":true,"nid":…,"entry":"started","observers":0,"applied":{"blocks":{"b-…":"<version>"},…}}`.
`applied.blocks` maps every block the write touched to the version it holds now
— a replacement under the id you named, an insertion under the id minted for it
— so a follow-up edit to either sends that version as its `expect`, with no
read between.
`ok` means the editing session took the write, not that Drupal stored it — the
write lands in the page's **draft**, in the session the call put you in, and you
read it back with `getPageForEditing`, which serves that session. The
session persists it: on its own schedule while you keep working, once more when
it closes, and at once if another credential starts writing the same page — a
revision carries one author's work. `observers` above zero means a human is in
the page with you and the write arrived live in their editor. `updateFields`
works the same for frontmatter fields.

The blocks your last write touched are marked as yours for whoever has the page
open, for as long as you stay in the session (`OKB_AGENT_SESSION_IDLE_MS`, 3
minutes past your last call — a `waitForChanges` still running counts as one —
and never past the session's own `OKB_AGENT_SESSION_MAX_MS` age). It reserves
nothing.

`expect` is compare-and-swap over the block's content, and the reason to always
send it: if somebody edited the block between your read and your write, the
whole call is refused rather than overwriting them —
`{"ok":false,"conflicts":[{"index":0,"id":"b-…","expected":"…","version":"…","markdown":"…"}]}`.
Nothing is written, and each conflict carries the block's current markdown and
version, so the retry re-applies your edit to that markdown with that version
as the new `expect` — no second read needed. Omitting `expect` skips the
check and takes the last-writer-wins outcome.

**The whole-document write** — `PUT /api/kb/<space>/<slug>/draft.md` — is
**refused** on an existing page (`ok: false` — "an agent edits an existing
page block by block"): a replacement body would silently re-open every
block, including ones a reviewer signed off. Use `updateBlocks`. There is no
MCP tool for it. A *new* page comes from `tool_api__create_page`, which takes a
title and a space and no body — it returns the path it generated and the id of
the one placeholder block the page holds, which the first `updateBlocks`
replaces.

The body is comark markdown and nothing else: raw HTML is not part of the
format and is not preserved, so anything beyond CommonMark goes through the
components — `::callout`, `::infobox`, `::image` and `:doc`. The same holds
for `POST /api/agent/edit` and `PUT …/draft.md`.

## 5. Working beside a human

Everything above is an agent working alone. The loop below is the other case:
the page is open in somebody's browser, and the agent is a peer in the room
with them.

**commentOnBlock** — answer a thread, or open one:

```sh
… -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"commentOnBlock","arguments":{"path":"<space-slug>/<page-slug>","blockId":"b-…","threadId":"c-…","text":"Fixed the units."}}}'
```

Without `threadId` a new thread is opened on the block. The message is written
as the token's owner carrying the consumer's label — it reads "editor1 via
Claude" in Review, the way an agent commit reads in the history — and it
appears in the human's editor at once. There is **no way to resolve a thread**,
over this tool or any other: the editor who raised the point is the one who
decides it is settled.

**waitForChanges** — wait until the session moves:

```sh
… -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"waitForChanges","arguments":{"path":"<space-slug>/<page-slug>","cursor":"<from the last answer>","kinds":["comments","blocks","presence"],"timeoutSec":60}}}'
```

Waiting joins the page's editing session — that is where the events exist — so
it takes `agent_write`, not `agent_read`, and the tool is declared a write.

The request is held open until something happens, and answers
`{events, cursor, restarted, dropped, editors}`. Pass that `cursor` to the next
call and nothing is missed between two of them; without one the wait starts
from now. `kinds` narrows what wakes it (default: all three), `timeoutSec` is
capped at 120 and answers with no events when nothing happened. The events:

- `comments` — a thread was opened, answered or resolved. The whole thread
  comes with it, in the shape `getPageForEditing` serves, plus `by`, who this
  server saw cause it — a resolve carries no message, so the thread cannot say.
- `blocks` — `event: "settled"` is a block somebody stopped typing in:
  `blockId`, its new `version` (the `expect` an `updateBlocks` op sends back),
  its `markdown`, and `by`, who this server saw change it — null when more than
  one person wrote in the same quiet window. `event: "removed"` is a block that
  left the page, with `version` and `markdown` null; drop any `expect` you were
  holding for it. Never per keystroke.
- `presence` — somebody `joined`, `left` or `moved`: `who`, and the `blockId`
  they are in. This is what to check before writing — a block a human is
  sitting in is one to leave alone until they move on.
- `session` — the editors have left, or the document is gone. Terminal: end
  the loop.

**What you did yourself never comes back to you.** Your own presence, your own
`updateBlocks` and your own `commentOnBlock` are filtered out of the answer, so
a loop cannot re-trigger on its own echo. The same account editing in a browser
is not you — it carries no agent label — and does wake the wait.

`editors` is how many people have the page open, so a quiet page and an empty
one are different answers. `restarted` means the session was reloaded and the
cursor you sent names a log that is gone; `dropped` means more happened than
the log holds. Either way, re-read the page with `getPageForEditing` rather
than acting on the events you were handed.

**The loop end to end.** Draft the page with `updateBlocks`, then wait. A human
opens it, reads what you wrote and comments on a block; the wait answers with
the thread. Fix the block with `updateBlocks` (on the `version` the page
reports), say what you changed with `commentOnBlock` on that same thread, and
wait again. The human marks the thread done — that is theirs, and it is how you
learn the point is settled: the next `getPageForEditing` no longer lists it.
Your edits are flagged for review either way, so the page publishes only after
somebody has read them.

**How it ends.** The `session` event is the ordinary end: the last editor left
the page. Otherwise the loop ends when you decide it has — the work is done, or
whoever asked for it said to stop. Your own session is bounded regardless
(`OKB_AGENT_SESSION_IDLE_MS`, `OKB_AGENT_SESSION_MAX_MS`): a lapsed one is
re-opened, against a fresh gate, by the next call you make. A wait can end
without events before its `timeoutSec` is up, and you cannot tell a lapsed
session from a quiet page: call again either way, and that call re-joins the
page with a fresh seat.

**Where attribution shows up** (agent writes, whichever tool made them):

- The page's revision list (History): agent commits log as
  `OpenKB commit (agent) — editor1 via claude`.
- The blocks an agent changed are flagged for review; their contributor entry
  is the same `editor1 via claude` identity, and the review step requires a
  human sign-off before publish.
- The editor's presence strip shows the agent as a peer while it writes.
