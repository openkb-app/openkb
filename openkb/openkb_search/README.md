# OpenKB Search — how the indexes are read

Holds the product's OpenSearch text analysis, the chunk index's read path
(`Retrieval\ChunkRetrieval`) and the search page's route
(`GET /openkb/search`). What goes *into* the index is `comark`'s business.
The frontend's own reads of the lexical index stay in
`frontend/server/utils/kb-search.ts`.

## One analyzer, for every language

`OpenKbText` (`openkb_text`) is the analyzer every `text` field of the page
index is read with: the standard tokenizer, `lowercase`, `asciifolding`.
So a lower-case query finds a capitalised title, `Uber` finds `Über`, and
`eleve` finds `élève`.

Nothing beyond that — no stemmer, no decompounder, no stopword list, no
synonyms. Those are language-specific, and the product ships none of them.

`FieldMappingSubscriber` names it on every `text` field of the mapping
`search_api_opensearch` builds, at priority 100 and only where no analyzer is
named yet.

## Language-specific analysis is project configuration

A project that wants a German stemmer, a decompounder or a synonym list
declares an analyser plugin of its own and names it on the fields it wants read
that way, through the same `FieldMappingEvent`. Its subscriber runs after this
one, so whichever field it names keeps its choice. LDP's `GermanLanguage`
analyser is the worked example.

## Tests

The kernel cases index into the live OpenSearch container and **fail** when
nothing answers on it — `RequiresOpenSearchTrait`, opt out with
`OKB_SKIP_OPENSEARCH_TESTS=1`.

```bash
docker compose exec cli ./vendor/bin/phpunit web/modules/contrib/openkb/openkb_search/tests
```

`openkb_search_test` ships the embeddings provider those cases index through:
each word of the text picks a dimension and a sign, so the vector is a bag of
words, the same text always answers the same vector and a run needs no API key.
Two texts rank near each other exactly as far as they share words — so a case
may assert that a query finds the section it shares words with, and none may
assert that two texts saying the same thing in different words do.

The chunker itself is the sidecar's, and is covered there:

```bash
cd frontend && npx vitest run --project unit server/utils/comark-chunks.test.ts
```

## The chunk index and block-level retrieval

`kb_chunks` holds one row per section of a published page and is the one index
the product reads: the chat's grounding, the `search_pages` tool, the search
page and the `[[` page picker all retrieve from it through `/openkb/search`,
every hit names a block, the citation link lands on it. A title prefix —
the picker's offers and the search box's suggest — is the lexical clause of
that same index on its own, so it costs no embedding. The route answers an
empty query off an entity query instead: the newest published pages the
account may read, newest first, nothing embedded and no index touched.

### Layers and who owns what

| Layer | Where | Contract |
|---|---|---|
| Chunking | sidecar `frontend/server/utils/comark-chunks.ts`, answered by `POST /api/comark/indexable` as `chunks` | `Chunk {block_id, heading_path, part, text}`; a section is a heading plus the blocks under it to the next heading; target/cap in tokens, a token estimated as four characters, never above the cap, split inside an oversized block with parts sharing `block_id`. See "Chunks" below |
| Into the index | `comark`'s `ComarkIndexable` exposes `chunks` as one more processor property (JSON string) | what goes into the index stays comark's business |
| Embedding | `openkb_search` `#[EmbeddingStrategy] comark_sections` | one embedding per chunk, of the index's Contextual Content lines, the heading path and the chunk's text; chunk metadata `block_id`, `heading_path`, `part`, `content`; item attributes as `search_api.index.kb_chunks` lists them — the address plus the frontmatter; knows nothing of the cache |
| Embedding cache | `Embedding\EmbeddingCacheSubscriber` over `KeyValueEmbeddingCache` (`openkb_search.embedding_cache`) | transparent: drupal/ai's `ProviderProxy` runs every provider call through `PreGenerateResponseEvent`, and a forced output returns before the provider is reached, so index-time and query-time embeddings are cached with every ai_search setting untouched; keyed `provider:model:dimensions:sha256(text)`, because one model answers several dimensions and more than one provider answers the same model id, and none of those are the same vectors; `drush openkb:embeddings-export` / `openkb:embeddings-import` move it to and from `tests/fixtures/embeddings/`; a test provider answers a deterministic hash vector where nothing is cached |
| Store | `ai_search` + `ai_vdb_provider_opensearch` over the same OpenSearch | one hybrid query, a kNN clause beside a match clause, fused by a search pipeline. `ai_search` is the module inside our pinned `drupal/ai`; only the provider is required separately, and its defects are carried as patches (see below). drupal/ai 1.5 has no embedding cache of its own (2.0.x gains a one-week query cache, opt-in per provider) |
| Retrieval | `Retrieval\ChunkRetrieval` (`openkb_search.chunk_retrieval`) | `retrieve(query, topK, options): ChunkHit[]` and `retrievePages(...): PageWindow` — the same read collapsed to one `PageHit` per page, its sections best first and one per block. Each option names a keyword attribute of the index and narrows on it (`space`, `type`, `tags`, `owner`, `contributors`); an option naming none is refused. It embeds the query itself, at the server's dimension, and hands the vector over as `vector_input`; `search_api_bypass_access` + `search_api_ai_get_chunks_result` on every query; `space_access_filter` scopes it. The backend sets no fields on a result item, only the score and one extra-data key per stored field, so a hit is read from extra data alone — reading a field would extract it and load the page behind the id. Those keys are the attributes the strategy stored, which reach the item only because the provider answers the whole stored row: `ai_search` asks for four fields and nothing else |
| Consumers | `ai_rag_cite` retriever `ai_search_chunks`; `openkb_tools` `search_pages`; `Controller\SearchController` | citation shape `{n, title, path, meta, score}` with `path#block_id` and the heading path as `meta`; the tool answers `block_id` beside it; the route answers one row per page. Every hit is anchored — see "Retrieval" |
| Landing | frontend | `#<block_id>` in the URL scrolls to the block and marks it on arrival (`main.css`, `app/router.options.ts`) |

