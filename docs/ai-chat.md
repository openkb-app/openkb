# AI chat: setup and providers

How the chat surface is wired, and what an operator does to point it at a real
LLM provider.

## The pieces

`recipes/openkb_recipe_chat` installs and wires everything:

| Module | Role |
|---|---|
| `ai` | Provider abstraction. Site-wide defaults at `/admin/config/ai/settings`. |
| `key` | Stores API keys. Providers reference a key entity by id. |
| `ai_assistant_api` | The `ai_assistant` config entity type — prompt + provider + model. |
| `ai_test` | Ships `echoai`, a keyless provider that echoes the input back. |
| `ai_provider_openai` | OpenAI. Needs a key. |
| `ai_provider_amazeeio` | amazee.ai. Needs a key. |
| `vercel_ai_sdk` | `POST /vercel-ai/chat`, streaming the AI-SDK UI-message protocol from a `ChatProcessor` plugin. |
| `ai_rag_cite` | Grounding: retrieves before the model answers, hands it a numbered source list to cite, and publishes what the answer cited. |
| `openkb_ai` | Ships the `openkb` assistant — the system prompt, its comark/MDC formatting contract, and its grounding settings. |
| `tool_ai_connector` | Derives one drupal/ai function call per Tool API tool. Those are the chat's tools, shared with Drupal's MCP endpoint (ADR 0009). |

Request path:

```
frontend/app  →  POST /api/chat              (Nuxt, frontend/server/api/chat.post.ts)
              →  POST /vercel-ai/chat        (Drupal, session cookie forwarded)
              →  `vercel_ai_sdk` ChatProcessor → drupal/ai provider → SSE back out
```

The Nuxt proxy picks the assistant id from the request body, else
`runtimeConfig.public.chatAgentId`, else `openkb`. Every request carries an
`agentId`; `vercel_ai_sdk` ships no assistants of its own.

## The assistant decides the provider

The processor reads `llm_provider` / `llm_model` off the `openkb` assistant
entity. `ai.settings: default_providers.chat` is consulted
in exactly one case: when the assistant's provider is `__default__` (the
"Default" option in the assistant form). Any other selection wins over the
site-wide default.

So: change the provider at `/admin/config/ai/ai-assistant/openkb`, not at
`/admin/config/ai/settings` — unless the assistant is set to "Default", in
which case the site setting is the one that matters.

## Configuring a real provider

An environment that answers from the mock — every review app and local stack
does — takes these steps to answer from OpenAI instead, and none of them is a
deploy:

0. **Get into Drupal.** On a review app the two hosts are printed by the
   build's `env-urls` stage: the frontend and the Drupal one, which is the
   same host without the `node1_` prefix. `/user/login` on the Drupal host
   sends a signed-in reader to the frontend, so ask for the admin directly:
   `https://<drupal-host>/user/login?destination=/admin`, as `admin`. Send no
   HTTP Basic credentials with it — `basic_auth` is enabled, so the header is
   read as a Drupal login and every page answers 403. These hosts need none.
1. **Point the assistant at OpenAI.** `/admin/config/ai/ai-assistant/openkb` →
   *AI Provider*, then *Model*, then save. On an environment that carries a key
   (below) this is the only step: the key entity and the provider's *API Key*
   setting are shipped by the recipe. The **model** select stays empty until a
   key is readable, because the model list is fetched from the provider's API —
   an empty one says the environment has no key.
2. **That is the switch.** On a development or CI environment the assistant was
   pointed at `mock` by `openkb_recipe_chat_mock`; step 1 is what takes it off.
   Nothing has to be uninstalled, and there is no mode meaning "use the real
   one" — the assistant decides who answers.
3. **Test.** `/admin/config/ai/explorers/chat_generator` proves the key
   answers at all, and it reaches a provider without going through the
   assistant — so it is also the way to try OpenAI on an environment whose
   chat should stay on the mock. Then ask the chat something the knowledge
   base covers and something it does not — a grounded answer cites its
   sources, an unanswerable one says so (see *Grounding*).
4. **Point it back at `mock`.** The e2e suite on a review app assumes the mock
   and reds against a real provider, so leaving the assistant on OpenAI breaks
   the next build on that environment. A reinstall does this by itself.

A review app is the one place the whole retrieval arc can be seen as a reader
gets it: it embeds through OpenAI (`openkb_recipe_ci` puts the engine back,
and the vector floor measured on it), so the sections a question retrieves are
ranked by meaning as well as by the words they share.
Ask it something the knowledge base covers — the answer carries inline `[n]`
chips and a Sources list, each a link ending in `#b-…`, and following one opens
the page scrolled to that block with the block marked on arrival. Ask it
something the knowledge base does not cover and it says so and cites nothing.

