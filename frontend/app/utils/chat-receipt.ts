import type { UIMessage } from 'ai'
import type { ToolRun } from '~/utils/chat-answer'

/**
 * What a turn changed, read from its write tools' results — never from the
 * model's text, which can claim a change it did not make. It names no page.
 */
export interface Receipt {
  changed: boolean
  /** Changed block ids, each once, in the order the turn changed them. */
  blocks: string[]
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
  result?: { applied?: { blocks?: unknown, removed?: unknown, fields?: unknown } }
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
  const receipt: Receipt = { changed: false, blocks: [], removed: [], fields: [], created: false }
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
    const applied = (run.output as { outputs?: WriteOutputs } | undefined)?.outputs?.result?.applied
    const removed = stringsOf(applied?.removed)
    appendMissingValues(receipt.blocks, blockIdsOf(applied?.blocks))
    appendMissingValues(receipt.removed, removed)
    receipt.blocks = receipt.blocks.filter(id => !removed.includes(id))
    appendMissingValues(receipt.fields, stringsOf(applied?.fields))
  }
  if (!wrote && !commentTurn) return null
  receipt.changed = receipt.created
    || receipt.blocks.length > 0
    || receipt.removed.length > 0
    || receipt.fields.length > 0
  if (pending && !receipt.changed) return null
  return receipt
}

/** One part of a receipt's summary; `changedBlocks` marks the part about changed blocks. */
export interface ReceiptPart {
  text: string
  changedBlocks: boolean
}

/** What changed, in parts: "1 block changed", "1 block removed", "2 fields changed". */
export function receiptParts(receipt: Receipt): ReceiptPart[] {
  const parts: ReceiptPart[] = []
  if (receipt.created) parts.push({ text: 'Page created', changedBlocks: false })
  if (receipt.blocks.length) {
    parts.push({ text: `${countOf(receipt.blocks.length, 'block')} changed`, changedBlocks: true })
  }
  if (receipt.removed.length) {
    parts.push({ text: `${countOf(receipt.removed.length, 'block')} removed`, changedBlocks: false })
  }
  if (receipt.fields.length) {
    parts.push({ text: `${countOf(receipt.fields.length, 'field')} changed`, changedBlocks: false })
  }
  return parts
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

/**
 * The turn's page's editor at the first changed block, or null when that page
 * is not open now or does not hold the block.
 *
 * @param turnPagePath
 *   The path of the page open when the turn was sent, or null when none was.
 * @param openPagePath
 *   The path of the page open now, or null when none is.
 * @param onPage
 *   Whether the open page holds a block id.
 */
export function receiptHref(
  receipt: Receipt,
  turnPagePath: string | null,
  openPagePath: string | null,
  onPage: (blockId: string) => boolean = blockId => document.getElementById(blockId) !== null,
): string | null {
  const block = receipt.blocks[0]
  if (!turnPagePath || turnPagePath !== openPagePath || !block || !onPage(block)) return null
  return `${openPagePath}?edit#${block}`
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
  /** The path of the page open when the turn was sent. */
  pagePath?: string
}

/** The metadata of a reader's message. */
export function turnMetadata(commentTurn: boolean, pagePath: string | null): TurnMetadata {
  return {
    ...(commentTurn ? { commentTurn: true } : {}),
    ...(pagePath ? { pagePath } : {}),
  }
}

/** Whether a message was sent from a comment thread. */
export function isCommentTurn(message: UIMessage): boolean {
  return (message.metadata as TurnMetadata | undefined)?.commentTurn === true
}

/** The path of the page open when a message was sent, or null when none was. */
export function turnPagePathOf(message: UIMessage): string | null {
  const pagePath = (message.metadata as TurnMetadata | undefined)?.pagePath
  return typeof pagePath === 'string' ? pagePath : null
}