### Access

Drafts and unpublished revisions are never in the index (`entity_status` at
index time). At query time `space_access_filter` runs on any index with a
`space` field and ignores the bypass option, so the account's spaces bound
every kNN. The provider turns that condition into the OpenSearch filter on the
kNN query. Both consumers are gated by a negative test: a chunk of a
foreign-space page and of a draft is unreachable through chat grounding and
through `search_pages`, and the read path loads no entity.

### Chunks

**A section is a heading plus the blocks under it, to the next heading.** Any
next heading, whatever its level: two chunks never hold the same words, and
where a chunk sits in the hierarchy is what `heading_path` says — the page's
own heading first, the section's last. Blocks before the first heading are a
section with an empty path.

**A chunk lands as near the target as its blocks allow.** A block joins the
open chunk unless that would carry it further past the target than closing
short of it does, so a chunk opens on a block of its own and its `block_id` is
the block a citation should land on.

**No chunk exceeds the cap, whatever the block.** A token is estimated as
four characters; the cap only has to keep a section near the target and well
under the provider's input limit. A block above the cap on its own is
cut at the coarsest boundary that fits: line, then sentence, then word, then
bare code points for a single token run longer than the cap. Its parts share
`block_id` and count `part` up from 0; the header row of a split table and the
fence of a split code block are not repeated.

**A list is one item per line and a table one row per line**, each cell under
its column as `Column: cell; Column: cell`, so a value stays with the thing it
is a value of. Code keeps its own line breaks.

The target and the cap are Drupal's (`openkb_search.settings`) and travel with
the indexable request: the strategy that embeds the chunks is configured here,
so the two cannot drift. `DEFAULT_CHUNK_OPTIONS` only answers a caller that
names neither.

### What the strategy has to do that ai_search does not

**It asks the provider for the collection's dimension.** A strategy is handed
its own configuration and never the server's embeddings-engine configuration,
so nothing on the way to the provider names the dimension the collection was
created for; `comark_sections` reads it off the server and sets it on the
provider. The same number keys the cache, which is what makes a fixture per
model and dimension mean anything. The read path has the same gap and closes
it the same way — see "Retrieval" below.

**A provider that is down takes the item down with it.** ai_search catches
every provider exception and only logs it, and the page's old rows are deleted
before the strategy is called — so a short answer would leave a page with no
rows that search_api counts as indexed. `comark_sections` fails instead when
fewer vectors come back than it has sections, which leaves the item queued for
the next run.

**Which field the sections are read from is the index's config and nothing
else**: the strategy embeds whatever is marked Main Content. ai_search's form
is the only thing that refuses an index naming none, so YAML-shipped config
could define one that embeds nothing while search_api counts every item as
indexed — `ComarkSectionsTest` holds the setting instead, reading the shipped
`ai_search.index.kb_chunks` and indexing a page through it.

