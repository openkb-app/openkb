# Accepted round-trip normalizations

The contract of every transform the editor round-trip
(markdown → TipTap doc → markdown) is allowed to apply. Anything not
listed here is a bug: the corpus in `test/roundtrip/` fails on it.

Canonical markdown (the serializer's output style) is byte-stable:
`serialize(load(md)) === md`. Input written in a non-canonical style
converges to canonical form in **one** pass and is byte-stable from then
on. "Lossy" entries lose information that cannot be recovered from the
saved markdown; everything else is pure re-formatting.

## Formatting canonicalizations (content-preserving)

| # | Input | Canonical output |
|---|---|---|
| F1 | `_em_` / `__strong__` | `*em*` / `**strong**` |
| F2 | `* item` / `+ item` bullets | `- item` |
| F3 | `1)` ordered markers | `1.` |
| F4 | Loose lists (blank line between items) | Tight lists — comark renders loose and tight to identical HTML, so looseness never reaches the editor |
| F5 | Setext headings (`Title\n=====`) | ATX (`# Title`) |
| F6 | Two-trailing-space hard breaks | Backslash hard breaks (`\` at line end) |
| F7 | Bare URLs autolinked by GFM | Angle autolinks (`<https://…>`) |
| F8 | `~~~` code fences | Backtick fences, minimal length ≥ 3 (grown past embedded backtick runs) |
| F9 | Component fences with extra colons | Minimal fence length: innermost `::`, each level out one more colon |
| F10 | Table decoration: alignment colons (`:---:`), column padding, `|---|` separators | `\| --- \|` separators, single-space cell padding. Alignment is **dropped** — the editor schema has no cell-alignment attribute |
| F11 | Blank-line runs between blocks | Exactly one blank line |
| F12 | Trailing newline at end of document | None — the serializer ends at the last block |
| F13 | `\"` escapes inside `::infobox{title="…"}` | Unescaped to `"` in the editor attribute, re-escaped byte-identically on save (comark keeps the raw escape sequence in the parsed prop) |
| F14 | Unquoted and single-quoted component prop values (`{type=warning}`, `{type='warning'}`) — all three quoting styles are valid comark | Double-quoted (`{type="warning"}`). The **value is preserved**; only the quoting converges |

## Structural transforms (content preserved, shape changed)

| # | Input | Output |
|---|---|---|
| T1 | Image inline in a paragraph (`text ![a](/i.png) text`, `text :image{media="…"} text`) | Paragraph split around the image: paragraph / block image / paragraph. The editor's image node is block-level. Whitespace at the split edges is dropped. A trailing `{#id}` splits off into an empty paragraph of its own, which an image right before it adopts — so an image alone on its line (`![a](/i.png) {#b-1}`) keeps the id. Exception: inside a table cell the image stays put and serializes in its inline form (`![a](src)` / `:image{…}`) |
| T2 | List item whose entire content is a component (`- ::callout…::`, `- ::image{…}`) | Component hoisted out of the list, splitting it; ordered lists keep numbering via `start`. Editor list items must start with a paragraph |

## Lossy transforms

| # | What | Loss |
|---|---|---|
| L1 | Inline raw HTML outside the editor schema (`<kbd>`, `<sup>`, `<abbr>`, …) | Tag dropped, text content kept. (`<u>` is NOT lossy — it maps to the underline mark and round-trips) |
| L2 | Block-level raw HTML (`<div>…</div>`) | Dropped entirely — the editor has no schema node for it |
| L3 | Mentions inserted in the editor | Serialize as plain `@label`; the uid attribute is dropped. A Drupal-side mention filter re-resolves `@label` at render |
| L4 | Heading auto-ids (`id="slug"` from comark) | Never stored in the editor; regenerated from text at next parse |
| L5 | Unescaped `data:` URI in an image (`data:image/svg+xml;utf8,<svg …/>`) | Not parsed as a link; the URI content after the comma is lost. Base64 and percent-encoded `data:` URIs round-trip. Agent writes are percent-encoded at the write door (`server/utils/comark-data-uri.ts`), so a body arriving that way carries no such URI; a destination that does not close after its payload is refused with a 422 |
