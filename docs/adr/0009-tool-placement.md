# 0009 — Where agent tools live

Status: accepted (fago, 21.08.2026; tool config and MCP wire 24.08.2026;
delivery invariants 24.08.2026; tool layer and access timing 25.08.2026;
one declaration for both runtimes 26.08.2026); amended (fago,
08.09.2026; the chat relays the session tools 09.09.2026;
the chat's client ships as recipe content 15.09.2026
the chat asks what changed and is answered at once 15.09.2026)
)

## Context

- External agents (MCP) and the in-product chat call the same tools.
- Tool logic exists in two runtimes: Drupal owns the decisions (access,
  spaces, moderation) and the content of record; the frontend server
  hosts the live collaborative editing session.
- An MCP client registers against one server at a time. Every endpoint
  we advertise is another URL a person pastes and another OAuth approval
  they grant, so the count of advertised endpoints is a product
  constraint, not an implementation detail.

## Decision

- **A tool executes in Drupal unless it interacts with the live editing
  session.** Session-bound tools — editing, and reading the latest
  version for editing — execute in the frontend server; everything else
  executes in Drupal.
- **Every tool is declared in Drupal, whichever runtime executes it.**
  `plugin.manager.tool` is the one registry of the whole surface, so
  the two consumers can be checked against each other rather than
  against a list somebody keeps by hand. A tool Drupal cannot execute
  gets no `mcp_tool_config` entity — an agent reaches it on the
  frontend's own endpoint — and the chat reaches it by relaying the
  call there, so no consumer is ever offered a tool that can only fail.
- **A tool is authored once, as a Tool API (`drupal/tool`) plugin.**
  Its definition — name, description, input and output schemas,
  operation — sits next to its logic and reaches both consumers through
  a deriver: `mcp_server_tool_bridge` carries it to `/mcp`,
  `tool_ai_connector` carries it to the assistant. Neither consumer is
  written against a tool.
- **Each consumer configures its own tool set with the config its own
  stack ships.** MCP exposure is an `mcp_tool_config` entity, one per
  exposed tool, administered at
  `/admin/config/services/mcp-server/tools`; the chat picks from the
  derived function calls with drupal/ai's `ai_tools_library`. We add no
  tool config of our own. Each consumer also names a tool its own way:
  the bridge derives `tool_api__<mcp_tool_config id>` from the entity's
  machine name, the connector `tool__<tool id>` from the plugin — the
  one part of a definition that does not live beside the logic.
- **A session-bound call from the chat is relayed to the frontend.**
  Drupal holds the declaration and not the Y.Doc, so `SessionToolBase`
  posts a JSON-RPC `tools/call` to the frontend's `/api/mcp` with the
  inputs unchanged and answers with what the session said:
  `structuredContent` becomes the result, a refusal becomes a failed
  result in the session's own words, an unreachable frontend one saying
  so. No new Drupal route. This relay runs the opposite way to the
  frontend's own (below), which carries Drupal's tools out to agents.

  The credential is a five-minute token Drupal issues for the **chatting
  account**, on one consumer labelled "OpenKB AI" that
  `openkb_recipe_chat` ships as content (ADR 0015), carrying the scopes
  that consumer holds. The page and the revision log both name it
  "editor1 via OpenKB AI": the write is the person's, flagged for review
  the way an agent's is, and the frontend is handed nothing but that
  token. An administrator is refused, because their bypass would pass
  through the token and leave the scopes meaning nothing.
  `waitForChanges` is offered to the chat without a timeout input and
  the relay asks for an immediate answer, so the chat learns what has
  happened since its cursor without holding a request open; the long
  poll is the MCP surface's.
- **The wire between the runtimes is the MCP protocol itself.** Drupal
  serves its tools over `mcp_server` at `POST /mcp`; the frontend server
  is an MCP client against it and merges what `tools/list` reports into
  the listing it serves. `tools/list` is the manifest, `tools/call` is
  the call; there are no bespoke tool relay routes. A tool added in
  Drupal reaches agents with no frontend change. The session tools go
  the other way over the same protocol, and there the answer is JSON:
  `/api/mcp` is built with `enableJsonResponse`, and Drupal's relay
  reads the body with `json_decode` and reports an outage for anything
  it cannot read.
