# Space access

Who may read and write what in OpenKB. Enforced by
`openkb/openkb_space_access`; the product model is Confluence's.

## The model

A **space** is an `openkb_space` entity (`openkb/openkb_space`). Every
`kb_page` carries exactly one (`field_space`, required), which makes the
space the only access boundary in the system.

A space's roster is three ranks, most-privileged first — the highest roster an
account sits on decides what it may do:

| Field | Rank | May do |
|---|---|---|
| `managers` | **Manager** | read, write, publish, **and manage the space** — its settings, roster and review policy |
| `members` | **Member** | read, write, publish — but **not** manage the space |
| `viewers` | **Viewer** | read only — the read-access exception list for a members-only space |

Plus two orthogonal settings:

| Field | Meaning |
|---|---|
| `read_access` | `members_only` (**the default**) — the roster only; `all_users` — every signed-in user may read |
| `status` | **enabled by default** — a disabled space and everything in it leave the knowledge base; its managers still reach it |
| `field_moderation` | **on by default** — saves become drafts, publishing is explicit; off — saves publish immediately |

The line between Manager and Member is `manage space`: a Member writes the
space's content, a Manager also administers the space itself. Anonymous users
read nothing whatever the read access — the frontend is login-gated. The seeded
demo spaces all ship as `all_users` so a fresh install is usable.

An account with **`bypass node access`** reaches every page, roster or not,
and **`administer openkb_space`** reaches every space. A site administrator
holds both — apart, either one alone would let an account read a page out
of a space missing from its own space list.

A members-only space is *invisible*, not merely unreadable: a non-member gets no
space in the sidebar or the space list, no page in any list or search
result, no roster, and a **404** — not a 403 — from the space's own URL and
from the page routes. Existence is not revealed.

## Creating one

Creating a space is the **`create openkb_space`** permission — it happens
outside every space, so the per-space policy below has nothing to say about it.
`openkb_recipe_main` grants it to `authenticated`: every signed-in account may
open a space.

The **creator becomes the space's admin**: appended to `managers` as the space
is first saved, whatever door it came through, and space managers hold update
access on the space — so the roster, the read access and the moderation flag
are theirs with no rule of their own. A space created with an explicit roster
(default content, an import) keeps it; the creator is added, not substituted. A
save with no owner adds nothing.

Two spaces cannot claim one URL. A space's slug **is** its path alias, which
the save derives from the name — transliterated, lowercased, hyphenated. Three
ways a name can fail are refused on the name: one whose alias is already taken
by another space, by a page, by anything with that address; one made
only of characters the slug drops, which would leave the space with no address
at all; and one whose alias is a page of the site itself, a Drupal route or one
of the frontend's own. The taken-URL half is core's, run through the
`path_alias` entity's own validation, and it runs against **every** space: a
members-only space a creator cannot see still holds its URL.
`/<slug>` is the space's landing, and page URLs nest under it — a rename
re-derives them, and `redirect` keeps the old ones answering. A page whose
alias was set by hand keeps that alias: it stays where it was put, which for
one written under the old prefix means the old prefix, and nothing answers at
its title under the new one.

The frontend surface is `POST /api/spaces` → a plain JSON:API space POST, and
an add-space CTA drawn when `/api/me` answers `canCreateSpace`. That answer is
the permission itself, read off `/api/site-info` — `openkb_recipe_main` lists
`create openkb_space` under `lupus_decoupled_site_info.settings`, so the
frontend asks Drupal rather than inferring from a role. Nothing here decides
access: a space created through Drupal admin comes out identical.

## The space's own page

`/<slug>` is the space's dashboard: what changed in it lately, a search box
scoped to it, and the button that opens the chat. The search box hands the
search page `?q=…&space=<slug>`, and the scope narrows the index filter to that
one space — a slug the caller may not read leaves no readable space, so it
finds nothing rather than everything.