### The embedding cache covers the batched call too

A provider that batches is called on `embeddings_collection`, with a list of
texts, which is what indexing an item of several chunks takes — so the
subscriber answers that shape as well as the single one. A forced output is all
or nothing, so a collection holding one unknown text goes to the provider whole
and every vector it answers is stored.

### Config, shipped by `openkb_recipe_main`

`search_api.server.ai_chunks.yml` (backend `search_api_ai_search`, provider
opensearch, engine openai `text-embedding-3-small`, 512 dimensions, strategy
`comark_sections`), `search_api.index.kb_chunks.yml` (datasource kb_page,
fields chunks / title / path / space / langcode / changed / created plus the
frontmatter — type / tags / summary / owner / contributors — processors
`comark_indexable`, `kb_page_path`, `entity_status`, `space_access_filter`,
`trash_status`), `ai_search.index.kb_chunks.yml` (`chunks` as main content,
`type` as contextual content, the rest attributes), and
`ai_vdb_provider_opensearch.settings.yml` (how the store reaches the cluster).
`openkb_search.settings` names the index and the token target and cap.

### What a row carries, and what is embedded

The frontmatter is the `node.kb_page.frontmatter` form display's field set,
and each field is in `field_settings` with the type its use asks for: a
keyword (`type`, `tags`, `owner`, `contributors`) for what is filtered or shown
on a row, analyzed text (`summary`) for what the lexical clause matches in, a
date (`created`) for what is sorted. A reference is read as its label, so the
row names a person or a tag without loading one. `field_kb_body` is the
sections themselves and `field_block_meta` is internal; neither is attached.

`ai_search.index.kb_chunks.yml` decides what is embedded on top of being
stored. A field marked Contextual Content goes in front of every chunk's
embedded text as one `<label>: <value>` line, in field order, and a page that
leaves it empty adds no line. `type` is marked that way; the stored `content`
and the highlights stay the section's own text, and the attribute is on the
row either way, so the filter reads it. Adding a frontmatter field to the
prefix is that one option — and it re-keys every embedding text, so the
fixture has to be refreshed from a run with a key.

### Refreshing the fixture after an embedding-text change

The `chunk-index` stage on CI writes the embedding cache out
(`drush openkb:embeddings-export`) and archives
`openkb/openkb_search/tests/fixtures/embeddings/**`, so the vectors a keyed
build paid for come back as an artifact. Push, read the build's
`N asked of the provider`, fetch its archived
`openai-text-embedding-3-small-512.json`, commit it in place and push again.
The second build must read `0 asked of the provider`.

**The index ships enabled.** Block-level retrieval is what the chat and the
`search_pages` tool answer from, so an environment without it has no RAG at
all. Every item it tracks is embedded at save time, so a stack whose engine
has no key logs a failed call per save and leaves the page queued —
`PostRequestIndexing` catches it, and the save itself is unaffected.

**A developer stack embeds through `openkb_hash`.**
`openkb_recipe_embeddings_mock`, which `openkb_recipe_dev` carries, points the
server at the provider `openkb_search_test` ships — a bag of the text's words —
so a stack with no key indexes and retrieves for real.

**CI embeds through OpenAI.** The key is on the job (`OPENAI_API_KEY`, Jenkins
credential `openkb-openai-api-key`), so `openkb_recipe_ci` lists the
development recipe's parts and leaves the mock out; that is what makes the
block-level RAG showcase on a review app real. `scripts/site-install.sh`
indexes `kb_chunks` after the sidecar answers, and the `chunk-index` stage runs
`scripts/verify-chunk-index.php` — red when the store holds no row for a page
search_api counts as indexed, and red when the rows were embedded through
another provider than the one the environment requires
(`OKB_REQUIRE_EMBEDDINGS_PROVIDER`). The stage then exports the cache and
archives it, so the vectors a keyed build paid for can be committed as the
fixture every later build indexes from.

### Retrieval

`ChunkRetrieval` is the one read path. All three consumers go through it, so
none can be answered a section the others would not get:

- **`ai_rag_cite` retriever `ai_search_chunks`** (`openkb_search`, so the one
  service stays the only query) has no narrowing settings of its own: the
  turn's caller context decides how wide the retrieval is. It maps a
  `ChunkHit` to a `Source`: the page's title, the anchored path, the heading
  path as the meta line, the section's own text as the excerpt. Several
  sections of one page share `entityId`: the grounding layer reads at most
  `max_per_entity` of them and each one it keeps is a numbered source at its
  own anchor. The citation the client renders keeps its shape,
  `{n, title, path, meta, score}`.
