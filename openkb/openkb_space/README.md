# openKB Space

The `openkb_space` content entity: one openKB space, the unit a knowledge
base is organised and access-controlled by. Every `kb_page` references
one through `field_space`.

## What the entity owns

- **Identity**: label, owner, enabled/disabled `status`. A disabled space
  is hidden from the frontend; its managers and administrators still see
  it in the backend. Description, moderation and agent review are
  configurable fields shipped by `openkb_recipe_main`.
- **Roster**: `managers`, `members`, `viewers` as base fields, and
  `read_access` (`members_only` or `all_users`).
- **Access to the space itself**: the entity access handler decides view
  and update from roster, read access and status; `administer openkb_space`
  bypasses. On first save the creator joins `managers`. `openkb_recipe_main`
  grants `create openkb_space` to every signed-in account.
- **Outline**: the space's page tree, a base field with its validation, and
  `PUT /openkb/space/{openkb_space}/outline` — the one write that replaces
  a whole tree, under a `restructure` operation of its own.
- **URL**: a `path` base field the save fills from the name — transliterated,
  lowercased, hyphenated. That alias is the space's landing and the one slug;
  every payload — JSON:API and both CE displays — carries it, and `getSlug()`
  reads it back. `SpaceNameConstraint` refuses a name that cleans away to
  nothing, one whose alias is taken — the alias the save would write goes
  through the `path_alias` entity's own validation, so the refusal and its
  wording are core's — and one whose alias is a page of the site itself. Page
  URLs nest under the space's alias, and `openkb_space_access` re-derives them
  when a rename moves it.
- **Revisions**: every save is a revision with author, time and log message;
  the backend has a Revisions tab.
- **Storage**: `SpaceStorage`, the entity type's own storage handler, adds
  `all()` (every space, access checks off — the input an access decision is
  calculated from) and `getBySlug()`. Its loaded-spaces cache is dropped by
  core's `resetCache()`, which every save calls. `all()` loads by id so the
  entity cache is read rather than written over, and `SpaceCacheReset` drops a
  saved space from that cache again when the request ends — core's entity
  cache can otherwise keep serving a pre-save copy
  ([#3474843](https://www.drupal.org/project/drupal/issues/3474843)).

## Admin UI

Core's add, edit and delete forms, a Field UI settings route for further
configurable fields, and a Views listing as a Content tab at
`/admin/content/space` with exposed filters for title, owner and creation
date.
`openkb_recipe_main` imports the View; a recipe installs the module without
its config entities.

## Not here

Access to the pages inside a space (node grants, node access, the
per-space policy) is `openkb_space_access`. So is the rest of the outline's
contract — "every id is a page of this space" needs a node query — and
the widening that lets a space with no review step be restructured by its
writers, not only its managers.