Its settings — description, read access, editing workflow and the roster — are
the Settings dialog, which is the create-a-space form in its edit mode. The
button that opens it is drawn only for a session holding space update access
(`canManage`), and the dialog writes through `PATCH /api/spaces/<slug>`; Drupal
decides the write either way. The name is not among its fields: a space's name
is its URL, and renaming is the Drupal form.

## How it is enforced

One access policy plus one node-grants realm, so every surface answers the
same:

- **`SpaceAccessPolicy`** (core Access Policy API, scope `kb_space`) turns the
  roster and the read access into per-space `view` / `update` / `publish` /
  `manage` permissions for an account — or into a per-space *admin* item for an
  account holding `bypass node access`. It is the single authority for the
  page side; everything below reads it, so the admin bypass reaches the
  grants, the node hooks and the search filter from this one place. A disabled
  space yields permissions to its managers alone, so its pages drop out of
  every one of them at once.
- **The `kb_space` grants realm** carries reads: two grant ids per space
  (`id * 2` for readers, `id * 2 + 1` for writers). This is what filters
  entity access and JSON:API collections. Managers and members hold the writer
  grant; viewers and everyone in an `all_users` space hold the reader grant.
- **Writes are denied explicitly** (`hook_node_access`), because grants can only
  ever add access: without the denial, `edit any kb_page content` — which
  every authenticated user holds — would reach into a space the account may not
  write.
- **Creating into a space** is gated on `field_space` being writable — entity
  create access never sees the target space, so the field is where it lands.
  Moving a page into a space you may not write is refused the same way. The
  add-page CTA is drawn on both halves of that rule: `create kb_page content`
  from `/api/me`'s `canCreatePage`, and `canWrite` on the space from
  `/api/spaces` — so a reader of a space is offered no dialog Drupal would
  refuse, and neither picker offers a space it could not be saved into.
- **The space itself** is `openkb_space`'s own access handler, not this
  module's: view follows the roster, the read access and the status; **update**
  is its managers', which is what "manage this space" means and what flips the
  frontend's `canManage`. A member writes content but does not manage the
  space. A non-reader is not shown the space at all — the collection is
  narrowed in SQL as well, so a private space is named nowhere.
- **Restructuring a space** — its page tree, the `outline` base field — has a
  route of its own, `PUT /openkb/space/<id>/outline`, under a `restructure`
  operation rather than plain update. Structure follows content: the space
  holds `restructure` to its managers, and this module widens it to every
  writer where the space runs no review (`field_moderation` off). A space whose
  flag was never written reads as moderated, so the stricter bar is what an
  absent value gets. The write names the tree it replaces and is refused whole
  when the field no longer holds it, which is what keeps one editor's drag from
  carrying away another's reorganisation. What a tree *may be* is two field
  constraints — its shape is the space's own, "every id is a page of this
  space" is this module's — so a bad tree fails identically through this route,
  a raw JSON:API PATCH and an agent.
- **Publishing** needs no rule of its own. The recipe grants
  `use editorial transition publish` to `authenticated`, so
  `content_moderation` — unmodified — lets anyone run the transition; *which*
  page they may run it on is the update rule above, because every publish
  goes through the commit route and that route requires `node.update`. A
  space's managers and members publish in their space; a non-member cannot write
  there at all, so they certainly cannot publish there. Users may self-publish
  what they may edit.

A page that was never published — its default revision unpublished — is
readable by direct id to anyone who may read the space: the node access hook
answers neutral for a default revision, and `content_moderation` allows the
read on `view any unpublished content`, which the recipe grants every
authenticated account. Collections hide it, because the grants realm writes
no reader record before publication.

### Which revision you read

Every page read is a CE route, and Drupal decides each on its own:
`/ce-api/node/{nid}` is the live revision, `/ce-api/node/{nid}/latest` the
working copy, `/ce-api/node/{nid}/revisions/{vid}/view` one revision.

