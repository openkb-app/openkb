# Agent access

How an AI agent gets onto the knowledge base. Two ways in, sharing one MCP
endpoint (`POST /api/mcp` on the frontend) and one attribution path
(`openkb_agent` + `openkb_workflow`):

- **[Connect by URL](#connect-by-url)** — paste the MCP URL into a client and
  log in. The client registers itself; nothing is provisioned by hand. For a
  person connecting an interactive client. Needs `openkb_agent_registration`,
  which `openkb_recipe_agents` installs.
- **[A personal token](agent-tokens.md)** — provision a client on your profile
  and hold its secret. For a headless agent, which has no browser to log in
  with.

All URLs below are the local dev stack (`CLAUDE.md` "Bring it up"):
Drupal at `http://openkb-dev-project.localdev.space:8081`, frontend at
`http://node1.openkb-dev-project.localdev.space:8091`.

## The model

- **A token always acts as one human.** A provisioned client is bound to its
  owner; a client connected by URL acts as whoever logged in to authorize it,
  and belongs to them from that moment.
  Either way permissions are *that account ∩ the token's scopes*, recomputed
  on every request, so role and roster changes apply immediately.
- **A scope ceiling caps every token**, and it is config in
  `openkb_recipe_agents` — `simple_oauth_personal_consumers.settings` for
  provisioned clients, `openkb_agent_registration.settings` for self-registered
  ones.
  Both ship `agent:read` + `agent:write`. The ceiling only caps — the account
  still has to hold each permission itself.
- **No agent reads past the space rosters.** No scope names
  `bypass node access`, so an agent sees the spaces its owner sits on and the
  ones open to every signed-in account, whatever roles the owner holds —
  [ADR 0016](adr/0016-agents-hold-no-administrative-bypass.md).
- **Admin accounts are refused as owners** (uid 1 and any admin role), at
  provisioning and again on every request: an admin's access bypass would pass
  straight through the token and void the ceiling. This holds for both paths —
  an admin who connects a client by URL owns it from their first consent and is
  refused from the next request on. The gate keys on the *owner*, and a
  self-registered client has exactly one: an admin consenting first therefore
  refuses that client for everyone who connects it afterwards. Delete the
  consumer and let a non-admin register a fresh one. Use an editor account.
- Every agent write is attributed **"owner via client label"** server-side
  and lands as a *draft*; changed blocks are flagged for human review.
  Publishing stays a human decision. The owner's own surfaces name their agent
  by its bare label — a "claude" in a page they are reading is theirs — and
  everybody else reads "owner via claude". A comment is stored as it was typed,
  so a mention in one is named the same way at the time it is read: the owner's
  "@claude" is "@owner via claude" to everybody else, which is what the chip
  beside it says.

## Connect by URL

The client is handed one URL and finds the rest itself: it asks the MCP
endpoint, is refused with a pointer to this site's OAuth metadata, registers
itself, and opens a browser for the user to log in. What comes out is a token
that acts as **that person**, attributed "name via *the name they gave the
agent on the consent screen*".

```
http://node1.openkb-dev-project.localdev.space:8091/api/mcp
```

In Claude Code that is `claude mcp add --transport http openkb <url>` with no
`--header`; in a client with a connector UI, pasting the URL is the whole
setup. Both one-liners, and the URL for the site you are on, are on
**Agents & API clients** in the frontend's account menu — which is also where
the client shows up once you have approved it.

How it works in full — registration, the claim, and what ownership means —
is [Connect by URL: the lifecycle](connect-by-url.md).

The Drupal half — the registration bridge, the policy below and the cap it
holds a client to — is the `openkb_agent_registration` submodule, which
`openkb_recipe_agents` installs. A site whose agent tokens are all provisioned
by hand leaves it uninstalled: `/register` then answers `404` and only [a
personal token](agent-tokens.md) gets an agent onto the site.

### What a client walks through

| Step | Where | What |
|---|---|---|
| `POST /api/mcp` with no token | frontend | `401` + `WWW-Authenticate: Bearer resource_metadata="…"` |
| `GET /.well-known/oauth-protected-resource/api/mcp` | frontend | RFC 9728 — names the authorization server |
| `GET /.well-known/oauth-authorization-server` | frontend | RFC 8414 — token and keys on the **Drupal** origin, registration and authorization on the frontend |
| `POST /register` | frontend → Drupal | RFC 7591 — creates the client, returns its `client_id` |
| `/oauth/authorize` | frontend → Drupal | the consent screen, in openKB's own theme |
| `/oauth/token` | Drupal | stock simple_oauth, authorization code + PKCE S256 |

Walk it by hand with curl to see what a client sees:

```sh
curl -si -X POST http://node1.openkb-dev-project.localdev.space:8091/api/mcp \
  -H 'Content-Type: application/json' -d '{}' | grep -i www-authenticate
curl -s http://node1.openkb-dev-project.localdev.space:8091/.well-known/oauth-authorization-server | jq
```

### The consent screen

The one step a person sees runs on the frontend, so it looks like the rest of
openKB rather than like the Drupal backend. Nothing about the authorization
moves with it: the frontend renders a custom-elements variant of Drupal's own
`/oauth/authorize` route (`openkb_agent`) — the form, its CSRF token and its
Allow/Deny buttons are Drupal's, and the answer is an ordinary form POST, so
deciding works with JavaScript off.

The variant is a second route on that same path, reached by asking for the
`custom_elements` format; `/oauth/authorize` in HTML is stock simple_oauth,
untouched and still usable. Both carry the same access requirements.

The screen states what the request allows, in words about this site's content
rather than the permissions each scope caps, and where the browser is sent
afterwards. Its heading names the client as it is registered, minus the marking:
the screen is about the thing that asked. Where the agent is the visitor's own —
one person's agent credential, theirs or not yet anybody's — it also asks for
one thing: the **name of this agent**, whose description says whose behalf the
agent acts on and how its writes will read.

The name becomes how every page names the agent: attribution reads the label,
and standing assignments are keyed by it.

Allowing saves the field as the client's label — so a name its owner set or let
stand carries no `(unverified)` marking from then on, and attribution reads what
they chose. Anything else is only decided about, never named: a shared client an
administrator set up is nobody's own credential, so the screen does not ask the
visitor to name it; somebody else's agent carries the name they chose.

Arriving without a session lands on openKB's login page with a `destination`
back to the request. A client the person has already approved is answered with
the redirect straight away, and no screen is drawn.

### Pointed at the wrong path

`claude mcp add <url>` invites pasting the site origin, and one segment off is
the other common miss. The page catch-all answers an unauthenticated caller
with the HTML gate, which an MCP client can only report as
`CLIENT_HTTP_UNEXPECTED_CONTENT`, naming neither the cause nor the endpoint.

| Request | Answer |
|---|---|
| `/mcp`, `/mcp/`, any casing | `308` to `/api/mcp`, method intact — the client follows it and discovery engages at the target |
| `POST /`, accepting `application/json` **and** `text/event-stream` | JSON `404`: `error_description` offers `/api/mcp`, `mcp_endpoint` is the absolute URL |
| `GET /.well-known/oauth-protected-resource` | the RFC 9728 document, same content as the path-suffixed form a client derives from `/api/mcp` |

Both answers are chosen on `Accept` (`server/middleware/mcp-wrong-path.ts`), so
anything that can render HTML reaches the page it asked for. At the site root
the answer is narrower still: both wire types together, so an ordinary JSON API
caller is left alone. `/mcp` is broad in the other direction — the path has
already said which protocol it wants, so `terminateSession()`, which sends no
`Accept` at all, is sent on too.

### What a self-registered client gets

- **The same ceiling as a provisioned client**: `agent:read` + `agent:write`,
  so a person connecting a chat client can actually work in it. Both metadata
  documents advertise it as `scopes_supported`, straight from
  `openkb_agent_registration.settings`, so a client asks for what it can have.
  Narrow that setting (pinned by `openkb_recipe_agents`) for a site that wants
  read-only clients.
- **Asking beyond the ceiling is refused, never narrowed** — at registration
  (`invalid_client_metadata`, naming what the site does grant) and again at
  the **token endpoint** (`invalid_scope`) — that is where league settles the
  scopes of an authorization code, so no token is ever issued beyond the
  ceiling even though the consent screen came first. A client always holds
  exactly what it asked for, instead of discovering the difference by being
  denied later. A registration naming no scope at all gets the ceiling: that is
  a client saying "whatever you allow".
- **A public client**: no secret is issued, PKCE S256 is required, and the
  user sees the consent screen naming the client the first time.
- **Marked as unverified** in its label at registration, so every surface that
  shows one says so — revision log, block contributors, the presence strip.
  The marking is the site's word about a name nobody vouched for, and it is
  dropped the moment its owner names the agent on the consent screen.
- **Owned by whoever connected it**: at registration nobody owns it; the first
  person to authorize it becomes its owner, and from then on it lists on their
  **Agents & API clients** page (`/user/<uid>/api-clients`), revocable there
  like a client they provisioned by hand.

Consenting needs the `grant simple_oauth codes` permission, which
`openkb_recipe_agents` grants to `authenticated` — without it the grant screen
refuses the submit and no client can be connected at all. It authorizes nothing
by itself: what the client ends up able to do is still that person's own
access, capped by the ceiling.

The bridge Drupal exposes is reachable only by the frontend server, which
reaches it under the collaboration server's own OAuth client (ADR 0001) and is
the one account holding `use client registration api`. Without that client
configured the relay answers `temporarily_unavailable` and never reaches
Drupal.

## Where the tools come from

The endpoint an agent talks to is the frontend's, and it serves tools from two
runtimes (ADR 0009). Session-bound work — `getPageForEditing`, `updateBlocks`,
`updateFields`, `commentOnBlock` and `waitForChanges` — runs in the Nitro
server, inside the page's live collaborative session; `getPageForEditing` is
the read that belongs to it, because the working copy is behind the document
while anybody has the page open, and `waitForChanges` is derived from that
document while it moves. Reading the *published* page is `tool_api__get_page`,
and it is Drupal's. Everything else is Drupal's too, and Drupal serves it over
**its own MCP endpoint** (`POST /mcp`, `drupal/mcp_server`); the frontend is an
MCP client against it and merges what `tools/list` reports into its own listing.

The relay is generic: it never learns a tool's name, so a tool added in Drupal
appears to agents with no frontend change. Every request it makes carries the
caller's own credential, so the listing is what *that* account may call and
every call executes as them. A local tool of the same name wins. A Drupal that
is unreachable or has the module switched off costs the caller the Drupal tools
and nothing else.

A session is opened only when there is something to say on it — a relayed
`tools/call`, or a listing the cache cannot answer — and closed again with an
HTTP `DELETE` when there is not. An editing call therefore reaches Drupal's MCP
endpoint zero times. The listing is cached for 30 s **per caller**, keyed on a
hash of the credential: it is access-filtered, so one key per account is what
keeps one caller's tools out of another's manifest. `tools/call` is never
cached. Connect and list are capped at 2.5 s, so a hung Drupal costs the
relayed tools rather than the request.

Access is per tool and per account, and what makes a call safe is that the
tool answers for its caller (ADR 0009). It is enforced when the tool executes,
not when it is listed: every tool is advertised to every caller that reaches
the endpoint, and one the caller may not use answers `isError: true` carrying
its own refusal. A denied call therefore costs one round trip and tells the
caller the tool exists — which leaks nothing, since tool names are public API
and the data behind them is gated.

Drupal's tools are Tool API plugins, carried to `/mcp` by
`mcp_server_tool_bridge`. Each one that reaches the endpoint has an enabled
`mcp_server_tool_bridge.mcp_tool_config` entity naming it, and takes its wire
name from that entity's id: `tool_api__list_spaces`, `tool_api__create_page`.
The entities the product ships are created by `openkb_recipe_agents`; a site
switches one off at `/admin/config/services/mcp-server/tools`.

`tool_api__list_spaces` is the first Drupal tool: where this account may work,
and at what level. It wraps `GET /openkb/spaces` through the same service, so
the tool and the API cannot disagree (`docs/space-access.md`).

Finding a page splits in two, along what is published. `tool_api__search_pages`
searches the chunk index, which holds published default revisions: a hit is one
section, with the block it opens on and a path anchored there — which every
page tool takes as it comes. Work in progress is not in it — a page nobody
published, and a draft written on top of a published page — so
`tool_api__find_drafts` asks storage instead: the newest
revision of each page, matched on its own title, gated per hit on `update`
so it answers only pages the caller may edit.

Work is handed over by assigning a comment thread, and a thread is assigned to
`{uid, via}` — the account and the client's label. An agent is therefore
addressable while it is away: the picker offers the reader's own clients
(`/openkb/me/agents`, which answers the caller's labelled, unrevoked clients)
alongside the peers in the page, and the thread waits. The picker never offers
the reader themself — a thread is handed to somebody else — and the drawer
lists what the reader was handed under **Assigned to me** apart from what their
agents were handed, under **Assigned to my agents**: work an agent holds is
work the reader is not doing. `tool_api__list_assignments`
is what the agent asks on its next connection: the open threads assigned to the
calling identity, across the pages it may edit, each with the path, the block,
the thread id and what was last said. A thread whose latest message is the
caller's own is answered and not listed; a reply from somebody else lists it
again. `waitForChanges` reports the ones opened while it is watching; this one
answers the standing ones.

## Scopes

Both umbrellas are the shipped ceiling, for provisioned and self-registered
clients alike. Each child *names* one permission; the ceiling only caps — the
account must hold each permission itself. What makes that an intersection
rather than a grant is that every agent token carries its owner
(`auth_user_id`): simple_oauth answers such a token with the owner's calculated
permissions ∩ the scopes' permissions. A token that carried no owner would get
the scopes' permissions outright, so the stamp is the ceiling
(`AgentTokenOwnerCeilingTest`).

| Scope | Names |
|---|---|
| `agent:read` | umbrella — reading published content |
| `agent:read:content` | `access content` |
| `agent:read:space` | `view space content` — without it, nothing inside any space is readable |
| `agent:read:mcp` | `access mcp server` — without it, Drupal's own MCP endpoint refuses the token, and the tools it serves are missing from the frontend's listing |
| `agent:write` | umbrella — the collab-commit write ceiling |
| `agent:write:content` | `edit any kb_page content` |
| `agent:write:space` | `update space content` |
| `agent:write:draft` | `use editorial transition create_new_draft` — without it, moderation refuses every update |
| `agent:write:format` | `use text format comark` — a write that hands in a body value alone validates with the format unset and does not need this; a write that leaves the stored body in place (a JSON:API PATCH of the frontmatter or title) validates the format it already carries, and 422s without it |
| `agent:write:latest` | `view latest version` |
| `agent:write:revisions` | `view kb_page revisions` |
| `agent:write:unpublished:any` | `view any unpublished content` |

The three `latest`/`revisions`/`unpublished` scopes are what let an agent
read back and build on its own earlier draft; without them only the first
write on a published page succeeds.

Space access stacks on top: the token sees and writes exactly the spaces its
owner's roster rank allows (`docs/space-access.md`). A read-only agent is a
client whose owner lacks the write permissions — the ceiling never adds any.