### Where the key comes from

The key is read from the `OPENAI_API_KEY` environment variable, so it is never
entered on a site, never in config, never in the database and never in a dotenv
file:

| Piece | Where |
|---|---|
| The variable | Handed to the `drupal` and `cli` containers by `docker-compose.yml`. Empty where the environment sets none. |
| The key entity | `key.key.openai_env` (`openkb/openkb_ai/config/install/`), Key module's *Environment* provider pointed at `OPENAI_API_KEY`. |
| The provider setting | `ai_provider_openai.settings: api_key: openai_env`, set by `openkb_recipe_chat`. |
| On CI | The Jenkins secret-text credential `openkb-openai-api-key`, bound in the `Jenkinsfile` environment block and so present in every container the build starts. |
| Locally | `OPENAI_API_KEY=sk-… docker compose up -d`, or the variable exported before the stack starts. |

An environment with no variable behaves as an unkeyed one always did: the
provider is selectable, the model list is empty, and a chat pointed at it
answers its `error_message`.

amazee.ai keeps the by-hand path — its two key entities use the Key module's
*Configuration* provider, so a key is pasted at
`/admin/config/system/keys` and picked at `/admin/config/ai/providers/amazeeio`.

`echoai` stays the *site-wide* default provider (`ai.settings`) on every
environment, mock or not, for AI operations that name none of their own; the
chat does not use it, because the bridge reads the provider off the assistant.
It is a test provider: it echoes the prompt, it does not reason.

`ai_api_explorer` ships enabled on every install, so `/admin/config/ai/explorers`
is a per-operation test form that reaches a provider without going through the
assistant or the chat panel. Its `access ai prompt` permission needs no grant:
`administrator` is an is_admin role and holds every permission. It stores no
config of its own — each form starts from the site-wide default provider — so
there is nothing to pre-configure.

## Tools

The chat calls the same tools external agents reach over Drupal's `/mcp`
(ADR 0009) — they are Tool API plugins, and there is no second place to author
one. Each consumer reaches them through its own deriver, so each names them its
own way: `mcp_server_tool_bridge` advertises `tool_api__<mcp_tool_config id>`
on the endpoint, `tool_ai_connector` offers `tool__<tool id>` to the model.
`ChatToolRegistry` reads the latter — the `tool` function group, and nothing
else the function call manager serves. A call executes in-process as the
chatting account, so the chat can reach nothing the person could not have
reached themselves. Access is enforced when the tool executes: a tool the
account may not call is offered all the same and answers its own refusal, which
the model gets as the tool result.

The processor gives a turn up to three tool rounds, feeding each result back as
a `tool` message before asking again; the last round is asked without tools, so
a model that keeps calling has to answer from what it has. Its `tools`
configuration can narrow the offer, picked with drupal/ai's `ai_tools_library`
element; left empty, a turn offers every Tool API tool.

Nothing in the wiring names a tool: a tool added to the site appears in chat
with no further change. The two consumers are configured separately, so their
sets can drift — `openkb/openkb_ai/tests/src/Kernel/ToolParityTest.php` asserts
they have not.

## Editing from the chat

The chat reads the published knowledge base with `tool__openkb_search_pages`
and `tool__openkb_get_page`; `tool__openkb_find_drafts` names the pages the
chatter may edit that carry unfinished work — title, path and state, never
draft content. `tool__openkb_list_assignments` answers the comment threads
assigned to the identity asking; the chat asks as its own client
("OpenKB AI"). The assignee picker offers that client under "Agents here"
while the chat edits the page; a thread handed to it then is listed by
`tool__openkb_list_assignments` until the chat has replied. It works on the
page somebody has open with five session tools:
`tool__openkb_get_page_for_editing`, `tool__openkb_update_blocks`,
`tool__openkb_update_fields`, `tool__openkb_comment_on_block` and
`tool__openkb_wait_for_changes`. Those run in the frontend's collaborative
session, which Drupal cannot reach, so Drupal relays — `SessionToolBase` posts
a JSON-RPC `tools/call` to the frontend's `/api/mcp` and answers with what the
session said (ADR 0009). There is no Drupal route for it, and one tool
declaration serves both directions.