Which of them an account may have is on the page it already holds: a `Latest
version` local task appears exactly where `/latest` answers, so the working
copy is never asked for blind. `Edit` is the same signal for update access.
Absent and forbidden stay apart: the routes answer 404 where the space hides
the page and 403 where the account may not read it.

The app's working-copy surfaces — `GET /api/kb/<space>/<slug>/draft.md` and the
MCP `getPageForEditing` tool — are for the accounts that may write the page,
so a caller without the `Edit` task is refused with a 403. An editor without
the `Latest version` task reads the live revision there, which is the revision
their write would start from. The editor load `GET /api/node/{nid}` is the third
such surface and takes that fallback ungated: an account without the `Latest
version` task never reaches `/latest`, so it reads the live revision — the one
the routes let it read anyway.

Pinned per roster seat, page state and carrier (session cookie, agent token,
the collaboration server's token) by `CeRevisionReadAccessTest`. An agent token
reads through the roster grants like any member, its owner's roles included —
[ADR 0016](adr/0016-agents-hold-no-administrative-bypass.md).

## Asking where you may work

`GET /openkb/spaces` answers, for the signed-in caller, which spaces it may
operate in and what it may do in each — every one it can at least read, as
`{slug, name, description, access, moderated}`, ordered by name.

```
GET /openkb/spaces                 → everything you can see
GET /openkb/spaces?access=write    → only where you may create and edit pages
GET /openkb/spaces?q=handbook      → narrowed by name or description
```

`access` is one ordered scale — `read` < `write` < `manage` — flattened from the
roster ranks, so a caller filtering for "where may I write" does not have to
know which roster grants that; it is a **minimum**, so `write` also returns what
you manage. Spaces you cannot read are absent rather than listed as refused, and
`q` narrows *your* map rather than searching the site.

`SpaceAccessMap` computes it from `SpaceAccessPolicy`, never from the rosters:
the accounts that hold access without sitting on one — a site administrator, the
collaboration server, anyone signed in where read access is `all_users` — appear
on no roster, and a roster-derived answer would tell a site administrator it may
work nowhere.

Anything that would otherwise infer access by reading rosters belongs on this —
a space picker, a create form's target list. The `tool_api__list_spaces`
agent/chat tool is the same service through the tool surface, not a second
implementation (`docs/agent-access.md`).

## Moderation, per space

`field_moderation` is a **policy** decision at the write surface, not an access
one: `content_moderation` stays installed for `kb_page` either way and the
editorial workflow is enforced regardless. `SpaceModerationPolicy` answers
"does moderation apply to this page", and two callers consume it:

- `ReviewPolicy::enforcedSteps()` — which review steps hold a publish back. A
  content write (a collab checkpoint, a `.md` PUT, the Save button) lands as
  `draft` in either kind of space; the payload naming `moderation_state` is
  what publishes.
- `ModerationStatusController` — reports `moderated: false`, which is what
  keeps the state badge out of an unmoderated space while nothing is pending.
  Publish and Revert follow the page's own condition, not the policy.

**Saving always works, and publishing waits.** A Save is a draft revision and
is never refused for a review somebody else owes. A publish the review gate
holds (`BlockAttribution::publicationHold()` — in an unmoderated space that is
the agent step) is refused 422 with the blocking blocks, in either kind of
space; the editor publishes once the review is done, so the refusal names an
act its caller can take. Nothing publishes on its own.

Text outside identified blocks is always refused, both kinds of space and
review or none: it has no review lane a sign-off could clear.

The whole model in one page: [editing-and-review.md](editing-and-review.md).

A page in no space is moderated: the flag lives on the space, so with no
space there is nothing that could have turned it off. Same for a space whose
flag was never written — unset reads as on, in Drupal and in the frontend
alike.

## Freshness

Grant records depend on the page's space alone, never on the roster, so a
roster, read-access, status or moderation change writes no records and needs no
rebuild — the account's grant ids come from the access policy, whose caches the
space save invalidates. A JSON:API PATCH from the space settings UI is therefore effective
on the very next request, with no Form-API batch (which would never run under
JSON:API in the first place).

## Caching

The access hooks are a gate, not a variation: every account they let through
reads the same bytes, so they attach no account-varying cache context. The gate
runs per request ahead of `dynamic_page_cache` — `AccessAwareRouter` checks it
from `RouterListener` at `kernel.request` priority 32, `DynamicPageCacheSubscriber`
serves at 27 — so a shared entry can never reach an account the gate refuses.

What is left keying the `/ce-api` read path is core's own — every page
answer carries `user.permissions`, which `NodeAccessControlHandler::access()`
adds whatever the outcome, and on top of that:

- a space's own page keys by `user`: who may read it is a roster decision the
  entity makes per account,
- a page carries `user.node_grants:view`, added by
  `NodeGrantDatabaseStorage::access()`: one entry per distinct grant set, which
  here means per distinct set of readable and writable spaces,
- an unpublished page keys the same way, and never on a bare `user` —
  drafts are reachable through the space realm, not through ownership. No role
  OpenKB installs holds `view own unpublished content`.

## Search

One index, one read path, one access rule (ADR 0010).

Every search runs inside Drupal — the search page and the `[[` picker through
`GET /openkb/search`, AI retrieval from the chat and over `/mcp` — and they
reach the same index through search_api, where the `space_access_filter`
processor adds the same filter from the same `SpaceAccessMap` service. It
answers for the account running the query: no option names another, and an
account that may read no space aborts the query instead of running it
unfiltered. A query set to `PROCESSING_NONE` runs no processor at all, so that
holds for queries at the default processing level.

The space access map is the frontend's own "may I?" read — the sidebar's
manage controls, the account menu's backend link. It is resolved once per
frontend request and shared with everything that asks. It is **not**
cached across requests: the route declares the `user` cache context, which
`dynamic_page_cache` refuses to store (`renderer.config
.auto_placeholder_conditions.contexts` is `['session', 'user']`). The context
comes from the access hooks in `openkb_space_access.module`, which vary every
kb_page and space read per account rather than per grant set.

The join key is the space's **label**: the index carries it in `space` (from
`field_space:entity:label`) and the access map carries it in `name`. Both are
OpenSearch `keyword` fields.

