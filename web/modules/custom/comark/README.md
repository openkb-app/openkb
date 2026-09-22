# Comark — Drupal-side indexing & search for markdown KB bodies

The Drupal module has one job: feed the OpenSearch index with the same
markdown→DOM rendering the frontend uses. Everything else lives in JS.

Comark itself is **CommonMark + component fences**:

```
# Heading

::callout{type="warning"}
Watch out.
::
```

renders (in Nuxt, via the comark tree passes and `@comark/vue`) to:

```html
<h1>Heading</h1>
<callout type="warning"><p>Watch out.</p></callout>
```

No PHP parser. Drupal stores raw markdown on `field_kb_body.value`; the
JS tree passes handle every consumer (read page, editor hydration, search
indexer).

What an author may write is decided by the text format `field_kb_body` is
configured with — `comark` here, and the field names exactly one. Its
`filter_html` `allowed_html` setting lists the HTML tags and the comark
components with their attributes, and — where the value carries meaning, as
in the classes comark's own parsing writes — the values each attribute
accepts. Drupal renders nothing with it: the parsed list is published on
`GET /openkb/schema` as `body.allowedHtml` and applied by the tree passes, to
HTML elements and component nodes alike. A tag off the list unwraps to its
words, an attribute off it drops, and no tag takes a free-form `style` or
`class`, so raw HTML in a body cannot paint over the app.

Media-library images are a childless component fence carrying the Drupal
media UUID (never a file URL — the render URL is resolved at render time
via JSON:API, so derivatives/alt/focal point stay managed on the media
entity):

```
::image{media="<uuid>" alt="Optional per-embed override"}
::
```

Inside table cells the inline form `:image{media="…"}` is used instead.
Plain `![alt](url)` stays valid for external URLs.

## What's inside

| Path | Role |
|---|---|
| `src/Plugin/search_api/processor/ComarkIndexable.php` | search_api processor. On index, POSTs the markdown to the Nuxt sidecar (`/api/comark/indexable`) and populates the `chunks` virtual field on the search item. |
| `src/Plugin/search_api/processor/KbPagePath.php` | search_api processor. Adds `path`, the page's space-scoped alias, so a hit is linkable without a Drupal request. |

## Pipeline

```
SAVE
  field_kb_body.value (raw markdown) — stored as-is in Drupal.
  No filter rendering: filter.format.comark carries the allowed list only.
  search_api marks items dirty.

INDEX
  search_api → ComarkIndexable processor
   ├── POST <nuxt>/api/comark/indexable { markdown }
   │     → { chunks }
   └── populate the `chunks` virtual field on the search_api item
       ↓
  openkb_search's comark_sections strategy — one embedding per section
       ↓
  OpenSearch collection `default_kb_chunks` (`openkb_text` analyzer)

QUERY
  /api/kb/search (Nuxt) → Drupal `GET /openkb/search`, which retrieves
  from the chunk index. Drupal is the access authority, so which pages
  come back is its answer and nothing is filtered on the way.
```

## Configure

The module is wired by `recipes/openkb_recipe_main/`. Manual enable:

```bash
docker compose exec cli drush en comark -y
```

The `comark` text format is the allowed list and nothing else — Drupal runs
no transformation on save. Bodies use it so the editor / agents know the
format is markdown, and admins edit the list at
`/admin/config/content/formats/manage/comark`.

Which format that is, is `field_kb_body`'s own `allowed_formats` setting:
`openkb_schema` reads it there to publish the list (cache-tagged on the field
and the format, so retargeting the field or editing the list reaches every
reader on the next render) and stamps it onto every body on save, so no write
surface names a format.

## Search

`recipes/openkb_recipe_main/config/search_api.index.kb_chunks.yml` defines
the index. What this module puts into it is one field:

| Field | Type | Source |
|---|---|---|
| `chunks` | string (JSON) | Nuxt comark tree passes: `{block_id, heading_path, part, text}` per section |

`openkb_search`'s `comark_sections` strategy turns each chunk into one
indexed row, with the section's text stored beside its vector. The values
reach OpenSearch as they were written — the search page, the picker and the
AI tool read a hit's title and excerpt straight out of the row — and
matching is the analyzer's job: `openkb_search` names `openkb_text` on every
analyzed field.

The heading a page opens with is its title, so the chunker leaves it out of
the section it opens.

The sidecar is the decoupled frontend itself, so the processor takes its
origin from the Lupus frontend base URL — `lupus_decoupled_ce_api.settings`
`frontend_base_url`, which `DRUPAL_FRONTEND_BASE_URL` overrides. comark holds
no origin of its own. That URL is published for browsers, so a topology where
it is not also reachable from the container that indexes (drush in `cli`,
`index_directly` in `drupal`) indexes bodies nowhere — see the degraded path
below.

If the frontend base URL is empty, or the sidecar is unreachable at index
time, the item is **still indexed**, with no sections at all: search_api
counts it as done and does not retry it. Nothing of what the page says is
searchable until something re-indexes it. The processor logs that at error
level, naming the origin it could not reach.

Repairing such a corpus takes a **tracker reset**, not a plain re-index: the
degraded items are recorded as indexed, so `search-api:index` alone reports
"the index is up to date" and re-enriches nothing.

```bash
docker compose exec cli drush search-api:reset-tracker kb_chunks -y
docker compose exec cli drush search-api:index kb_chunks -y
```

`scripts/site-install.sh` runs exactly that at the end of an install, after
waiting for the sidecar to answer, so a fresh site never ends up with pages
whose text nothing can reach.

Re-index after schema changes:

```bash
docker compose exec cli drush search-api:clear kb_chunks -y
docker compose exec cli drush search-api:index kb_chunks -y
```

Verify against OpenSearch directly:

```bash
docker compose exec cli curl -s "http://opensearch:9200/default_kb_chunks/_search?pretty&size=1&_source_excludes=vector"
```

## Query surface

The module owns what goes *into* the index, not what comes out of it: the
read path is `openkb_search`'s `ChunkRetrieval`, behind Drupal's
`GET /openkb/search`, which the frontend forwards to
(`frontend/server/utils/kb-search.ts`). The excerpt under a row is the
section's own text, with the passages the lexical clause matched marked.

```bash
curl 'http://node1.openkb-dev-project.localdev.space:8091/api/kb/search?q=editor'
```

## Tests

```bash
docker compose exec cli ./vendor/bin/phpunit web/modules/custom/comark/tests
```

(Add tests here as new processor / endpoint logic lands. The historical
filter / formatter tests were removed alongside the rendering code.)

## Dependencies

| Package | Why |
|---|---|
| `drupal/search_api` ^1.39 | Processor base class + indexing pipeline |
| `drupal/search_api_opensearch` (run-time) | `ai_vdb_provider_opensearch` requires it, and the chunk collection's `openkb_text` analyser is one of its plugins |