- **An agent is given exactly one endpoint: `<origin>/api/mcp`.**
  Drupal's `/mcp` is never advertised — it is reached server to server.
  Four invariants keep that single endpoint from becoming a place where
  logic, privilege or per-tool knowledge accumulates:
  1. **One registration URL, one OAuth approval.** `/api/mcp` is an
     OAuth resource server whose issuer is the openKB origin itself, and
     the Bearer it is called with is the one forwarded upstream. A
     second endpoint would cost a second registration and a second
     grant.
  2. **Zero per-tool frontend code.** The relay names no tool and knows
     no schema. A tool's name occurring in `frontend/` is the bug.
  3. **The middle holds no privilege.** The caller's own credential is
     forwarded verbatim; the frontend issues nothing and grants nothing.
     Each caller's listing is what that account may call, and each call
     executes as them.
  4. **The hot path never crosses runtimes.** Session-bound editing
     executes where the Y.Doc lives. What transits is Drupal-owned,
     low-frequency tools and the chat's own session calls, which go at
     typing speed. An unreachable Drupal is not a partial outage: the
     frontend's editing tools need Drupal too, for the join gate, so it
     costs the caller the whole tool surface. The
     product UI's own search is not a tool and fails closed on the
     same access map (`kb-search.ts`, ADR 0010).
- **The in-product chat is the second consumer of the same tools.**
  It runs inside Drupal and is an MCP client of nothing, so it reads
  the derived function calls in-process rather than over the wire — the
  `tool` function group, which is the Tool API surface and not whatever
  else drupal/ai derives. Every call executes as the chatting account.
- **Access control runs where the tool lives**, enforced per calling
  account — Drupal's decisions stay in Drupal; the frontend's
  session-bound tools enforce Drupal's answers (ADR 0004).
- **Access is enforced when a tool executes, not when it is listed.**
  A tool answers for the caller: it refuses the call, or it acts only
  on what that account may touch — `tool_api__create_page` writes only
  into a space the caller may write. Listing is not an access
  decision, so a caller may be offered a tool a given call of it will
  refuse. The
  trade is deliberate: the caller learns a tool exists, which leaks
  nothing (tool names are public API and the data behind them is
  gated), and costs one wasted round trip. What it buys is that no
  consumer has to re-implement a listing-time gate, which is the thing
  every tool layer we looked at declines to provide.
- A local tool wins over a relayed one of the same name.
- API-first when the product wants the same data: such a tool wraps a
  real API, and the API comes first. A tool that only packages agent
  ergonomics gets no API of its own.
- One file per tool, in either runtime.

## Open

- **One config for both consumers.** Each configures its own set with
  its own stack's config, so the sets can drift; a test holds them
  equal today.

## Consequences

- No consumer hardcodes a tool: what each runtime's `tools/list`
  carries is what agents are offered, and the chat offers what the same
  tools answer for the account chatting.
- The two consumers are configured separately, so their sets can drift.
  Holding them equal is a test, not a mechanism:
  `openkb/openkb_ai/tests/src/Kernel/ToolParityTest.php` compares both
  sets for one account, on the Tool API tool behind each wire name, and
  asserts the session tools as the chat's own: relayed from there, and
  off Drupal's endpoint, where an agent reaches them directly.
- `mcp_server` has no stateless mode, so reaching a Drupal tool costs a
  session handshake. The relay opens one only for a relayed `tools/call`
  or a listing its per-caller cache cannot answer, and closes it again
  (`docs/agent-access.md`); an editing call crosses no runtime at all.
  MCP's 2026-07-28 revision drops sessions entirely; adopting it shrinks
  the relay to a stateless forward
  ([OKB-176](https://drunomics.youtrack.cloud/issue/OKB-176)).