**Asking what changed.** `tool__openkb_wait_for_changes` tells the chat what
has happened in the page since it last asked, and answers at once — the
declaration the chat reads has no `timeoutSec` input, and `WaitForChanges`
relays `timeoutSec: 0` through the `sessionToolArguments()` seam
`SessionToolBase` provides, so no chat turn can hold a request open. The first
call only marks the point in time and reports nothing; each answer carries the
`cursor` the next call resumes from. Events are only collected while somebody
is watching the page, so a page nobody has open reports nothing, no matter what
happened on it earlier; `editors` is how many people have it open, which keeps
"nobody is here" and "nothing has happened" apart. The cursor lives as long as
the turn: within one turn the tool result is in the messages the provider is
sent, and the next turn starts from now again. The MCP tool of the same name is
the long poll (default 30 s, max 120 s), which is an agent's loop.

**Identity.** Drupal is the OAuth server, so it issues the credential itself: a
five-minute token for the **chatting account**, carrying the scopes the
*OpenKB AI* client holds — `agent_read` and `agent_write` as shipped.
Attribution reads "editor1 via OpenKB AI" wherever it shows — the revision log,
the block byline, the presence strip — the same for every reader. Every block
the chat rewrites is flagged for review, so a person signs it off before the
page publishes. An agent scope on the token is what makes the write an agent's
(ADR 0015), so narrowing the client's *Scopes* narrows every token issued on
it. simple_oauth answers such a token with owner ∩ scopes, so an editor reaches
nothing they could not reach themselves; whether they may edit *this* page is
the session's own answer.

An **administrator is refused** and the chat says so, because an admin's bypass
passes through an agent token and the ceiling would mean nothing. Edit from an
editor account.

The client is a content entity, so it ships as recipe content:
`recipes/openkb_recipe_chat/content/consumer/` (ADR 0015). It is one
system-wide client, not a person's own — nobody owns it, and the
unclaimed-consumer sweep only takes personal ones. Its `refresh_token` grant
needs a refresh token nothing issues here, so Drupal's own issuance is the only
way to a token on it. An existing site receives the client on its next
`phapp update`, which re-applies the recipe. Without the client the tools say
the site has none, and edit nothing.

**Where the frontend is.** `openkb_tools.settings: session_endpoint` names the
URL, server to server. `openkb_recipe_ci` sets it to `http://frontend:3000/api/mcp`,
the in-network origin, because the call carries `Authorization: Bearer` and CI
fronts the public host with HTTP Basic auth, whose own Authorization header
would collide. Left empty everywhere else, the relay falls back to the
configured frontend base URL, which is right for a deployment with no separate
internal origin.

**The loop.** A reader has `team-wiki/getting-started` open and asks the chat
to shorten the second paragraph. The turn carries the path they are on, so the
assistant calls `tool__openkb_get_page_for_editing` on it, finds the block, and
calls `tool__openkb_update_blocks` with that block's `expect` version. The edit
arrives in the editor live — it is the same session — and the block sits
flagged for agent review until somebody signs it off. A refusal (a stale
`expect`, a page the account may not edit) comes back as the tool's own failed
result in the session's words, so the assistant can retry or say what stopped
it. A 4xx from the frontend is such an answer too; only a transport failure or
a 5xx reads as "could not be reached".

**The caller context.** The chat sends `{"context": {…}}` with every turn.
The bridge hands it to the retriever — the one channel a per-turn choice has
into what is retrieved — and appends the page context to the system prompt, so
the model is told the page the reader has open and the space that page lives
in. Three keys come from the panel:

| Key | What |
|---|---|
| `path` | The page the reader has open. The session tools' `path` input says so, which is how "shorten the second paragraph of this page" resolves to a path the reader never typed. |
| `space` | The slug of the space that page lives in. |
| `scope` | What the scope picker holds: `all`, or one space's slug. The picker is the space menu the sidebar switcher uses — searched by typing, one row per space with its colour mark — and the pill it hangs off keeps the name short, with the full one on hover. It is picked for a conversation and goes back to `all` when that conversation is cleared. |

How the two space keys narrow retrieval is *Grounding*, below.

## Grounding

The `openkb` assistant answers from the knowledge base; what it does with a
question the knowledge base does not answer is its mode, below.
`ai_rag_cite` subscribes to drupal/ai's provider events, scoped to the
assistant by the tag the bridge marks every call with:

1. **Before the model runs**, the turn's first round retrieves through
   `openkb_search`'s chunk retrieval — the same read path the `search_pages`
   tool runs on, so the index's space filter decides what the account may be
   answered (ADR 0010). The turn's own scope narrows that read: a `scope`
   naming a space answers from that space alone, and `all` — the default —
   answers from every space the account may read, with the sections of the open
   page's `space` lifted 15% in the ranking so a local answer wins and a
   cross-space one stays reachable. On the band the index scores in that is
   enough to put a clearly weaker local section ahead of a stronger one from
   another space, and the gate below cuts the order the lift leaves, so it
   decides which sources ground the answer. What a section is offered with is
   still the score the index gave it, and what it reorders is the `top_k`
   window: a local section the index left outside that window is not reached.
   The question is embedded and the nearest sections of the `kb_chunks` index
   answer it, beside the sections that hold its words. Hits under the query's
   vector floor are dropped, and at most `max_per_entity` sections of one page
   are read. Each surviving section is a numbered source of its own, numbered
   in the order the ranking leaves them and cited at the block it opens on,
   placed by the headings above it. What survives is appended to the
   assistant's system prompt as a numbered `Sources:` list under the citation
   contract.
2. **What happens when nothing survives is the assistant's mode**, set under
   Grounding on its form and shipped as `grounded`:
   - **Grounded** — answers always come; ones without sources are marked "not
     from your knowledge base". The model is told that nothing was found and
     gets no sources to cite, and the turn ends as `ungrounded`.
   - **Strict** — when nothing in the readable pages supports an answer, the
     assistant says so and does not ask the model. The configured no-answer
     message is returned as `insufficient_evidence`, so an unanswerable
     question costs no tokens and cannot be argued into an answer.

   A retriever that cannot be reached is `dependency_unavailable` in both
   modes: an outage is not an empty knowledge base.
3. **After the answer**, only the sources it marked with their `[n]` are
   published; a source the answer never cited is dropped. Numbers are left as
   written — a streamed answer is already read by the time this runs.

The result reaches the client as UI-message data parts: `data-citations`
(`{n, title, path, meta, score}` per cited source, `path` anchored on the
cited block and `meta` the heading path) and `data-grounding`
(`{mode, state, retrieved}`, state one of `grounded`, `ungrounded`,
`insufficient_evidence`, `dependency_unavailable`). The bridge names no key —
it forwards whatever the response carries as `data-<key>`.

Every cited section anchors, and the lead section anchors on the page title:
a citation chip is a link to `path#block_id`, and following it marks the block
it landed on.

`retrieved` is how many sources the answer was offered, which is what separates
the two ungrounded answers on screen: an answer that left found pages uncited
is badged, and one whose question matched no page the reader can read carries
the badge plus what was searched and the three ways on — ask in other words,
search the pages yourself, write the page.

Settings live on the assistant, under Grounding on its edit form
(`/admin/config/ai/ai-assistants`), and ship with it in
`openkb/openkb_ai/config/install/ai_assistant_api.ai_assistant.openkb.yml`.
Retrieval is a `Retriever` plugin. The assistant runs `ai_search_chunks`
(`openkb_search`) over the chunk index; `search_api_index`, which reads a
lexical index and cites whole pages, is the other one shipped, so which of the
two grounds an answer is a settings change. The score gate is off on the chunk
index: that index is searched by one hybrid query whose two score lists a
search pipeline normalises against each other, so the number a passage carries
here ranks it and measures nothing. The gate sits in the query instead, on its
vector clause, as `openkb_search.settings`' `vector_floor` — one number for
the chat and the `search_pages` tool alike, on the embedding engine's scale,
which is why a keyless stack carries its own: `openkb_recipe_embeddings_mock`
sets 0.65 with the engine it selects and `openkb_recipe_ci` puts it back.

## Where the chat and the summary show

Both render in the side pane from `lg` up (`useSidePane`):

- **The chat** stays open across pages until the reader closes it, so a
  citation or link followed from it opens the page beside it. Below `lg` it is
  a drawer over the page, and a citation hides it — the conversation is kept,
  and the launcher shows it again. The X ends the conversation: it drops the
  thread and the half-typed question, so the next open is an empty chat.
- **The search summary** belongs to the search page: it shows with a query and
  is gone once the reader leaves the search. An open chat covers it; closing
  the chat shows it again. Only the review surface parks an open chat.

Citations in either answer are links: an `[n]` chip and a Sources row both
navigate client-side to the cited page.

## Components in an answer

