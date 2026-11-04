# Accepted round-trip normalizations

The contract of every transform the editor round-trip
(markdown → TipTap doc → markdown) is allowed to apply. Anything not
listed here is a bug: the corpus in `test/roundtrip/` fails on it.

Canonical markdown is what comark's renderer writes, with the two exceptions
in `app/comark/render-handlers.ts` (escapes comark misses, emphasis that would
not flank). It is byte-stable: `serialize(load(md)) === md`. Input written in
another style converges to canonical form in **one** pass and is byte-stable
from then on. "Lossy" entries lose information that cannot be recovered from
the saved markdown; everything else is pure re-formatting.

## Formatting canonicalizations (content-preserving)

| # | Input | Canonical output |
|---|---|---|
| F1 | `_em_` / `__strong__` | `*em*` / `**strong**` |
| F2 | `* item` / `+ item` bullets | `- item` |
| F3 | `1)` ordered markers | `1.` |
| F4 | Loose lists (blank line between items) | Tight lists — comark renders loose and tight to identical HTML, so looseness never reaches the editor |
| F5 | Setext headings (`Title\n=====`) | ATX (`# Title`). A setext heading over several lines joins them with spaces (`C\nD\n---` → `## C D`): comark writes a heading on one line |
| F6 | Backslash hard breaks (`\` at line end) | Two trailing spaces |
| F7 | Bare URLs autolinked by GFM | Scheme URLs: angle autolinks (`<https://…>`). `www.` and email: inline links (`[www.x](http://www.x)`, `[a@b](mailto:a@b)`) |
| F8 | `~~~` code fences, longer backtick fences | ```` ``` ````; code holding a backtick fence line takes `~~~` |
| F9 | Component fences with extra colons | Outermost fence `::`; each nested fence indented by two spaces and one colon longer |
| F10 | Table decoration: alignment colons (`:---:`), unpadded cells | Cells padded to the column width, separators as wide. Alignment is **dropped** — the editor schema has no cell-alignment attribute |
| F11 | Blank-line runs between blocks | Exactly one blank line |
| F12 | Trailing newline at end of document | None — the serializer ends at the last block |
| F13 | `\"` escapes inside a component prop (`title="He said \"hi\""`) | Single-quoted (`title='He said "hi"'`); the editor attribute holds the plain `"` |
| F14 | Unquoted and single-quoted component prop values (`{type=warning}`, `{type='warning'}`) | Double-quoted (`{type="warning"}`), single-quoted when the value holds a `"`. All props stay on the fence line, however many there are |
| F15 | Inline `<strong>`, `<em>`, `<del>`, with or without attributes, any case | `**…**`, `*…*`, `~~…~~` where the delimiter flanks (CommonMark). Where it would not — at punctuation inside a word, `a<strong>(b)</strong>`, `<strong>foo.</strong>bar`, a run joining a nested mark's delimiters (`**a*b***<em>c</em>`) — the tag: the delimiter form would read back as literal text. An unclosed tag marks the rest of its block, as the read page shows it |
| F16 | Inline `<a href>` with an allowed URL; a link title | `[text](href)`; a title as `{title="…"}` after the link. A disallowed scheme (`javascript:`) strips to its text (L1) |
| F17 | A list item's paragraph tight after a nested block (`- a\n  ## H\n  b`) | A blank line before the paragraph — as F4, looseness never reaches the editor |
| F18 | `text{#id}` on a paragraph or heading | `text {#id}` — comark reads both as the block's id |
| F19 | Spaces and tabs at a textblock's edge, at a line start or around a hard break | Dropped: the parser drops them or, from a tab or four spaces on, reads the line as code |
| F20 | Empty paragraphs | A line holding one no-break space (U+00A0), between blocks and inside a quote or callout. The empty paragraphs a document opens on, and those a document or a container ends on, are not written |
| F21 | Code fence line ranges (`{1-3}`) | Listed (`{1,2,3}`): comark expands the range. The rest of the info string (`[file.ts]`, `title`) is kept |
| F22 | A link or image destination holding `(`, `)`, whitespace, `<` or `>` | In angle brackets (`[t](</a)b>)`). A space, `<` and `>` read back percent-encoded (`%20`, `%3C`, `%3E`) |
| F23 | A relative link whose text is its href (`[/foo](/foo)`) | Kept as an inline link: the angle form `</foo>` is an HTML tag |
| F24 | Text that comark's parser reads as attributes (`JSON {"a": 1}`, `x {1}`) | The `{` backslash-escaped. `{{` and `${` stay as typed |
| F25 | Inline code holding a backtick | A fence one backtick longer than its longest run, padded with a space where the code starts or ends on a backtick |
| F26 | Soft-broken lines of a list item's first paragraph | Not indented (lazy continuation); comark reads them as the same paragraph |
| F27 | A component alone in a paragraph, heading or table cell (a lone page link, mention, citation, inline file or file image) | Inline form (`:doc[Page]{nid="7"}`, `:image{…}`), not a block fence: comark picks the fence by text siblings only |

## Structural transforms (content preserved, shape changed)

| # | Input | Output |
|---|---|---|
| T1 | Image inline in a paragraph (`text ![a](/i.png) text`, `text :image{file="…"} text`) | Paragraph split around the image: paragraph / block image / paragraph. The editor's image node is block-level. Whitespace at the split edges is dropped. The paragraph's `{#id}` stays on the last piece, so an image alone on its line (`![a](/i.png) {#b-1}`) keeps the id. Exception: inside a table cell the image stays put |
| T2 | List item whose entire content is a component (`- ::callout…::`, `- ::image{…}`) | Component hoisted out of the list, splitting it; ordered lists keep numbering via `start`. Editor list items must start with a paragraph |

## Lossy transforms

| # | What | Loss |
|---|---|---|
| L1 | Inline raw HTML outside the editor schema (`<kbd>`, `<sup>`, `<abbr>`, …), also opening a paragraph or alone on its own lines around text | Tag dropped, text content kept; a `<br>` alone on its line takes its line break with it. (`<u>`, `<strong>`, `<em>`, `<del>`, `<a href>` are NOT lossy — they map to their marks, see F15, F16) |
| L2 | Block-level raw HTML: CommonMark HTML blocks of types 1–6 (`<div>…</div>`, `<pre>`, `<!-- … -->`, `<?…?>`, CDATA, `<!DOCTYPE>`, …), a tag alone on its line with no text, and the elements the read page drops with their content (`<script>`, `<style>`, `<template>`, `<iframe>`, `<object>`); types 1–5 end at their end marker (`</pre>`, `-->`, `?>`, `>`, `]]>`), the others at the next blank line. Text after a type 2–5 end marker on its line stays; a type 2–5 start with no end marker is paragraph text. Inline comments, PIs, CDATA and declarations drop too | Dropped entirely — the editor has no schema node for it |
| L3 | A mention naming no user (`:mention[a]{uid="x"}`, a uid that is not a number) | Serializes as plain `@label`. A mention with a uid round-trips as `:mention[label]{uid="…"}` |
| L4 | Heading auto-ids (`id="slug"` from comark) | Never stored in the editor; regenerated from text at next parse |
| L5 | Unescaped `data:` URI in an image (`data:image/svg+xml;utf8,<svg …/>`) | Not parsed as a link; the URI content after the comma is lost. Base64 and percent-encoded `data:` URIs round-trip. Agent writes are percent-encoded at the write door (`server/utils/comark-data-uri.ts`), so a body arriving that way carries no such URI; a destination that does not close after its payload is refused with a 422 |
| L6 | A mark around an inline page or file link (`**see :doc[Intro]{nid="7"} here**`, `*:attachment[plan]{file="…"}*`) | The mark splits around the link (`**see**:doc[…]**here**`): the editor's inline links carry no marks |
| L7 | A hard break inside a heading (Shift+Enter in the editor) | Writes as a space: an ATX heading is one line, a break would end it. Breaks at the heading's edges drop with its edge whitespace |
| L8 | A `{#id}` on a nested block (list item, quote line inside a longer quote, table cell), or on a heading other than its own `{#b-…}` id | Dropped: comark reads it as the nested block's attribute, and only top-level blocks are review units. On a quote holding one paragraph, comark reads it as the quote's id, written as `::block{#id}` |
| L9 | A bare `{#id}` line; a component naming nothing (`:image{{…}}`, `:mention[x]{{…}}`) | The line is no block to comark and drops. A file-less, source-less image shows nothing and drops; a mention or page link naming nothing keeps its words |
| L10 | Text that reads as a link: a scheme URL, `www.…`, an email | Written bare; the next load makes it a link |
| L11 | Whitespace at the edge of a bold, italic or strike run (`**bold **` before an inline link) | Dropped: comark trims the mark's content |
| L12 | A table cell opening on `{…}` or `:name` | Written bare; the next load reads attributes or a component and the cell empties |
| L13 | A paragraph line after a soft break that reads as a table delimiter row (`\| --- \| --- \|`) | Written bare; the next load makes a table |
| L14 | A heading ending on a `#` run (`C #`), also after a hard break | Written bare; the next load reads the run as the closing sequence and drops it |
| L15 | A heading after a list item's paragraph | Written on the paragraph's line (`- a## h`); the next load reads one paragraph |
| L16 | A list nested under a marker wider than three characters (`10.`) | Indented by three; the next load moves it out of the item, later blocks become code |
| L17 | An ordered list starting at 0 | Written starting at 1 |
| L18 | An ordered list starting at another number than 1 right after a list item's paragraph | Written on the next line; the next load reads it as the paragraph's text |
| L19 | An empty paragraph inside a list item | Not written |
| L20 | An empty task item | `- [x]` or `- [ ]`; the next load reads a plain bullet item |
| L21 | A `#name` line inside a component | Written bare; the next load reads a slot and the component's content is gone |
| L22 | A hard break in a table cell | Written as spaces; the break is gone |
| L23 | A code block ending on spaces or blank lines | comark trims the code's end |
| L24 | A no-break space (or other whitespace than space and tab) at a paragraph's or heading's edge | Written raw; the parser trims it |
| L25 | A task item's second block | Indented by the whole `- [ ] `; the next load reads code |
| L26 | A list item opening with a multi-line block (code fence, a quote over two lines) | Continuation lines not indented; the block leaves the list and the next item lands inside the fence |
| L27 | An unterminated `<!--` in text | Written bare; our parse plugin `unterminatedComments` (`shared/utils/comark-tree.ts`) reads it back as text, other markdown readers as a comment hiding the rest |
| L28 | A tag that names no HTML, SVG or MathML element (`<agent name>`, `<name>`) in a body written after the conversion, e.g. by an agent over MCP | comark opens an element holding the rest of the page, or of the list item or quote the tag sits in, not only its paragraph. The editor drops that element with all its text. The conversion (`renderStoredBody`) reads such a tag in stored bodies as text and writes it `\<agent name>` |
| L29 | An image inside a link (`[![a](s.png)](https://x)`) | The link drops, the image stays. The conversion names such a page: its brackets differ |
| L30 | Inline HTML inside bold or italic (`**<u>a</u>**`, `*<kbd>a</kbd>*`) | comark's parser closes the tag before its text: the underline is lost, the words keep the outer mark. The read page shows the same |
| L31 | `{…}` right after text (`Data {"a": 1} here`, `Two {.note} here`) | comark reads an attribute list on the text before it; the editor keeps none, so the braces and their content drop. `\{` keeps a literal brace |
| L32 | A `::` component never closed (`::image{…}` with no `::` line) | comark reads the rest of the page as its content; the editor keeps only the component, so the text after it drops |
| L33 | A mark tag (`<u>`, `<strong>`, `<em>`, `<del>`) that its paragraph does not open and close as often | An unpaired opening tag marks the rest of the paragraph (`Use the <em> tag.` → `Use the *tag.*`); an unpaired closing tag drops |
| L34 | A footnote (`[^1]`) and its definition (`[^1]: source`) | The definition drops; the reference stays as text `\[^1\]` |
