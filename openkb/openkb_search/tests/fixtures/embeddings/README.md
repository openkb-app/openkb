# Embedding fixture

What `drush openkb:embeddings-export` writes and
`drush openkb:embeddings-import` reads: one JSON file per provider, embedding
model and dimension, named `<provider>-<model>-<dimensions>.json`, holding the
embedding cache as `Embedding\EmbeddingCacheInterface::all()` yields it —

```json
{
  "openai:text-embedding-3-small:512:<sha256 of the text>": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "dimensions": 512,
    "vector": [0.012345, -0.067891]
  }
}
```

The provider is part of the key because more than one answers the same model
id: `openkb_search_test`'s keyless provider answers `text-embedding-3-small`
too, and its made-up vectors must never be read — or exported — as OpenAI's.

The cache stores no text, so an entry can only go back under the key it came
out as: a fixture is tied to the exact texts that produced it, and a page whose
section changed is a cache miss that reaches the provider.

## Refreshing it

The CI build is the keyed site: its `chunk-index` stage exports the cache and
archives `openkb/openkb_search/tests/fixtures/embeddings/**`, so a refresh is
that artifact downloaded and committed. On a keyed site of your own:

```bash
drush search-api:index kb_chunks
drush openkb:embeddings-export --model=text-embedding-3-small
```

## What is committed

`openai-text-embedding-3-small-512.json`: the demo knowledge base and the
Lupus Decoupled docs space, as `text-embedding-3-small` answered them for the
CI build that had the key. `scripts/site-install.sh` imports it before indexing
`kb_chunks`, so a keyed environment embeds only what the fixture does not hold.
A keyless stack embeds through `openkb_hash`, whose entries key under their own
provider and never read these.