An answer is comark markdown, and the components in it render as the components
the read view mounts. Both chat surfaces — the chat panel and the search page's AI summary —
feed the accumulated text to `ComarkAnswer`, which runs the shared tree passes
(`frontend/shared/utils/comark-tree.ts`) and mounts the tree with
`@comark/vue`'s `<MarkdownDocument>` under the shared component map
(`frontend/app/comark/components.ts`). One set of passes, one component set: a
`::callout` in an answer is the same `CustomCallout` a published page gets.

The component set is whatever the read view has — `callout`, `infobox`,
`image` today, plus the inline ones a paragraph can hold (`:doc[…]{nid}`,
`:citation{nid block v}`, an inline `:image{}`), which mount the same way
(ADR 0012). A fence naming
anything else falls back to `CustomDefault`, which renders the words inside it
as prose. `script`, `style`, `template`, `iframe`, `object` and `embed` are
dropped instead: comark parses raw HTML of those tags as components too, and
their source is not prose. The assistant's system prompt
(`openkb/openkb_ai/config/install/ai_assistant_api.ai_assistant.openkb.yml`)
names `callout` and `infobox` only — nothing stops it from naming another.

One thing the chat does not have yet is document resolution: a `:doc[…]{nid}`
in an answer renders the author's stored label and `/node/<nid>`, never the
target's live title or its alias. The read path resolves nids on the server
(`resolveDocNids`); the chat renders in the browser, so it needs a route of its
own — an API surface, still to be decided.

`::image{media="…"}` resolves its UUID through `/api/media/resolve`, the same
route the editor's ImageNodeView uses, so an answer quoting an embed the reader
may not see renders the placeholder.

**Streaming.** The text is re-walked on every delta and the result is
sequence-guarded, so a slow parse of an earlier chunk cannot overwrite a newer
one. comark auto-closes an open construct, so a fence that is still streaming is
already the mounted component — a half-written `::callout` never flashes its raw
`::` at the reader.

**What the browser pays.** The rule: parse in the browser with comark, mount
the tree with `@comark/vue`. The client ships the parser and the tree renderer
only — the string renderer (`comark/render`) has no client-side job.
`frontend/test/ci/comark-client-bundle.test.ts` pins that.

The page body runs no parse of its own: the server parses it and ships the
tree on `content.props.bodyTree`, which the same `<MarkdownDocument>` mounts. So
the parser is a chat cost, and `markdownToTree` reaches it through a dynamic
`import('comark')` — its own chunk, fetched when a chat or search answer first
arrives (~250 KB raw / ~99 KB gzip) and never by a read page.

## Streaming requirements

A turn is served as `text/event-stream` and must reach the browser frame by
frame. Every hop is a place that can hold frames back, so each one carries a
rule:

| Hop | What it must not do |
|---|---|
| `ChatController` | Return the answer as a string. It streams a generator and flushes each frame; PHP output buffering is unwound first. |
| FrankenPHP (Caddy with PHP embedded) | Hold frames back. `docker/drupal/Caddyfile` runs `encode zstd br gzip`, whose default matcher covers `text/*`, so an encoded stream has to flush per frame too. |
| Traefik | Buffer the response. No buffering middleware is configured on either router. |
| `frontend/server/api/chat.post.ts` | Read the upstream body whole. It pipes `res.body` straight out and mirrors the SSE headers. |
| ci2 ingress | Coalesce frames on the way to a review app. It hands them to the Nuxt server as they arrive. |

None of them buffers today. `tests/playwright/tests/chat-streaming.spec.ts`
samples the chat's answer while the stream is open and fails unless the text
grew at least twice; a hop that starts buffering makes the answer arrive as one
block, which leaves a single sample.

Proving it needs a stream that takes time. The mock answers in one PHP tick
otherwise, which no observer can tell from a buffered stack, so it is paced:

- `vercel_ai_sdk_mock.settings` `delay_ms` — pause between frames, in
  milliseconds, for the site. It ships at 40, so any chat turn on a review app
  streams visibly.
- `mock.delay_ms` in the request's caller context — the same pause for one
  answer, and it wins over the setting. Capped at 100 ms, because that number
  comes from the request. The streaming spec sets it, so its alarm holds
  whatever an environment sets.

Both need the assistant pointed at `mock`; a real provider paces itself.

A `scripted` call also answers whatever the caller put under `mock` in that
context — the text, and the metadata the bridge publishes as `data-<key>`
parts:

```json
"context": {"mock": {
  "text": "Cut the tag [1], then deploy [2].",
  "metadata": {"citations": [], "grounding": {"mode": "grounded", "state": "grounded"}}
}}
```

