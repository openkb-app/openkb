import { createHash } from 'node:crypto'
import { serializeCommitJSON, type ProseMirrorJSON } from './commit'
import { parseMarkdownToDoc } from '../../app/comark/markdown-engine'

/**
 * Block versions — what a block's content is, as one short string.
 *
 * A version is the hash of the block's canonical markdown, and there is no
 * storage behind it: `getPageForEditing` derives one per block from the body
 * it serves,
 * `updateBlocks` derives one per block from the live document. Because both
 * derive rather than look up, a version can never be stale in the way a stored
 * counter can, and the two sides can never disagree about what a block holds.
 *
 * Everything here hashes canonical markdown — what a commit would write, from
 * the same parse, transforms and serializer the checkpoint uses
 * (server/utils/commit.ts). Comark has one spelling for any given content, so a
 * body Drupal stores in some older spelling versions identically to the
 * document a session holds for it. Hashing raw bytes instead would report a
 * block as changed the moment a session canonicalized it, with nobody having
 * edited anything.
 *
 * Neither entry point parses: the caller arrives with the canonical form
 * already in hand — a serialized document for {@link blockSegmentsOfDoc}, the
 * body a read just canonicalized for {@link blockSegments} (the `canonical`
 * half of server/utils/kb-read.ts's read body).
 *
 * Segmentation mirrors `\Drupal\openkb_workflow\PageBlocks::segment()`: the
 * body split on blank lines outside code and component fences, each chunk keyed
 * by the id it carries. The two never share code, and neither needs to — the
 * only syntax either knows is where a block ends and where its id sits.
 */

/** Hex characters of the sha256 a version carries. */
const VERSION_LENGTH = 12

