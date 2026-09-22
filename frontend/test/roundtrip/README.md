# Round-trip test harness

Tests the editor conversion cycle — comark markdown → TipTap document →
comark markdown — through the **production** code paths:

- **Load** (`harness.ts` `productionImpl.load`): `parseMarkdownToDoc`
  (`app/comark/markdown-engine.ts`) — the same call the editor makes on
  hydration — parsing straight to a ProseMirror document against the real
  editor schema. Tests run under `@vitest-environment happy-dom`.
- **Save**: `serializeDocToMarkdown` (`app/comark/markdown.ts`).
- **Schema**: `editorExtensions()` mirrors Nuxt UI UEditor's internal
  extension assembly plus the options `pages/node/[id]/edit.vue` passes,
  and appends the real `buildEditorExtensions()` set. Collaboration
  extensions are omitted (no schema contribution, need a live provider).

## Stability properties

| # | Property | Assertion |
|---|---|---|
| S1 | Byte-stability | `serialize(load(md)) === md` for canonical fixtures |
| S2 | Convergence | a second load+save pass over any output is byte-identical |
| S3 | Semantic preservation | comark AST(input) ≡ AST(output) after normalization (`ast.ts`) — catches silent content loss |

Accepted transforms live in [NORMALIZATIONS.md](./NORMALIZATIONS.md);
the AST normalizer encodes exactly those and nothing else.

## Layers

| File | Layer |
|---|---|
| `corpus.test.ts` | Fixture corpus: S1 (or expected-output) + S2 + S3 per fixture |
| `serializer.test.ts` | Direct unit test per serializer rule (docs built against the schema, no parsing) |
| `fuzz.test.ts` | ≥100 seeded formatting mutations over the corpus, S2 + S3 |
| `block-ids.test.ts` | Block-id corpus: trailing `{#b-…}` attributes survive the round-trip (see below) |

## Fixtures

```
fixtures/<name>/input.md      required — the authored markdown
fixtures/<name>/expected.md   only when an accepted normalization changes bytes
fixtures/<name>/lossy.txt     one-line reason when content is lost by contract;
                              S3 then compares output against expected.md
```

Fixture files end with a POSIX trailing newline; comparison strips it
(the serializer never emits one — NORMALIZATIONS.md F12). To add a
construct: drop a directory with `input.md` and run
`npx vitest run test/roundtrip/corpus.test.ts`. If the output differs
and the difference is an acceptable normalization, commit it as
`expected.md` **and** document it in NORMALIZATIONS.md.

## Block-ID corpus (OKB-42)

`fixtures-block-ids/` holds trailing-`{#b-…}` fixtures for every block
type plus `::callout{type="…" #id}`. On native blocks (heading,
paragraph, blockquote, list item) the marker rides through the editor
as literal trailing text; comark parses it into an `id` prop on both
sides of S3, so bytes and semantics both hold. On component fences the
`#id` shorthand maps to the node's `id` attribute
(app/editor/nodes/mdc-markdown.ts) and re-serializes last in the prop
list — comark's canonical position. A media-less image has no fence, so
its id trails the `![…](…)` line as on a native block.

## A/B gating (OKB-7)

`runCorpus(impl, fixturesDir)` accepts any `RoundTripImpl`
(`{ name, load(md) → doc, save(doc) → md }`). To compare a candidate
conversion pipeline against the corpus, implement the interface and add
a test file that calls `runCorpus(candidateImpl, …)` — every fixture,
normalization contract, and assertion applies to it unchanged.
