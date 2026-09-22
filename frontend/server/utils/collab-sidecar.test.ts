import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as Y from 'yjs'
import { initProseMirrorDoc, prosemirrorJSONToYDoc } from '@tiptap/y-tiptap'
import { MarkMirror, mirrorReviewFlags } from './collab-sidecar'
import { hydrateLedger, newLedger, type Ledger, type SessionWindow } from './collab-attribution'
import { editorSchema } from './editor-schema'
import { blockMetaRoot, fieldKey, isPending, mayApprove, readBlockMeta, writeBlockMeta } from '#shared/page-blocks'

/** A window as sessionWindow() hands it over — only `blocks` is read here. */
function window(blocks: SessionWindow['blocks']): SessionWindow {
  return { blocks, author: null, coAuthors: [], stated: new Map() }
}

const HUMAN = [{ uid: 3, via: null }]
const AGENT = [{ uid: 9, via: 'Claude' }]

describe('mirrorReviewFlags', () => {
  it('opens the peer step on a block the session has written', () => {
    const doc = new Y.Doc()

    mirrorReviewFlags(doc, window({ 'b-1': HUMAN }))

    expect(readBlockMeta(doc)['b-1']).toEqual({
      contributors: [],
      'pending:peer': { by: [3], ok: [], estimated: true },
    })
  })

  // PageBlocks::stampSession(): a writer carrying a `via` raises the agent
  // step as well, and only those writers are in its baseline.
  it('raises the agent step for an agent writer, and only for them', () => {
    const doc = new Y.Doc()

    mirrorReviewFlags(doc, window({ 'b-1': [...HUMAN, ...AGENT] }))

    expect(readBlockMeta(doc)['b-1']).toMatchObject({
      'pending:peer': { by: [3, 9], estimated: true },
      'pending:agent': { by: [9], estimated: true },
    })
  })

  it('widens the baseline Drupal stored, and drops the approvals the edit outdates', () => {
    const doc = new Y.Doc()
    writeBlockMeta(doc, {
      'b-1': { contributors: [], 'pending:peer': { by: [7], ok: [{ uid: 4, name: 'ada', at: 1, vid: 2 }] } },
    })

    mirrorReviewFlags(doc, window({ 'b-1': HUMAN }))

    expect(readBlockMeta(doc)['b-1']!['pending:peer']).toEqual({ by: [7, 3], ok: [], estimated: true })
  })

  it('writes nothing at all when the estimate already stands', () => {
    const doc = new Y.Doc()
    mirrorReviewFlags(doc, window({ 'b-1': HUMAN }))
    const before = Y.encodeStateVector(doc)

    mirrorReviewFlags(doc, window({ 'b-1': HUMAN }))

    expect(Y.encodeStateVector(doc)).toEqual(before)
  })

  // An edit taken back leaves the window; the mark it earned has to leave too.
  it('drops its own estimate for a block that has left the window', () => {
    const doc = new Y.Doc()
    mirrorReviewFlags(doc, window({ 'b-1': HUMAN, 'b-2': HUMAN }))

    mirrorReviewFlags(doc, window({ 'b-2': HUMAN }))

    expect(readBlockMeta(doc)['b-1']).toBeUndefined()
    expect(readBlockMeta(doc)['b-2']).toBeDefined()
  })

  // The estimate is this server's; a stored flag is Drupal's and outlives any
  // window, or an untouched block would lose the review it still owes.
  it('leaves a witnessed flag alone', () => {
    const doc = new Y.Doc()
    writeBlockMeta(doc, { 'b-1': { contributors: [], 'pending:peer': { by: [7], ok: [] } } })

    mirrorReviewFlags(doc, window({}))

    expect(readBlockMeta(doc)['b-1']!['pending:peer']).toEqual({ by: [7], ok: [] })
  })

  // The whole point of writing into the sidecar rather than beside it: the
  // checkpoint's re-read aligns the map to exactly what Drupal stores.
  it('is replaced whole by Drupal\'s answer', () => {
    const doc = new Y.Doc()
    mirrorReviewFlags(doc, window({ 'b-1': HUMAN, 'b-2': HUMAN }))

    writeBlockMeta(doc, { 'b-1': { contributors: [], 'pending:peer': { by: [3], ok: [] } } })

    expect(readBlockMeta(doc)['b-1']!['pending:peer']).toEqual({ by: [3], ok: [] })
    expect(readBlockMeta(doc)['b-2']).toBeUndefined()
  })

  // A block whose entry a pre-split session left whole still has its baseline
  // read; the estimate is written as a field, which readBlockMeta prefers.
  it('reads a baseline out of a whole-block entry', () => {
    const doc = new Y.Doc()
    blockMetaRoot(doc).set('b-1', { contributors: [], 'pending:peer': { by: [7], ok: [] } })

    mirrorReviewFlags(doc, window({ 'b-1': HUMAN }))

    expect(readBlockMeta(doc)['b-1']!['pending:peer']).toEqual({ by: [7, 3], ok: [], estimated: true })
  })

  // The baseline it writes is the writer set this server witnessed, so the
  // four-eyes rule reads the same answer off it as off Drupal's own flag.
  it('writes a baseline four-eyes holds on', () => {
    const doc = new Y.Doc()
    mirrorReviewFlags(doc, window({ 'b-1': HUMAN }))
    const block = readBlockMeta(doc)['b-1']

    expect(mayApprove(block, 'peer', { uid: 7, isAdmin: false }), 'a peer may sign it off').toBe(true)
    expect(mayApprove(block, 'peer', { uid: 3, isAdmin: false }), 'its sole writer may not').toBe(false)
    expect(mayApprove(block, 'agent', { uid: 7, isAdmin: false }), 'no agent step is owed').toBe(false)
  })

  it('writes the whole pass in one transaction', () => {
    const doc = new Y.Doc()
    let updates = 0
    doc.on('update', () => { updates++ })

    mirrorReviewFlags(doc, window({ 'b-1': HUMAN, 'b-2': HUMAN, 'b-3': AGENT }))

    expect(updates).toBe(1)
  })
})

