import { citationsByBlock, markdownToTree, type AllowedHtml, type CitationSource } from '#shared/utils/comark-tree'
import { highlightToTokens } from '#shared/utils/code-highlight'
import { resolveFileUuids } from './files'
import { ceFileLists } from './commit-files'
import type { PageAttachment, ResolvedFile } from '#shared/utils/files'
import { resolveCiteNids, resolveDocNids } from './doc-links'
import { blockByline, hasRecord, parseBlockMeta, type BlockByline } from '#shared/page-blocks'

/**
 * The custom_elements `raw` formatter emits a text_long field as the full
 * field-item assoc — for our markdown body that's `{value, format, processed}`.
 * We only ever consume `.value`. The other keys are Drupal-rendered noise
 * that gets dropped from the response.
 */
interface RawBodyValue {
  value?: string
}

export interface CePage {
  content?: {
    element?: string
    props?: {
      body?: RawBodyValue | string
      blockMeta?: RawBodyValue | string
      blockProvenance?: Record<string, BlockByline>
      blockCitations?: Record<string, CitationSource[]>
      pageFiles?: PageAttachment[]
    } & Record<string, unknown>
    slots?: Record<string, unknown[]>
  } & Record<string, unknown>
  [k: string]: unknown
}

/**
 * The read page's attachments: `field_kb_attachments` in field order, then the
 * files the text embeds as `::attachment` that the field lacks. Only what this
 * reader may download. A file's description is its first embed's.
 */
function pageAttachments(
  fieldIds: string[],
  bodyTree: unknown,
  resolved: Record<string, ResolvedFile>,
): PageAttachment[] {
  const embedded: string[] = []
  const descriptions: Record<string, string> = {}
  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) return
    const [tag, props, ...children] = node as [unknown, Record<string, unknown> | undefined, ...unknown[]]
    if (tag === 'attachment' && typeof props?.file === 'string') {
      embedded.push(props.file)
      if (typeof props.description === 'string' && props.description) descriptions[props.file] ??= props.description
    }
    children.forEach(walk)
  }
  ;(bodyTree as unknown[]).forEach(walk)
  return [...new Set([...fieldIds, ...embedded])]
    .flatMap(id => resolved[id] ? [{ id, ...resolved[id], description: descriptions[id] ?? null }] : [])
}

/** A `raw`-formatted string field arrives as the field-item assoc, or bare. */
function rawValue(field: RawBodyValue | string | undefined): string | null {
  if (typeof field === 'string') return field
  return typeof field?.value === 'string' ? field.value : null
}

/**
 * The review sidecar (`field_block_meta`) as the read page consumes it: block
 * id → ordered contributors, and the review each block owes or has had.
 *
 * The stored JSON is the accounting model — an unordered contributor list and
 * flags keyed per step. The page wants the
 * derivation, and deriving it once here keeps it on one implementation shared
 * with the editor rather than a second one in a component.
 *
 * The flags travel verbatim. There is nothing for this layer to work out about
 * them: a sign-off that content moved under was dropped by the write that
 * moved it, so what Drupal stored is already the truth about the block as it
 * reads now.
 */
export function blockProvenanceFrom(raw: string | null): Record<string, BlockByline> {
  const map = parseBlockMeta(raw)
  const out: Record<string, BlockByline> = {}
  for (const [id, block] of Object.entries(map)) {
    const byline = blockByline(block)
    // A block whose entry survives the sweep but attributes nobody and owes
    // nothing has no byline to render — do not ship an empty one.
    if (!hasRecord(byline)) continue
    out[id] = byline
  }
  return out
}

/**
 * If the CE-API response represents a kb_page, parse the raw markdown
 * carried on `content.props.body.value` with comark and splice the resulting
 * comark tree onto `content.props.bodyTree`, which the page renders through
 * `@comark/vue`. Drop the whole `body` prop once consumed — the page only
 * needs the tree.
 *
 * Page-file embeds (`::image{file="…"}`, `::attachment{file="…"}`) resolve
 * server-side: the tree passes batch file UUIDs through one lookup and splice
 * file URLs onto the nodes, so the read page needs no client-side fetch. The
 * request's auth carrier (session cookie or agent Bearer token) is forwarded
 * so access respects the reader's; an unresolvable UUID renders as a
 * placeholder (no src).
 *
 * What the tree may carry is the body text format's to say: `allowedHtml`
 * comes from the caller (`bodyAllowedHtml()`), which reads it off the schema
 * endpoint through the shared cache.
 *
 * Document links (`:doc[Label]{nid="…"}`) resolve the same way and under the
 * same carrier, so the rendering is per reader: the live title for a reader
 * who may see the target, the stored label and a 404 address for one who may
 * not (server/utils/doc-links.ts). Not cached: the markdown Drupal ships is
 * reader-independent, and the resolution runs here, once per request.
 *
 * Citations (`:citation{nid="…" block="…" v="…"}`) resolve beside them, with the
 * cited pages' current block versions, so the chip says whether the source
 * still reads as it did when it was cited. Each block's own sources leave as
 * `content.props.blockCitations`, a projection of the resolved tree.
 *
 * The block-provenance sidecar rides along the same way: `field_block_meta`
 * arrives as raw JSON on `content.props.blockMeta` and leaves as the derived
 * `content.props.blockProvenance`, keyed by the `id="b-…"` the rendered tree
 * already carries on each block. The raw prop is dropped once consumed.
 *
 * Any other response is returned untouched.
 */
export async function enrichCePage(
  page: CePage,
  auth: Record<string, string> = {},
  allowedHtml?: AllowedHtml,
): Promise<CePage> {
  const content = page?.content
  if (!content || content.element !== 'node-kb-page') return page
  const markdown = rawValue(content.props?.body)
  if (markdown === null || markdown.trim() === '') return page
  // One file lookup for the text and the field: the tree asks first, the
  // field's files it did not name are asked for after.
  const files: Record<string, ResolvedFile> = {}
  const fieldIds = ceFileLists(content.props ?? {}).attachments
  const bodyTree = await markdownToTree(markdown, {
    resolveFiles: async uuids => Object.assign(files, await resolveFileUuids(auth, uuids)),
    resolveDocs: nids => resolveDocNids(auth, nids),
    resolveCites: nids => resolveCiteNids(auth, nids),
    allowedHtml,
    highlightCode: highlightToTokens,
    blockLinks: true,
  })
  const asked = new Set(Object.keys(files))
  const rest = fieldIds.filter(id => !asked.has(id))
  if (rest.length > 0) Object.assign(files, await resolveFileUuids(auth, rest))
  const pageFiles = pageAttachments(fieldIds, bodyTree, files)
  const blockCitations = citationsByBlock(bodyTree)
  // The raw file lists are consumed into `pageFiles` and `::image{file}`.
  const { body: _drop, blockMeta: _dropMeta, attachments: _files, images: _images, ...restProps } = content.props ?? {}
  const blockProvenance = blockProvenanceFrom(rawValue(content.props?.blockMeta))
  return {
    ...page,
    content: {
      ...content,
      props: {
        ...restProps,
        // Omitted entirely when nothing is attributed, so a page with no
        // provenance ships no empty object to every reader.
        ...(Object.keys(blockProvenance).length > 0 ? { blockProvenance } : {}),
        // Likewise omitted where the page cites nothing.
        ...(Object.keys(blockCitations).length > 0 ? { blockCitations } : {}),
        ...(pageFiles.length > 0 ? { pageFiles } : {}),
        bodyTree,
      },
    },
  }
}