- **`search_pages`** (`openkb_tools`) answers the same hits as
  `{id, title, path, block_id, space, type, tags, heading, excerpt, score}`,
  `path` anchored on `block_id`, and takes an optional `type` argument
  validated against the frontmatter schema's values. `tool_api__get_page` and
  the frontend's write tools take that path as it comes: the anchor is dropped
  where the page is resolved.
- **`GET /openkb/search?q=&page=&space=&type=`** (`SearchController`) is the
  search page's read, on `retrievePages()`. It answers
  `{query, page, page_size, has_more, pages}`, a page being
  `{id, title, path, space, type, tags, changed, score, sections}` off the row
  and no entity load. `space` is the space's URL slug, resolved to the label
  the index carries; a slug naming no readable space narrows to nothing. A
  query, page, space or type the route will not take is a 422, and a query the provider's
  content guard refuses is a 422 carrying the no-match answer and its reason —
  503 stays the index being unreachable. The route is `_format: json`, so a
  refusal is JSON rather than Drupal's HTML error page. Only the empty query
  counts: it is an entity query, which counts cheaply. A search does not — the
  collapse runs after the chunk fetch, so only the fetched window is known,
  and the fetch widens until the window asked for is full or `MAX_CHUNKS` is
  reached.
- **`GET /openkb/search?title=&space=`** on the same controller is the
  title-prefix read, on `retrieveTitlePages()`: the pages whose title starts
  with what has been typed, answering `{pages}` with
  `{id, title, path, space, type, highlights}` per row, eight at most —
  `highlights` being the title with the matched words between the provider's
  mark characters. The lexical arm alone — `lexical_only` on the
  `title` attribute with the `bool_prefix` match type — so nothing is embedded
  and no provider is called; access is the index's `space_access_filter` like
  every other read. The offers come back closest title first: the one the
  typed words spell, then the shortest carrying them, then what the index
  ranked best — a prefix matches every title carrying it and scores them
  alike, so a title that merely says more would otherwise lead the one being
  typed. A prefix that is empty or over 128 characters is a 422, and so is a
  request naming `title` and `q` together: they are two reads of two shapes.

**Every cited section anchors; the lead section anchors on the page title.**
A page's lead section — the text above its first sub-heading — opens on the
title heading, so that is the block it names, like any other section. The
heading itself is stripped from every read, because the title is a field of
its own: `get_page` answers its id as `title_block_id`, and the frontend puts
it on the page's own `<h1>`, which is where the anchor lands. Every write
spells the heading with a block id — the app's create route and the editor's
commit through `server/utils/title-heading.ts`, the agent's through
`CreatePage` — so the anchor exists for a page an author just made, not only
for seeded content.

**It embeds the query itself.** ai_search embeds a query with no dimension
named, so against a 512-dimension collection the vector would be the model's
widest and the cache would key it under none. `ChunkRetrieval` asks the
server's engine for the server's dimension and hands the vector to the backend
as `vector_input`, which is also what makes a repeated question cost nothing.

**Ranking is hybrid.** One OpenSearch request carries a `knn` clause on the
section vector and a `match` clause on the section text, and the provider's
search pipeline normalises the two score lists and combines them as a weighted
arithmetic mean. So a term a section spells out reaches it whether or not the
embedding places the question near, and a hit carries the fragments the
lexical clause matched in (`ChunkHit::$highlights`) for an excerpt to mark,
each matched word between a pair of private-use characters no page text can
spell. The section text and the page summary are mapped as analyzed `text`
with `openkb_text` through the provider's `CollectionMappingEvent`; the
collection is created when the server's config is saved, before the index's
own config exists, so `CollectionMappingSubscriber` names those fields rather
than reading them off `field_settings`. A mapping is fixed when a collection is
created, so a change to it needs the collection dropped.