/**
 * The defect this closes: `blockMeta` had exactly ONE writer in the whole
 * server tree — `writeBlockMeta`, reached only from `seedBlockMeta`, which
 * copies Drupal's stored field. No review flag ever reached a live session, so
 * a mark could not appear before a checkpoint had been to Drupal and back.
 *
 * These pin the invariant that closes it — an edit in a live session puts the
 * flag in that session's sidecar — and deliberately not the timing, which is a
 * tunable. Nothing here commits, checkpoints or reaches Drupal: a `commit` seam
 * does not exist in this module, and the ledger is driven by transactions
 * alone.
 */
describe('MarkMirror', () => {
  const DOC = 'node:7'

  /** A document of two identified blocks, hydrated the way a session is. */
  function session() {
    const doc = prosemirrorJSONToYDoc(editorSchema, {
      type: 'doc',
      content: ['b-1', 'b-2'].map(id => ({
        type: 'paragraph',
        attrs: { id },
        content: [{ type: 'text', text: 'Written earlier.' }],
      })),
    } as never, 'default')
    const ledger = newLedger()
    hydrateLedger(ledger, initProseMirrorDoc(doc.getXmlFragment('default'), editorSchema).doc)
    ledger.peers.set(3, { uid: 3, name: 'ada' })
    return { doc, ledger }
  }

  /** One peer's write, carrying the origin a real connection's update carries. */
  function typeInto(doc: Y.Doc, ledger: Ledger, block: number, text: string, uid = 3): void {
    ledger.writer = { uid, via: null }
    const origin = { source: 'connection', connection: { context: { user: { uid } } } }
    const para = doc.getXmlFragment('default').get(block) as Y.XmlElement
    doc.transact(() => { (para.get(0) as Y.XmlText).insert(0, text) }, origin)
  }

  /** The empty paragraph the editor keeps at the end, once it has an id. */
  function appendEmptyParagraph(doc: Y.Doc, ledger: Ledger, id: string, uid = 3): void {
    ledger.writer = { uid, via: null }
    const origin = { source: 'connection', connection: { context: { user: { uid } } } }
    const fragment = doc.getXmlFragment('default')
    doc.transact(() => {
      const para = new Y.XmlElement('paragraph')
      para.setAttribute('id', id)
      fragment.insert(fragment.length, [para])
    }, origin)
  }

  function mirror(doc: Y.Doc, ledger: Ledger, throttleMs = 1000) {
    return new MarkMirror({
      throttleMs,
      document: name => (name === DOC ? doc : null),
      ledger: name => (name === DOC ? ledger : null),
    })
  }

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  // The regression itself. Red before the mirror existed: no checkpoint runs
  // here, so the sidecar stayed empty however long you waited.
  it('puts an edit\'s flag in the live sidecar with no checkpoint', () => {
    const { doc, ledger } = session()
    const marks = mirror(doc, ledger)

    typeInto(doc, ledger, 0, 'More. ')
    marks.schedule(DOC)
    expect(readBlockMeta(doc)['b-1'], 'nothing may be written inside the transaction').toBeUndefined()

    vi.advanceTimersByTime(0)

    expect(readBlockMeta(doc)['b-1']!['pending:peer']).toEqual({ by: [3], ok: [], estimated: true })
    expect(readBlockMeta(doc)['b-2'], 'a block nobody touched owes nothing new').toBeUndefined()
  })

  // The editor keeps an empty paragraph after a block that is not one, and the
  // id tracker gives it an id as soon as anything is written. Drupal's
  // segmentation drops the empty chunk, so a flag on it would name a blocker
  // no publish gate can ever clear.
  it('draws no mark on the empty block the editor keeps at the end', () => {
    const { doc, ledger } = session()
    const marks = mirror(doc, ledger)

    typeInto(doc, ledger, 0, 'More. ')
    appendEmptyParagraph(doc, ledger, 'b-trailing')
    marks.schedule(DOC)
    vi.advanceTimersByTime(0)

    expect(readBlockMeta(doc)['b-trailing']).toBeUndefined()
    expect(readBlockMeta(doc)['b-1']!['pending:peer']).toEqual({ by: [3], ok: [], estimated: true })
  })

  // The mark is the peer's to act on the moment it appears, and it is theirs
  // by the same rule Drupal applies: uid 3 typed, so uid 9 is the second pair
  // of eyes and uid 3 is not.
  it('draws a mark the peer may sign off, and its writer may not', () => {
    const { doc, ledger } = session()
    const marks = mirror(doc, ledger)

    typeInto(doc, ledger, 0, 'More. ')
    marks.schedule(DOC)
    vi.advanceTimersByTime(0)

    const block = readBlockMeta(doc)['b-1']
    expect(isPending(block, 'peer'), 'the mark is drawn').toBe(true)
    expect(block!['pending:peer']!.estimated, 'and says it is an estimate').toBe(true)
    expect(mayApprove(block, 'peer', { uid: 9, isAdmin: false }), 'a peer may sign it off').toBe(true)
    expect(mayApprove(block, 'peer', { uid: 3, isAdmin: false }), 'its writer may not').toBe(false)
  })

  // Drupal's answer stands in the estimate's place at the checkpoint, and the
  // sign-off it offers is the same one.
  it('gives way to Drupal\'s answer', () => {
    const { doc, ledger } = session()
    const marks = mirror(doc, ledger)
    typeInto(doc, ledger, 0, 'More. ')
    marks.schedule(DOC)
    vi.advanceTimersByTime(0)

    // What syncSidecarFromDrupal does with the sidecar a checkpoint just wrote.
    writeBlockMeta(doc, { 'b-1': { contributors: [], 'pending:peer': { by: [3], ok: [] } } })

    const block = readBlockMeta(doc)['b-1']
    expect(block!['pending:peer']!.estimated, 'the estimate is gone').toBeUndefined()
    expect(mayApprove(block, 'peer', { uid: 9, isAdmin: false })).toBe(true)
  })

  // Leading edge: the first write of a burst does not wait out the interval.
  it('mirrors the first write of a burst on the next tick', () => {
    const { doc, ledger } = session()
    const marks = mirror(doc, ledger, 60_000)

    typeInto(doc, ledger, 0, 'More. ')
    marks.schedule(DOC)
    vi.advanceTimersByTime(0)

    expect(isPending(readBlockMeta(doc)['b-1'], 'peer')).toBe(true)
  })

  // ...and the rest of the burst coalesces, which is what bounds the cost: a
  // pass is proportional to document size, not to what moved.
  it('runs one pass per interval however fast the burst is', () => {
    const { doc, ledger } = session()
    const marks = mirror(doc, ledger)
    let passes = 0
    doc.getMap('blockMeta').observe(() => { passes++ })

    for (let i = 0; i < 40; i++) {
      typeInto(doc, ledger, i % 2, 'x')
      marks.schedule(DOC)
      vi.advanceTimersByTime(25)
    }

    // 1 s of typing: the leading edge, then one more at the interval's end.
    expect(passes).toBe(2)
    expect(isPending(readBlockMeta(doc)['b-1'], 'peer')).toBe(true)
    expect(isPending(readBlockMeta(doc)['b-2'], 'peer')).toBe(true)
  })

  it('draws nothing for a document that has gone, or one not yet hydrated', () => {
    const { doc, ledger } = session()
    typeInto(doc, ledger, 0, 'More. ')

    new MarkMirror({ throttleMs: 1000, document: () => null, ledger: () => ledger }).run(DOC)
    ledger.hydrated = false
    mirror(doc, ledger).run(DOC)

    expect(readBlockMeta(doc)).toEqual({})
  })

  it('drops a stopped document\'s pending pass', () => {
    const { doc, ledger } = session()
    const marks = mirror(doc, ledger)

    typeInto(doc, ledger, 0, 'More. ')
    marks.schedule(DOC)
    marks.stopAll()
    vi.advanceTimersByTime(60_000)

    expect(readBlockMeta(doc)).toEqual({})
  })
})