/** A trailing `{#id}` on a text block, after a space or tab or as its whole text. */
const TRAILING_ID = /(?:^|[ \t])\{#([\w-]+)\}\s*$/

/** The `#id` shorthand closing a component fence's prop list. */
const FENCE_ID = /#([\w-]+)\}\s*$/

/** A code fence's opening or closing run: three or more backticks or tildes. */
const CODE_FENCE = /^\s*(`{3,}|~{3,})/

/**
 * The body's top-level chunks, blank-line separated.
 *
 * A blank line inside a code fence or a component fence separates nothing — the
 * block continues — so both are tracked while splitting.
 */
function chunks(markdown: string): string[] {
  const out: string[] = []
  let current: string[] = []
  const fences: number[] = []
  let code: string | null = null

  for (const line of markdown.split(/\r\n|[\r\n]/)) {
    const codeFence = CODE_FENCE.exec(line)?.[1]
    if (code === null && codeFence) {
      code = codeFence
    }
    else if (code !== null) {
      if (codeFence && codeFence[0] === code[0] && codeFence.length >= code.length && line.trim() === codeFence) code = null
    }
    else {
      // A colon run with a name opens a fence; a bare one closes the innermost
      // fence opened with the same run length.
      const fence = /^(:{2,})(\S+)?/.exec(line)
      if (fence && fence[2]) fences.push(fence[1]!.length)
      else if (fence && fences.at(-1) === fence[1]!.length) fences.pop()
    }

    if (line.trim() === '' && code === null && fences.length === 0) {
      out.push(current.join('\n'))
      current = []
      continue
    }
    current.push(line)
  }
  out.push(current.join('\n'))

  return out.map(chunk => chunk.trim()).filter(chunk => chunk !== '')
}

/** The block id a chunk carries, or null when it bears none. */
function idOf(chunk: string): string | null {
  const trailing = TRAILING_ID.exec(chunk)
  if (trailing) return trailing[1]!
  if (!chunk.startsWith('::')) return null
  const fence = FENCE_ID.exec(chunk.split('\n', 1)[0] ?? '')
  return fence ? fence[1]! : null
}

/**
 * Block id → the block's markdown, in document order: canonical markdown keyed
 * by the ids it carries.
 */
export function blockSegments(canonical: string): Map<string, string> {
  const blocks = new Map<string, string>()
  for (const chunk of chunks(canonical)) {
    const id = idOf(chunk)
    // A block with no id is unaddressable: no op can name it, so no op can
    // expect a version for it.
    if (id !== null) blocks.set(id, chunk)
  }
  return blocks
}

/**
 * The same, for a document tree in hand — the live session's, mid-write.
 *
 * Serialized the way a checkpoint would, so what comes out is the body a read
 * of this document serves, spelled canonically.
 */
export async function blockSegmentsOfDoc(json: ProseMirrorJSON): Promise<Map<string, string>> {
  return blockSegments(await serializeCommitJSON(json))
}

/** A block's version — the short content hash of its canonical markdown. */
export function blockVersion(segment: string): string {
  return createHash('sha256').update(segment).digest('hex').slice(0, VERSION_LENGTH)
}

/** Block id → version: the `versions` map `getPageForEditing` serves. */
export function blockVersions(canonical: string): Record<string, string> {
  return Object.fromEntries(
    [...blockSegments(canonical)].map(([id, markdown]) => [id, blockVersion(markdown)]),
  )
}

/** The ids of the blocks `after` adds, changes or removes against `before`. */
export function changedBlockIds(before: string, after: string): string[] {
  const old = blockSegments(before)
  const next = blockSegments(after)
  const changed = [...next].filter(([id, markdown]) => old.get(id) !== markdown).map(([id]) => id)
  const removed = [...old.keys()].filter(id => !next.has(id))
  return [...changed, ...removed]
}

/**
 * The body to write, with each block nobody edited in Drupal's stored bytes.
 *
 * The serializer has one spelling, so a block stored in another one would get
 * new bytes, and a new version, at every checkpoint. Keeping the stored bytes
 * where they read as exactly the written block keeps its version, and with it
 * its review state and history (ADR 0024).
 *
 * Stored bytes go back only where the body still reads as written, both to
 * comark and to Drupal's segmentation: an unclosed callout would take in the
 * block after it. All re-spelled blocks are tried together first; when they
 * do not fit, each is tried on its own.
 *
 * @param stored Drupal's body, title heading off.
 * @param written The canonical body the checkpoint serialized, title heading off.
 */
export async function keepStoredSpellingOfUntouchedBlocks(stored: string, written: string): Promise<string> {
  const respelled = await respelledUntouchedBlocks(stored, written)
  if (respelled.length === 0) return written
  const all = spliceStoredBytes(written, respelled)
  if (await readsAsWritten(all, written, respelled)) return all
  let body = written
  for (const block of respelled) {
    const next = spliceStoredBytes(body, [block])
    if (await readsAsWritten(next, written, respelled)) body = next
  }
  return body
}

/** A block's canonical markdown and its stored bytes. */
interface RespelledBlock {
  markdown: string
  stored: string
}

/** The written blocks whose stored bytes differ but read, on their own, as the same block. */
async function respelledUntouchedBlocks(stored: string, written: string): Promise<RespelledBlock[]> {
  const before = blockSegments(stored)
  const respelled: RespelledBlock[] = []
  for (const [id, markdown] of blockSegments(written)) {
    const old = before.get(id)
    if (old === undefined || old === markdown) continue
    // A block leaning on text elsewhere, such as a link reference definition,
    // must not be put back without it.
    if (await canonicalMarkdown(old) !== markdown) continue
    respelled.push({ markdown, stored: old })
  }
  return respelled
}

/** The body with each block's markdown replaced by its stored bytes, where it occurs exactly once. */
function spliceStoredBytes(body: string, blocks: RespelledBlock[]): string {
  for (const { markdown, stored } of blocks) {
    const at = body.indexOf(markdown)
    if (at === -1 || body.indexOf(markdown, at + 1) !== -1) continue
    body = body.slice(0, at) + stored + body.slice(at + markdown.length)
  }
  return body
}

/**
 * Whether a spliced body reads as the written one.
 *
 * - comark reads it as the written body;
 * - Drupal's segmentation finds the written chunks in the same order, each
 *   as written or as that block's stored bytes.
 */
async function readsAsWritten(body: string, written: string, respelled: RespelledBlock[]): Promise<boolean> {
  const spliced = chunks(body)
  const expected = chunks(written)
  if (spliced.length !== expected.length) return false
  const storedOf = new Map(respelled.map(block => [block.markdown, block.stored]))
  const sameChunks = spliced.every((chunk, at) => chunk === expected[at] || chunk === storedOf.get(expected[at]!))
  return sameChunks && await canonicalMarkdown(body) === written
}

/** Markdown as a checkpoint would write it, or null where it does not parse. */
async function canonicalMarkdown(markdown: string): Promise<string | null> {
  try {
    return await serializeCommitJSON((await parseMarkdownToDoc(markdown)).toJSON() as ProseMirrorJSON)
  }
  catch {
    return null
  }
}