The index holds published pages only — the `entity_status` processor skips
an unpublished one, and publication is what first indexes it — so no
query-side filter has to keep drafts from anyone.

Index fields are a serving contract now, reviewed as API changes. OpenSearch
never re-types an existing field and its data volume outlives a site reinstall,
so a field first seen by dynamic mapping is stuck as `text` and matches
nothing. `scripts/site-install.sh` drops the index before installing for that
reason; if search comes back empty after a config change, check the mapping
first:

```sh
docker compose exec cli curl -s http://opensearch:9200/default_kb_chunks/_mapping?pretty
```

## Agents

An agent token is capped at owner ∩ scope ∩ space. A read-scoped token of a
space manager reads inside that space and still cannot write; an agent whose
owner is not in a space has no access to it at all. Nothing in the module
special-cases agents — they authenticate as their owner, and the same policy
answers.

The scope half is not automatic. `simple_oauth`'s access policy applies to
**every** scope, `kb_space` included, and intersects each calculated permission
set with the permissions the token's OAuth scopes grant. A space permission no
scope names is therefore stripped — an agent would lose that half of the model.
That is why `openkb_space_access.permissions.yml` declares the space permissions
and the `agent:read` / `agent:write` scope trees name `view` and `update`
(`simple_oauth.oauth2_scope.agent_read_space` / `…agent_write_space`). The
calculated `manage space` is deliberately left unscoped: an agent writes
content, it never administers a space, so a manager's agent token has it
stripped. Adding a permission to the policy that an agent *should* keep means
adding it to a scope, or agents silently lose that half of the model.
