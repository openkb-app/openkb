import type { UIMessage } from 'ai'
import type { ToolRun } from '~/utils/chat-answer'

/** The blocks a turn changed on one page. */
export interface ChangedPage {
  /** The node id the write result names, or null when it names none. */
  nid: number | null
  /** Changed block ids, each once, in the order the turn changed them. */
  blocks: string[]
}

/**
 * What a turn changed, read from its write tools' results — never from the
 * model's text, which can claim a change it did not make. It names no page.
 */
export interface Receipt {
  changed: boolean
  /** The pages with changed blocks, in the order the turn changed them. */
  pages: ChangedPage[]
  /** Removed block ids, each once. */
  removed: string[]
  /** Changed field keys, each once. */
  fields: string[]
  created: boolean
}

const CREATE_PAGE = 'tool__openkb_create_page'

/** The tools whose run makes a receipt. A reply in a comment thread is not one. */
const WRITE_TOOLS = new Set([
  'tool__openkb_update_blocks',
  'tool__openkb_update_fields',
  CREATE_PAGE,
])

/**
 * What a write tool's result holds, as the Tool API bridge answers it.
 * The shape is not checked upstream.
 */
interface WriteOutputs {
  result?: { nid?: unknown, applied?: { blocks?: unknown, removed?: unknown, fields?: unknown } }
}

/**
 * The turn's one receipt, summing every write tool's result.
 *
 * - A failed write, or one that changed nothing, adds nothing.
 * - A comment turn that ran no write tool gets a "Nothing changed" receipt.
 * - A turn without either gets none.
 * - While a write still runs, a receipt without a change is none yet.
 */
export function receiptForToolRuns(runs: ToolRun[], commentTurn = false): Receipt | null {
  const receipt: Receipt = { changed: false, pages: [], removed: [], fields: [], created: false }
  let wrote = false
  let pending = false
  for (const run of runs) {
    if (!WRITE_TOOLS.has(run.name)) continue
    if (run.running) {
      pending = true
      continue
    }
    wrote = true
    if (run.failed) continue
    if (run.name === CREATE_PAGE) receipt.created = true
    const result = (run.output as { outputs?: WriteOutputs } | undefined)?.outputs?.result
    const applied = result?.applied
    const removed = stringsOf(applied?.removed)
    const page = changedPageOf(receipt.pages, nidOf(result?.nid))
    appendMissingValues(page.blocks, blockIdsOf(applied?.blocks))
    appendMissingValues(receipt.removed, removed)
    page.blocks = page.blocks.filter(id => !removed.includes(id))
    appendMissingValues(receipt.fields, stringsOf(applied?.fields))
  }
  if (!wrote && !commentTurn) return null
  receipt.pages = receipt.pages.filter(page => page.blocks.length > 0)
  receipt.changed = receipt.created
    || receipt.pages.length > 0
    || receipt.removed.length > 0
    || receipt.fields.length > 0
  if (pending && !receipt.changed) return null
  return receipt
}

/** One part of a receipt's summary, and where it links to, if anywhere. */
export interface ReceiptPart {
  text: string
  href: string | null
}

/**
 * What changed, in parts: "1 block changed", "1 block removed", "2 fields changed".
 *
 * Changed blocks get one part per page, linking to the editor at the page's
 * first changed block.
 */
export function receiptParts(receipt: Receipt): ReceiptPart[] {
  const parts: ReceiptPart[] = []
  if (receipt.created) parts.push({ text: 'Page created', href: null })
  for (const page of receipt.pages) {
    parts.push({ text: `${countOf(page.blocks.length, 'block')} changed`, href: changedBlockHref(page) })
  }
  if (receipt.removed.length) {
    parts.push({ text: `${countOf(receipt.removed.length, 'block')} removed`, href: null })
  }
  if (receipt.fields.length) {
    parts.push({ text: `${countOf(receipt.fields.length, 'field')} changed`, href: null })
  }
  return parts
}

/** The editor of a page at its first changed block, or null without a node id. */
function changedBlockHref(page: ChangedPage): string | null {
  if (page.nid === null || !page.blocks[0]) return null
  return `/node/${page.nid}/edit#${page.blocks[0]}`
}

/** What changed, in a few words: "1 block changed, 1 block removed, 2 fields changed". */
export function receiptSummary(receipt: Receipt): string {
  return receiptParts(receipt).map(part => part.text).join(', ')
}

/** "1 block", "2 blocks". */
function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** The receipt in one line to be heard: "Changed: 1 block changed." or "Nothing changed." */
export function announceReceipt(receipt: Receipt): string {
  return receipt.changed ? `Changed: ${receiptSummary(receipt)}.` : 'Nothing changed.'
}

/** The strings of a list, or none when the value is no list. */
function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter(item => typeof item === 'string')
}

/** The block ids of an id → version map, or none when the value is no map. */
function blockIdsOf(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  return Object.keys(value)
}

/** A positive node id, or null for any other value. */
function nidOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

/** The receipt's entry for a page, added when the turn had none yet. */
function changedPageOf(pages: ChangedPage[], nid: number | null): ChangedPage {
  let page = pages.find(entry => entry.nid === nid)
  if (!page) {
    page = { nid, blocks: [] }
    pages.push(page)
  }
  return page
}

/** Appends the values `list` does not hold yet. */
function appendMissingValues(list: string[], values: string[]): void {
  for (const value of values) {
    if (!list.includes(value)) list.push(value)
  }
}

/** What a reader's message holds about its turn. */
export interface TurnMetadata {
  /** Sent from a comment thread. */
  commentTurn?: true
}

/** The metadata of a reader's message. */
export function turnMetadata(commentTurn: boolean): TurnMetadata {
  return commentTurn ? { commentTurn: true } : {}
}

/** Whether a message was sent from a comment thread. */
export function isCommentTurn(message: UIMessage): boolean {
  return (message.metadata as TurnMetadata | undefined)?.commentTurn === true
}