**The floor is on the vector clause.** The pipeline normalises each clause
against its own result set, so the fused score ranks the answer and measures
nothing — the best hit of any search is 1.0, an off-topic one included. The
gate therefore sits where the score still measures distance: `vector_floor` in
`openkb_search.settings` is handed down as the kNN clause's `min_score`, on
the `(1 + cosine) / 2` scale, where 0.5 is an unrelated section and 1.0 an
identical one. It is one number for both consumers — the `search_pages` tool
needs no setting of its own and the chat's `score_gate` is off. It is on the
embedding engine's scale, so `openkb_recipe_embeddings_mock` moves it to 0.65
with the keyless engine and `openkb_recipe_ci` moves it back to 0.75. The
lexical clause carries no floor: it carries the parsed keys' conjunction —
`AND` by Search API's default — so it answers only rows holding every word of
the query. An excluded key — `-word` — is neither arm's clause but a filter
beside the access one, so it takes the rows carrying it out of both arms, and
`ChunkRetrieval` leaves it out of the text it embeds.

**A provider that cannot answer is unavailability.** The query is embedded
here, so an unkeyed or failing engine would otherwise escape as a provider
exception from a place no consumer watches; `ChunkRetrieval` raises it as a
`SearchApiException`, which the chat reads as `dependency_unavailable` and the
tool as "search is unavailable". A content guard refusing the caller's own
words is a `QueryRefusedException` — a subclass, so a consumer that does not
tell the two apart keeps its behaviour, and the search route answers it as
"nothing matches these words".

### The vector store, and what it needs patched

`drupal/ai_vdb_provider_opensearch` 1.1.0-alpha2 is the vector store. It
depends on `ai:ai_search` — the module inside `drupal/ai`, which is complete
there and marked `lifecycle: deprecated` because drupal/ai 1.6 drops it for the
standalone project. Requiring `drupal/ai_search` today would put a second
`ai_search` in `web/modules/contrib/`, and extension discovery takes whichever
it scans last, so the standalone project only comes in with the drupal/ai 1.6
upgrade.

The provider's own composer constraint asks for `search_api_opensearch`
`2.x-dev`, which the 2.5.0 our patches are cut against does not satisfy, so the
root requires it as `2.5.0 as 2.x-dev` until the constraint is relaxed
upstream. A patch cannot do that job: composer resolves before
composer-patches runs. The alias pins the exact version, so a
`search_api_opensearch` security release has to be taken by hand — bump the
alias, do not wait for a range to float.

Seven changes are carried as patches in `patches/`, each covered by
`OpenSearchVdbProviderTest`, `HybridQueryTest` or `SearchTitlePrefixTest`
against the live OpenSearch. They apply in the order `composer.json` lists
them: the later ones sit in context the earlier ones changed. One further
patch sits on `drupal/ai`, beside them.

| Patch | Without it |
|---|---|
| attributes mapped as keywords | `createCollection()` declares only the vector, so every attribute is dynamically mapped as analyzed text and no `term` filter matches one |
| chunk id as document id | `insertIntoCollection()` mints a `uniqid()` per row, so a reindex adds a second set of chunks instead of replacing the first. The id carries the index too: a collection belongs to the server, so two indexes holding one entity would otherwise write over each other |
| one bool filter list | `prepareFilters()` writes the index id into the clause the condition group built, giving either two fields in one `term` or a `term` beside a `bool` — OpenSearch rejects both |
| own collections only | `getCollections()` answers every index in the cluster, under its prefixed name, so foreign indices are offered and the names cannot be passed back in. A collection made before the marker is admitted on its vector field, so an upgrade does not hide it |
| stored row on the read path | `vectorSearch()` narrows `_source` to the four fields `ai_search` asks for, so every attribute the strategy stored is gone before the result item is built and a hit can name neither its page nor its block |
| hybrid kNN and match | `vectorSearch()` only ever issues a kNN clause, so a term a section spells out is unreachable unless the embedding happens to place the question near it, and a site wanting both arms has to run a second query and merge the lists itself. The patch adds `CollectionMappingEvent`, the hybrid query and its pipeline, the `vector_min_score` query option the floor rides on, and the highlight fragments on the row |
| lexical-only query | there is no way to ask for the match clause alone, so a read that wants the lexical arm — a title prefix offered while someone types — carries a kNN clause and the embedding behind it. The `lexical_only` query option names the match type (`bool_prefix` for a prefix match) and the text fields to match in, and issues no kNN clause and no pipeline |

One patch on `drupal/ai` goes with the last of those: the `ai_search` backend
embeds a query's keys before every search and only reaches a provider's
`vectorSearch()` when it holds a vector, so a `lexical_only` query would still
cost an embeddings call. The patch passes the option through instead.
