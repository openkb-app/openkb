import { createHash } from 'node:crypto'
import { serializeCommitJSON, type ProseMirrorJSON } from './commit'

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

/** A trailing `{#id}` on a text block. */
const TRAILING_ID = /\{#([\w-]+)\}\s*$/

/** The `#id` shorthand closing a component fence's prop list. */
const FENCE_ID = /#([\w-]+)\}\s*$/

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
  let code = false

  for (const line of markdown.split(/\r\n|[\r\n]/)) {
    if (/^\s*```/.test(line)) {
      code = !code
    }
    else if (!code) {
      // A colon run with a name opens a fence; a bare one closes the innermost
      // fence opened with the same run length.
      const fence = /^(:{2,})(\S+)?/.exec(line)
      if (fence && fence[2]) fences.push(fence[1]!.length)
      else if (fence && fences.at(-1) === fence[1]!.length) fences.pop()
    }

    if (line.trim() === '' && !code && fences.length === 0) {
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
export function blockSegmentsOfDoc(json: ProseMirrorJSON): Map<string, string> {
  return blockSegments(serializeCommitJSON(json))
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