Nothing about grounding lives in the provider or the bridge — the caller names
it, and `chat-grounding-states.spec.ts` drives every state that way. A browser
has a composer and nothing else, so the spec adds the context to the page's own
request (`tests/playwright/helpers/mock-chat.ts`) rather than the app carrying a
hook no reader would use. A script that names no `text` keeps the canned answer,
which echoes the prompt and cites `[1]`–`[3]` (`openkb_recipe_chat_mock`), so
an unscripted turn shows as many citations as it retrieved pages, up to three.

The rest of the caller context is appended to the system prompt for the model to
reason over; `mock` is not, because it addresses one provider rather than the
model (`UiMessage::PROVIDER_KEYS`). So a page that scripts the mock and is then
pointed at OpenAI does not paste its script into a real prompt. `scope` is the
other exception (`UiMessage::RETRIEVER_KEYS`): it is the width the retriever
narrows to, not something asked, and a model shown a bare space name reads it as
a topic.

To watch it by hand on a review app, send a prompt with a comark component in
it — the canned answer echoes the prompt as its own block, so

```
::callout{type="warning"}
Watch this arrive.
::
```

comes back as the mounted `CustomCallout`, built up in place across the frames:
the prose grows, and the fence never flashes its raw `::`. The streaming spec
sends the same fence, paced at 60 ms.

## Failure shapes

| Symptom | Cause |
|---|---|
| `503` from `/vercel-ai/chat`, `ChatUnavailableException` in the log | No assistant with that id. Chat is dead — there is no fallback to echo. |
| Stream carries `{"type":"error"}`; log says "Could not load the OpenAI API key" | Provider selected, no `OPENAI_API_KEY` in the container. This is the *correct* signal that the switch took effect: the chat renders the assistant's `error_message` and a *Try again*. |
| Model select on the assistant or provider form stays empty | Same cause: the list is fetched from the provider, which needs the key. Check the variable reached the container — `docker compose exec drupal printenv OPENAI_API_KEY`. |
| `AI Assistant has no provider/model configured` | Assistant set to "Default" and `ai.settings: default_providers.chat` is empty. |
| Chat answers "Hello world! Input: …" | Still on `echoai`. |
| The chat panel or the search page's AI summary shows one plain sentence and a *Try again* | `/api/chat` itself did not answer (proxy or Drupal). The response body is never shown; a `401` renders the log-in state instead. |

The reasoning chunk of every turn names the provider and model it used
(`Asking openai (gpt-4o)…`) — the quickest way to see which one is live.

## Config in the recipe

A recipe installs its modules **as syncing**, and Drupal skips a module's
`config/install` *config entities* while syncing (simple config still lands).
Every config entity the chat surface needs is therefore named in the recipe's
`config: import:` — the `openkb` assistant, the env-backed `openai_env` key,
and the amazee.ai key entities.
`openkb/openkb_ai/tests/src/Kernel/ChatRecipeTest.php` applies the recipe and
asserts they exist.

## The chat recipes

`openkb_recipe_chat` is the real chat: the bridge, the `openkb` assistant
pointed at OpenAI, the OpenAI and amazee.ai provider modules, the API Explorer.
It is what a production install applies. It ships no key value, only the
`openai_env` key entity that reads one from the environment — so on an
environment that exports none, its chat answers the in-band `error` part, which
is the documented shape for a provider that cannot be reached.

`openkb_recipe_chat_mock` sits on top and is what makes an environment answer
without a key: it installs `vercel_ai_sdk_mock`, whose `mock` provider needs
none, and points the assistant at it — the assistant only, so the site-wide
default is the same `echoai` a real install has. `openkb_recipe_dev` carries it,
and `scripts/site-install.sh` applies that on every environment whose
`PHAPP_ENV_MODE` is not `production`, so CI and every local stack answer from
the mock and the e2e specs never touch a real provider.
The mock replaces the model call and nothing else — the tool rounds and the
grounding above still run, which is what lets an end-to-end run assert on them.

`openkb_recipe_ai_logging` is CI-only, carried by `openkb_recipe_ci`:
`ai_logging` stores every prompt and response as entities, readable at
`/admin/config/ai/logging`. That is a lot of database and a developer's tool,
not a production one. The same recipe points the relay at the in-network
origin.

Switching an environment onto a real provider is a change on the assistant, not
a recipe: point it at OpenAI, and back at `mock` when you are done. The modes
and the scripting context are in
`web/modules/custom/vercel_ai_sdk/tests/modules/vercel_ai_sdk_mock/README.md`.
