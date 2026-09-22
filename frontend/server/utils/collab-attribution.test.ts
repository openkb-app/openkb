import { describe, it, expect } from 'vitest'
import type { Node as PMNode } from '@tiptap/pm/model'
import { editorSchema } from './editor-schema'
import {
  adoptSnapshot,
  ledgerSnapshot,
  blockPrints,
  creditWriter,
  sessionPayload,
  diffTouched,
  dischargeFieldWriters,
  dischargeWindow,
  hydrateLedger,
  isPeerUpdate,
  newLedger,
  reviewActionFrom,
  sessionWindow,
  sharedIdKeepers,
  writerKey,
  writerOfOrigin,
  type Ledger,
} from './collab-attribution'

function para(text: string, id: string | null): PMNode {
  return editorSchema.node('paragraph', { id }, text ? [editorSchema.text(text)] : [])
}
/** The same text, carrying a mark — a formatting-only edit of `para`. */
function strong(text: string, id: string | null): PMNode {
  return editorSchema.node('paragraph', { id }, [editorSchema.text(text, [editorSchema.marks.bold.create()])])
}
function heading(text: string, id: string | null): PMNode {
  return editorSchema.node('heading', { id, level: 2 }, text ? [editorSchema.text(text)] : [])
}
function doc(...blocks: PMNode[]): PMNode {
  return editorSchema.node('doc', null, blocks)
}

const ADA = { uid: 7, name: 'ada' }
const FAGO = { uid: 3, name: 'fago' }
const CLAUDE = 'Claude'

function ledgerWith(...peers: Array<typeof ADA>): Ledger {
  const ledger = newLedger()
  for (const peer of peers) ledger.peers.set(peer.uid, peer)
  return ledger
}

/** A ledger that has already taken `starting` as what the page held. */
function hydrated(starting: PMNode, ...peers: Array<typeof ADA>): Ledger {
  const ledger = ledgerWith(...peers)
  hydrateLedger(ledger, starting)
  return ledger
}

/** One writer's membership of a block, as a window/seed states it. */
interface Wrote {
  uid: number
  via?: string | null
  chars: number
}

/**
 * Seeds a block's writer set directly, with the document holding content this
 * session has not delivered yet — the state a pass leaves behind, without
 * walking a document to reach it. The print is only ever compared, so any value
 * distinguishing this content from the stored one does.
 */
function wrote(ledger: Ledger, id: string, ...writers: Wrote[]): void {
  const set = ledger.sets.get(id) ?? { writers: new Map() }
  let chars = 0
  for (const w of writers) {
    const key = writerKey({ uid: w.uid, via: w.via ?? null })
    set.writers.set(key, { uid: w.uid, via: w.via ?? null })
    ledger.totals.set(w.uid, (ledger.totals.get(w.uid) ?? 0) + w.chars)
    chars += w.chars
  }
  ledger.sets.set(id, set)
  ledger.baseline.set(id, { chars, print: `${id}@${JSON.stringify(writers)}`, index: 0, empty: false })
}

/** A block's stated writer set as sorted `uid[:via]` member keys — membership, no amounts (ADR 0002). */
function statedFor(ledger: Ledger, id: string): string[] {
  return (sessionWindow(ledger).blocks[id] ?? [])
    .map(w => (w.via === null ? String(w.uid) : `${w.uid}:${w.via}`))
    .sort()
}

const human = (uid: number, via: string | null = null) => ({ uid, via })

describe('blockPrints', () => {
  it('measures text length per id-bearing top-level block', () => {
    expect([...blockPrints(doc(para('hello', 'b-1'), para('worldly', 'b-2')))].map(([id, p]) => [id, p.chars]))
      .toEqual([['b-1', 5], ['b-2', 7]])
  })

  it('skips blocks that carry no id — nothing can credit what it cannot name', () => {
    expect([...blockPrints(doc(para('unnamed', null), para('named', 'b-1'))).keys()]).toEqual(['b-1'])
  })

  it('prints the same length differently when the content differs', () => {
    const formatted = blockPrints(doc(para('word', 'b-1'))).get('b-1')!
    const rewritten = blockPrints(doc(strong('word', 'b-1'))).get('b-1')!
    expect(formatted.print).not.toBe(rewritten.print)
    expect(rewritten.chars).toBe(formatted.chars)
  })

  it('falls back to document order for a shared id with nothing known about it', () => {
    const indexed = blockPrints(doc(para('the real block', 'b-1'), para('a decoy', 'b-1')))
    expect(indexed.get('b-1')!.chars).toBe('the real block'.length)
  })

  it('indexes the block that already wore the id, wherever the duplicate is put', () => {
    const prior = blockPrints(doc(para('the real block', 'b-1')))
    const indexed = blockPrints(doc(para('a decoy', 'b-1'), para('the real block', 'b-1')), prior)
    expect(indexed.get('b-1')!.chars).toBe('the real block'.length)
    expect(indexed.get('b-1')!.index).toBe(1)
  })

  it('falls back to document order when no occurrence holds what the id held', () => {
    const prior = blockPrints(doc(para('one block, then split', 'b-1')))
    const indexed = blockPrints(doc(para('one block,', 'b-1'), para('then split', 'b-1')), prior)
    expect(indexed.get('b-1')!.chars).toBe('one block,'.length)
  })

  it('falls back to document order when several occurrences hold it', () => {
    const prior = blockPrints(doc(para('copy', 'b-1')))
    const indexed = blockPrints(doc(para('copy', 'b-1'), para('copy', 'b-1')), prior)
    expect(indexed.get('b-1')!.index).toBe(0)
  })
})

describe('sharedIdKeepers', () => {
  it('states only the ids the commit must not resolve by document order', () => {
    const prior = blockPrints(doc(para('the real block', 'b-1')))
    const baseline = blockPrints(doc(para('a decoy', 'b-1'), para('the real block', 'b-1'), para('lone', 'b-2')), prior)
    expect([...sharedIdKeepers(baseline)]).toEqual([['b-1', 1]])
  })
})

describe('a client that points a block at somebody else\'s id', () => {
  it('cannot move the victim\'s block out from under its own accounting', () => {
    const ledger = hydrated(doc(para('the real block', 'b-1')), ADA, FAGO)
    ledger.writer = human(ADA.uid)
    creditWriter(ledger, doc(para('ada is writing here', 'b-1')))

    // fago hands in a duplicate of b-1 placed after the real one.
    ledger.writer = human(FAGO.uid)
    creditWriter(ledger, doc(
      para('ada is writing here', 'b-1'),
      para('fagos decoy', 'b-1'),
    ))

    // The incumbent keeps its set; fago never reaches it.
    expect(statedFor(ledger, 'b-1')).toEqual([String(ADA.uid)])
  })

  it('cannot take it by putting the duplicate FIRST either', () => {
    const ledger = hydrated(doc(para('the real block', 'b-1')), ADA, FAGO)
    ledger.writer = human(ADA.uid)
    creditWriter(ledger, doc(para('ada is writing here', 'b-1')))

    ledger.writer = human(FAGO.uid)
    creditWriter(ledger, doc(
      para('fagos decoy', 'b-1'),
      para('ada is writing here', 'b-1'),
    ))

    expect(statedFor(ledger, 'b-1')).toEqual([String(ADA.uid)])
  })
})

describe('diffTouched', () => {
  const prints = (d: PMNode) => blockPrints(d)

  it('reports growth as the delta, and leaves untouched blocks out', () => {
    const before = prints(doc(para('one', 'b-1'), para('two', 'b-2')))
    const after = prints(doc(para('one more', 'b-1'), para('two', 'b-2')))
    expect(diffTouched(before, after)).toEqual([{ id: 'b-1', chars: 5 }])
  })

  it('reports a shrunk block, crediting nothing for it', () => {
    const before = prints(doc(para('a long paragraph', 'b-1')))
    const after = prints(doc(para('short', 'b-1')))
    expect(diffTouched(before, after)).toEqual([{ id: 'b-1', chars: 0 }])
  })

  it('reports a block rewritten to exactly the same length', () => {
    const before = prints(doc(para('cat', 'b-1')))
    const after = prints(doc(para('dog', 'b-1')))
    expect(diffTouched(before, after)).toEqual([{ id: 'b-1', chars: 0 }])
  })
})

describe('an unhydrated ledger', () => {
  it('credits nobody for what the page already held', () => {
    const ledger = ledgerWith(ADA)
    ledger.writer = human(ADA.uid)
    const { peer, touches } = creditWriter(ledger, doc(para('a page ada did not write', 'b-1')))
    expect(peer).toBeNull()
    expect(touches).toEqual([])
    expect(ledger.sets.size).toBe(0)
  })

  it('measures the next pass from what it found, not from nothing', () => {
    const ledger = ledgerWith(ADA)
    ledger.writer = human(ADA.uid)
    creditWriter(ledger, doc(para('twelve chars', 'b-1')))
    hydrateLedger(ledger, doc(para('twelve chars', 'b-1')))
    expect(creditWriter(ledger, doc(para('twelve chars!', 'b-1'))).touches)
      .toEqual([{ id: 'b-1', chars: 1 }])
  })
})

describe('creditWriter', () => {
  it('adds the writing peer to each block it changed, at its growth', () => {
    const ledger = hydrated(doc(para('hello', 'b-1')), ADA)
    ledger.writer = human(ADA.uid)
    const { peer, touches } = creditWriter(ledger, doc(para('hello there', 'b-1')))
    expect(peer).toEqual({ uid: ADA.uid, name: 'ada', via: null })
    expect(touches).toEqual([{ id: 'b-1', chars: 6 }])
    expect(statedFor(ledger, 'b-1')).toEqual([String(ADA.uid)])
  })

  it('credits nobody when the connection carried no identity', () => {
    const ledger = hydrated(doc(para('start', 'b-1')), ADA)
    ledger.writer = null
    const { peer } = creditWriter(ledger, doc(para('typed by nobody', 'b-1')))
    expect(peer).toBeNull()
    expect(ledger.sets.size).toBe(0)
  })

  it('accumulates across passes and keeps peers apart', () => {
    const ledger = hydrated(doc(para('one', 'b-1'), para('two', 'b-2')), ADA, FAGO)
    ledger.writer = human(ADA.uid)
    creditWriter(ledger, doc(para('one more', 'b-1'), para('two', 'b-2')))
    creditWriter(ledger, doc(para('one more time', 'b-1'), para('two', 'b-2')))
    ledger.writer = human(FAGO.uid)
    creditWriter(ledger, doc(para('one more time', 'b-1'), para('two of them', 'b-2')))

    // ada accrued once in b-1 (union), fago holds b-2.
    expect(statedFor(ledger, 'b-1')).toEqual([String(ADA.uid)])
    expect(statedFor(ledger, 'b-2')).toEqual([String(FAGO.uid)])
  })

  it('seats an agent as a member carrying its via', () => {
    const ledger = hydrated(doc(para('draft', 'b-1')), ADA)
    ledger.writer = human(ADA.uid, CLAUDE)
    const { peer } = creditWriter(ledger, doc(para('draft rewritten by the agent', 'b-1')))
    expect(peer).toEqual({ uid: ADA.uid, name: 'ada', via: CLAUDE })
    expect(statedFor(ledger, 'b-1')).toEqual([`${ADA.uid}:${CLAUDE}`])
  })

  it('keeps the human and the same human-via-agent as separate members', () => {
    const ledger = hydrated(doc(para('one', 'b-1')), ADA)
    ledger.writer = human(ADA.uid)
    creditWriter(ledger, doc(para('one human', 'b-1')))
    ledger.writer = human(ADA.uid, CLAUDE)
    creditWriter(ledger, doc(para('one human and agent', 'b-1')))
    expect(statedFor(ledger, 'b-1')).toEqual([String(ADA.uid), `${ADA.uid}:${CLAUDE}`])
  })
})

describe('an edit that moves no characters', () => {
  it('names the peer who rewrote a block to the same length', () => {
    const ledger = hydrated(doc(para('cat', 'b-1')), ADA)
    ledger.writer = human(ADA.uid)
    creditWriter(ledger, doc(para('dog', 'b-1')))
    expect(statedFor(ledger, 'b-1')).toEqual([String(ADA.uid)])
  })

  it('names the peer who only toggled a mark', () => {
    const ledger = hydrated(doc(para('unchanged text', 'b-1')), ADA, FAGO)
    ledger.writer = human(ADA.uid)
    creditWriter(ledger, doc(strong('unchanged text', 'b-1')))

    const window = sessionWindow(ledger)
    expect(statedFor(ledger, 'b-1')).toEqual([String(ADA.uid)])
    expect(window.author).toEqual(ADA)
  })
})

describe('sessionWindow', () => {
  it('states the window per block, and every writer in it', () => {
    const ledger = ledgerWith(ADA, FAGO)
    wrote(ledger, 'b-1', { uid: ADA.uid, chars: 4 }, { uid: FAGO.uid, chars: 2 })
    wrote(ledger, 'b-2', { uid: FAGO.uid, chars: 9 })

    expect(statedFor(ledger, 'b-1')).toEqual([String(FAGO.uid), String(ADA.uid)])
    expect(statedFor(ledger, 'b-2')).toEqual([String(FAGO.uid)])
  })

  it('reports a touched-but-not-grown block, so its episode names its author', () => {
    const ledger = ledgerWith(ADA)
    wrote(ledger, 'b-1', { uid: ADA.uid, chars: 0 })
    expect(statedFor(ledger, 'b-1')).toEqual([String(ADA.uid)])
  })

  it('keeps what it stated until Drupal is known to have taken it', () => {
    const ledger = ledgerWith(ADA)
    wrote(ledger, 'b-1', { uid: ADA.uid, chars: 4 })
    sessionWindow(ledger)
    // A checkpoint that never landed leaves its set owed.
    expect(statedFor(ledger, 'b-1')).toEqual([String(ADA.uid)])
  })

  // The editor keeps an empty paragraph after a block that is not one, so a
  // reader has somewhere to click below the last one, and the id tracker gives
  // it an id. Drupal's segmentation drops the empty chunk, so the block reaches
  // no revision and can owe no review step.
  it('states nothing for a block holding nothing', () => {
    const ledger = hydrated(doc(para('one', 'b-1'), heading('two', 'b-2')), ADA)
    ledger.writer = human(ADA.uid)
    creditWriter(ledger, doc(para('one!', 'b-1'), heading('two', 'b-2'), para('', 'b-trailing')))

    expect(Object.keys(sessionWindow(ledger).blocks)).toEqual(['b-1'])
  })

  // A block gone from Drupal's body is the one change with no text left to
  // state, and Drupal reviews it. A window that stated nothing would leave it
  // approvable by nobody (ADR 0004).
  it('states a block the document dropped, with no print', () => {
    const ledger = hydrated(doc(para('one', 'b-1'), heading('two', 'b-2')), ADA)
    ledger.writer = human(ADA.uid)
    creditWriter(ledger, doc(para('one', 'b-1')))

    const window = sessionWindow(ledger)
    expect(window.blocks['b-2']).toEqual([{ uid: ADA.uid, via: null }])
    expect(window.stated.get('b-2')).toBeNull()
  })

  it('reads a block emptied of its text the same way', () => {
    const ledger = hydrated(doc(para('one', 'b-1'), para('two', 'b-2')), ADA)
    ledger.writer = human(ADA.uid)
    creditWriter(ledger, doc(para('one', 'b-1'), para('', 'b-2')))

    expect(sessionWindow(ledger).stated.get('b-2')).toBeNull()
  })

  it('drops a stated removal once Drupal has taken it', () => {
    const ledger = hydrated(doc(para('one', 'b-1'), heading('two', 'b-2')), ADA)
    ledger.writer = human(ADA.uid)
    creditWriter(ledger, doc(para('one', 'b-1')))

    dischargeWindow(ledger, sessionWindow(ledger))

    expect(sessionWindow(ledger).blocks).toEqual({})
  })

  it('states the same block once it holds something', () => {
    const ledger = hydrated(doc(para('one', 'b-1'), heading('two', 'b-2')), ADA)
    ledger.writer = human(ADA.uid)
    creditWriter(ledger, doc(para('one', 'b-1'), heading('two', 'b-2'), para('', 'b-trailing')))
    creditWriter(ledger, doc(para('one', 'b-1'), heading('two', 'b-2'), para('typed', 'b-trailing')))

    expect(Object.keys(sessionWindow(ledger).blocks)).toEqual(['b-trailing'])
  })
})

describe('sessionPayload', () => {
  const windowOf = (id: string, ...writers: Wrote[]) => {
    const ledger = ledgerWith(ADA, FAGO)
    wrote(ledger, id, ...writers)
    return sessionWindow(ledger)
  }

  it('acts as the human the window elected when nobody triggered the write', () => {
    const payload = sessionPayload(windowOf('b-1', { uid: ADA.uid, chars: 4 }), null)
    expect(payload).toMatchObject({ actingUid: ADA.uid })
    expect(payload.blocks['b-1']).toEqual([{ uid: ADA.uid, via: null }])
  })

  it('acts as whoever triggered it, however the window voted', () => {
    // The publish rides this write, and it is the person who asked for it whose
    // rights Drupal answers to — not the session's busiest typist.
    const payload = sessionPayload(windowOf('b-1', { uid: ADA.uid, chars: 400 }), FAGO.uid)
    expect(payload).toMatchObject({ actingUid: FAGO.uid })
    expect(payload.blocks['b-1']).toEqual([{ uid: ADA.uid, via: null }])
  })

  it('carries the agent member with its via, so Drupal can raise the agent step', () => {
    const payload = sessionPayload(windowOf('b-1', { uid: ADA.uid, via: CLAUDE, chars: 5 }), null)
    expect(payload.blocks['b-1']).toEqual([{ uid: ADA.uid, via: CLAUDE }])
  })

  it('discharges once delivered', () => {
    const ledger = ledgerWith(ADA)
    wrote(ledger, 'b-1', { uid: ADA.uid, chars: 4 })

    const carried = sessionWindow(ledger)
    expect(sessionPayload(carried, null).blocks['b-1'])
      .toEqual([{ uid: ADA.uid, via: null }])
    dischargeWindow(ledger, carried)
    expect(ledger.sets.size).toBe(0)
  })

  it('an empty window is stated — the lost-accounting case', () => {
    const payload = sessionPayload(sessionWindow(ledgerWith(ADA)), null)
    expect(payload).toMatchObject({ blocks: {} })
  })
})

describe('dischargeWindow', () => {
  it('drops a block whose content still equals what the window stated', () => {
    const ledger = hydrated(doc(para('one', 'b-1')), ADA)
    ledger.writer = human(ADA.uid)
    creditWriter(ledger, doc(para('one more', 'b-1')))
    const delivered = sessionWindow(ledger)

    dischargeWindow(ledger, delivered)

    expect(sessionWindow(ledger).blocks).toEqual({})
    expect(ledger.sets.size).toBe(0)
  })

  it('keeps the set when the block was edited while the checkpoint was in flight', () => {
    const ledger = hydrated(doc(para('one', 'b-1')), ADA)
    ledger.writer = human(ADA.uid)
    creditWriter(ledger, doc(para('one more', 'b-1')))
    const delivered = sessionWindow(ledger)
    // The peer kept typing between the read and the round trip: the print moved.
    creditWriter(ledger, doc(para('one more still', 'b-1')))

    dischargeWindow(ledger, delivered)

    // The set rides the next checkpoint — re-stating ada changes nothing.
    expect(statedFor(ledger, 'b-1')).toEqual([String(ADA.uid)])
  })

  it('keeps an in-flight edit that changed no characters — the print still moved', () => {
    const ledger = hydrated(doc(para('cats', 'b-1')), ADA)
    ledger.writer = human(ADA.uid)
    creditWriter(ledger, doc(para('cats!', 'b-1')))
    const delivered = sessionWindow(ledger)
    // Rewritten to the same length while the round trip was out.
    creditWriter(ledger, doc(para('dogs!', 'b-1')))

    dischargeWindow(ledger, delivered)

    expect(sessionWindow(ledger).blocks['b-1']).toBeDefined()
  })

  it('states nothing for a block whose content is back to what Drupal holds', () => {
    // A typo and its undo across a checkpoint boundary: the set survives but
    // its text no longer differs from stored, so no episode opens on it.
    const ledger = hydrated(doc(para('as stored', 'b-1'), para('other', 'b-2')), ADA)
    ledger.writer = human(ADA.uid)
    creditWriter(ledger, doc(para('as stored typo', 'b-1'), para('other', 'b-2')))
    creditWriter(ledger, doc(para('as stored', 'b-1'), para('other words', 'b-2')))

    const window = sessionWindow(ledger)
    expect(window.blocks['b-1']).toBeUndefined()
    expect(statedFor(ledger, 'b-2')).toEqual([String(ADA.uid)])
    expect(window.stated.has('b-1')).toBe(false)
  })

  it('drops the back-to-stored set on discharge, freeing the map', () => {
    const ledger = hydrated(doc(para('as stored', 'b-1')), ADA)
    ledger.writer = human(ADA.uid)
    creditWriter(ledger, doc(para('as stored typo', 'b-1')))
    creditWriter(ledger, doc(para('as stored', 'b-1')))

    dischargeWindow(ledger, sessionWindow(ledger))

    expect(ledger.sets.size).toBe(0)
  })

  it('advances what the session believes Drupal holds, per block', () => {
    const ledger = hydrated(doc(para('one', 'b-1')), ADA)
    ledger.writer = human(ADA.uid)
    creditWriter(ledger, doc(para('one more', 'b-1')))
    dischargeWindow(ledger, sessionWindow(ledger))

    // Typed and taken back to what the checkpoint delivered, not to what the
    // session opened with — nothing to say.
    creditWriter(ledger, doc(para('one more still', 'b-1')))
    creditWriter(ledger, doc(para('one more', 'b-1')))

    expect(sessionWindow(ledger).blocks).toEqual({})
  })

  it('an in-flight edit undone after discharge opens no episode', () => {
    // Drupal stored the STATED print; the extra edit and its undo bring the
    // block back to exactly that. committed advances on discharge whatever
    // happened here since, or this undo would re-enter the four-eyes baseline.
    const ledger = hydrated(doc(para('one', 'b-1')), ADA)
    ledger.writer = human(ADA.uid)
    creditWriter(ledger, doc(para('one more', 'b-1')))
    const delivered = sessionWindow(ledger)
    creditWriter(ledger, doc(para('one more still', 'b-1')))

    dischargeWindow(ledger, delivered)
    creditWriter(ledger, doc(para('one more', 'b-1')))

    expect(sessionWindow(ledger).blocks).toEqual({})
    // The lingering set is dropped at the next discharge.
    dischargeWindow(ledger, sessionWindow(ledger))
    expect(ledger.sets.size).toBe(0)
  })

  it('resets the character totals — the next window elects its own author', () => {
    const ledger = hydrated(doc(para('one', 'b-1'), para('two', 'b-2')), ADA, FAGO)
    // Ada types a lot, delivers.
    ledger.writer = human(ADA.uid)
    creditWriter(ledger, doc(para('one plus a great many characters', 'b-1'), para('two', 'b-2')))
    dischargeWindow(ledger, sessionWindow(ledger))
    // Fago alone types the next window; ada's spent volume must not outvote.
    ledger.writer = human(FAGO.uid)
    creditWriter(ledger, doc(para('one plus a great many characters', 'b-1'), para('two by fago', 'b-2')))

    expect(sessionWindow(ledger).author?.uid).toBe(FAGO.uid)
  })

    it('touches no block the window did not carry', () => {
    const ledger = ledgerWith(ADA, FAGO)
    wrote(ledger, 'b-1', { uid: ADA.uid, chars: 4 })
    const delivered = sessionWindow(ledger)
    // Same print for b-1 in the delivered window, and a new block since.
    wrote(ledger, 'b-2', { uid: FAGO.uid, chars: 9 })

    dischargeWindow(ledger, delivered)

    expect(sessionWindow(ledger).blocks['b-2']).toEqual([{ uid: FAGO.uid, via: null }])
  })
})

describe('writerOfOrigin', () => {
  it('reads the account off the connection the update arrived on', () => {
    const origin = { source: 'connection', connection: { context: { user: { uid: 7, name: 'ada' } } } }
    expect(writerOfOrigin(origin)).toEqual({ uid: 7, via: null })
  })

  it('gives a plain direct connection no account', () => {
    expect(writerOfOrigin({ source: 'local', context: { cookie: 'SESS-ada' } })).toBeNull()
  })

  it('names the account an out-of-seat write was authorized under, via null for a human', () => {
    expect(writerOfOrigin({ agent: true, label: 'fago', clientId: 1, seat: { uid: 7, name: 'fago', via: null } }))
      .toEqual({ uid: 7, via: null })
  })

  it('carries the agent seat with its via, so it enters the block set as a member', () => {
    expect(writerOfOrigin({ agent: true, label: 'fago via Claude', clientId: 1, seat: { uid: 7, name: 'fago', via: CLAUDE } }))
      .toEqual({ uid: 7, via: CLAUDE })
  })

  it('gives a seat-less agent origin no account', () => {
    expect(writerOfOrigin({ agent: true, label: 'x', clientId: 1, seat: null })).toBeNull()
  })

  it('gives an unrecognised origin nobody', () => {
    expect(writerOfOrigin(undefined)).toBeNull()
    expect(writerOfOrigin(null)).toBeNull()
    expect(writerOfOrigin('some-extension')).toBeNull()
    expect(writerOfOrigin({ source: 'connection', connection: {} })).toBeNull()
    expect(writerOfOrigin({ source: 'connection', connection: { context: { user: { uid: 0 } } } })).toBeNull()
  })
})

describe("a window's revision author", () => {
  it('names the peer who wrote the most of this window, and everyone in it', () => {
    const ledger = hydrated(doc(para('', 'b-1'), para('', 'b-2')), ADA, FAGO)
    ledger.writer = human(FAGO.uid)
    creditWriter(ledger, doc(para('hi', 'b-1'), para('', 'b-2')))
    ledger.writer = human(ADA.uid)
    creditWriter(ledger, doc(para('hi', 'b-1'), para('a much longer burst', 'b-2')))

    const { author, coAuthors } = sessionWindow(ledger)
    expect(author).toEqual(ADA)
    expect([...coAuthors].sort((a, b) => a.name.localeCompare(b.name)))
      .toEqual([{ name: 'ada', via: null }, { name: 'fago', via: null }])
  })

  it('breaks a tie toward the peer who wrote last', () => {
    const ledger = hydrated(doc(para('', 'b-1'), para('', 'b-2')), ADA, FAGO)
    ledger.writer = human(ADA.uid)
    creditWriter(ledger, doc(para('abc', 'b-1'), para('', 'b-2')))
    ledger.writer = human(FAGO.uid)
    creditWriter(ledger, doc(para('abc', 'b-1'), para('xyz', 'b-2')))

    expect(sessionWindow(ledger).author).toEqual(FAGO)
  })

  it('falls back to the last writer when the window measured nothing', () => {
    const ledger = ledgerWith(ADA, FAGO)
    ledger.writer = human(FAGO.uid)
    expect(sessionWindow(ledger)).toEqual({ blocks: {}, author: FAGO, coAuthors: [], stated: new Map(), actions: [] })
  })

  it('names nobody when the document has no writer at all', () => {
    expect(sessionWindow(ledgerWith(ADA)))
      .toEqual({ blocks: {}, author: null, coAuthors: [], stated: new Map(), actions: [] })
  })

  it('carries each writer with the agent label it wrote under', () => {
    // `revision_uid` is the token's owner either way, so the label is the only
    // thing separating the human from the agent acting as them.
    const ledger = hydrated(doc(para('', 'b-1')), ADA)
    ledger.writer = { uid: ADA.uid, via: CLAUDE }
    creditWriter(ledger, doc(para('written by the agent', 'b-1')))

    expect(sessionWindow(ledger).coAuthors).toEqual([{ name: 'ada', via: CLAUDE }])
  })

  it('names a field-only writer the block pass cannot see', () => {
    // A field edit moves no block, so the window would otherwise state nobody
    // and the checkpoint's log would name whoever opened the document.
    const ledger = hydrated(doc(para('unchanged', 'b-1')), ADA)
    ledger.fieldWriters.set(writerKey({ uid: ADA.uid, via: CLAUDE }), { uid: ADA.uid, via: CLAUDE })

    const window = sessionWindow(ledger)
    expect(window.blocks).toEqual({})
    expect(window.coAuthors).toEqual([{ name: 'ada', via: CLAUDE }])
  })

  it('drops the field writers once the lane matches Drupal again', () => {
    const ledger = ledgerWith(ADA)
    ledger.fieldWriters.set(writerKey({ uid: ADA.uid, via: null }), { uid: ADA.uid, via: null })

    dischargeFieldWriters(ledger, true)
    expect(ledger.fieldWriters.size).toBe(1)
    dischargeFieldWriters(ledger, false)
    expect(ledger.fieldWriters.size).toBe(0)
  })

  it('a restart keeps the field writers the session still owes', () => {
    const ledger = ledgerWith(ADA)
    ledger.fieldWriters.set(writerKey({ uid: ADA.uid, via: CLAUDE }), { uid: ADA.uid, via: CLAUDE })

    const restored = ledgerWith(ADA)
    adoptSnapshot(restored, doc(para('x', 'b-1')), ledgerSnapshot(ledger))
    expect(sessionWindow(restored).coAuthors).toEqual([{ name: 'ada', via: CLAUDE }])
  })
})

describe('isPeerUpdate', () => {
  it('recognises somebody writing', () => {
    expect(isPeerUpdate({ source: 'connection', connection: {} })).toBe(true)
    expect(isPeerUpdate({ source: 'local', context: {} })).toBe(true)
  })

  it('does not mistake this server\'s own bookkeeping for a writer', () => {
    expect(isPeerUpdate(null)).toBe(false)
    expect(isPeerUpdate(undefined)).toBe(false)
    expect(isPeerUpdate({})).toBe(false)
    expect(isPeerUpdate('y-sync')).toBe(false)
  })
})


describe('ledger persistence (ADR 0005)', () => {
  it('a restart delivers the undelivered window, still naming the original writers', () => {
    // Session one: ada edits, the checkpoint FAILS (window never discharged).
    const before = hydrated(doc(para('one', 'b-1')), ADA)
    before.writer = human(ADA.uid)
    creditWriter(before, doc(para('one rewritten', 'b-1')))
    const snap = ledgerSnapshot(before)

    // Restart: fresh process, fresh ledger; the document text and the
    // snapshot come back together from the store. Ada is gone.
    const after = newLedger()
    adoptSnapshot(after, doc(para('one rewritten', 'b-1')), snap)
    after.peers.set(ADA.uid, ADA)

    expect(sessionWindow(after).blocks['b-1']).toEqual([{ uid: ADA.uid, via: null }])
  })

  it('a delivered window does not come back', () => {
    const before = hydrated(doc(para('one', 'b-1')), ADA)
    before.writer = human(ADA.uid)
    creditWriter(before, doc(para('one rewritten', 'b-1')))
    dischargeWindow(before, sessionWindow(before))
    const snap = ledgerSnapshot(before)

    const after = newLedger()
    adoptSnapshot(after, doc(para('one rewritten', 'b-1')), snap)
    after.peers.set(ADA.uid, ADA)

    expect(sessionWindow(after).blocks).toEqual({})
  })

  it('drops a persisted set whose block neither the document nor Drupal holds', () => {
    // Corruption: the snapshot names a block that exists nowhere.
    const after = newLedger()
    adoptSnapshot(after, doc(para('one', 'b-1')), {
      sets: { 'b-gone': [{ uid: ADA.uid, via: null }], 'b-1': [{ uid: ADA.uid, via: null }] },
      committed: { 'b-1': '' },
    })
    after.peers.set(ADA.uid, ADA)

    expect(after.sets.has('b-gone')).toBe(false)
    expect(after.sets.has('b-1')).toBe(true)
  })

  it('an agent member survives the restart with its via', () => {
    const before = hydrated(doc(para('one', 'b-1')), ADA)
    before.writer = { uid: ADA.uid, via: 'Claude' }
    creditWriter(before, doc(para('one by the agent', 'b-1')))
    const snap = ledgerSnapshot(before)

    const after = newLedger()
    adoptSnapshot(after, doc(para('one by the agent', 'b-1')), snap)
    after.peers.set(ADA.uid, ADA)

    expect(sessionWindow(after).blocks['b-1']).toEqual([{ uid: ADA.uid, via: 'Claude' }])
  })
})

/**
 * A sign-off is an act of the peer who made it, so the uid is the connection's
 * and the item has to be one the document still holds as they read it.
 */
describe('a sign-off this server will carry', () => {
  const printOf = (item: string) => (item === 'b-1' ? 'print-1' : undefined)
  const signOff = JSON.stringify({ type: 'review.approve', item: 'b-1', step: 'peer' })

  it('takes the uid from the connection and the print from the document', () => {
    expect(reviewActionFrom(signOff, ADA.uid, printOf))
      .toEqual({ item: 'b-1', step: 'peer', uid: ADA.uid, print: 'print-1' })
  })

  it('carries nothing for a seat with no account — an agent signs nothing off', () => {
    expect(reviewActionFrom(signOff, 0, printOf)).toBeNull()
  })

  it('ignores a uid the message claims for itself', () => {
    const claimed = JSON.stringify({ type: 'review.approve', item: 'b-1', step: 'peer', uid: FAGO.uid })
    expect(reviewActionFrom(claimed, ADA.uid, printOf)?.uid).toBe(ADA.uid)
  })

  it('carries an item the document holds no block for, with no print', () => {
    // A removed block and the title read as `null` rather than as unknown.
    const withItems = (item: string) => (item === 'b-1' ? 'print-1' : (item === 'field:title' ? null : undefined))
    const title = JSON.stringify({ type: 'review.approve', item: 'field:title', step: 'peer' })
    expect(reviewActionFrom(title, ADA.uid, withItems))
      .toEqual({ item: 'field:title', step: 'peer', uid: ADA.uid, print: null })
  })

  it('carries nothing for an unknown step, an unknown item, or a message it cannot read', () => {
    expect(reviewActionFrom(JSON.stringify({ type: 'review.approve', item: 'b-1', step: 'legal' }), ADA.uid, printOf)).toBeNull()
    expect(reviewActionFrom(JSON.stringify({ type: 'review.approve', item: 'b-9', step: 'peer' }), ADA.uid, printOf)).toBeNull()
    expect(reviewActionFrom(JSON.stringify({ type: 'awareness.ping' }), ADA.uid, printOf)).toBeNull()
    expect(reviewActionFrom('not json', ADA.uid, printOf)).toBeNull()
  })
})

/**
 * The window carries the sign-offs, and drops the ones the text has moved past.
 */
describe('the sign-offs a checkpoint states', () => {
  function signedOff(ledger: Ledger, item: string, uid: number): void {
    const print = blockPrints(doc(para('one', 'b-1'))).get(item)?.print ?? 'stale'
    ledger.actions.push({ item, step: 'peer', uid, print })
  }

  it('rides the statement, stripped of the print it was checked against', () => {
    const ledger = hydrated(doc(para('one', 'b-1')), ADA)
    signedOff(ledger, 'b-1', ADA.uid)

    expect(sessionWindow(ledger).actions).toEqual([{ item: 'b-1', step: 'peer', uid: ADA.uid }])
    expect(sessionPayload(sessionWindow(ledger), ADA.uid).actions)
      .toEqual([{ item: 'b-1', step: 'peer', uid: ADA.uid }])
  })

  it('carries a sign-off on an item the document holds no block for', () => {
    const ledger = hydrated(doc(para('one', 'b-1')), ADA)
    ledger.actions.push({ item: 'field:title', step: 'peer', uid: ADA.uid, print: null })

    expect(sessionWindow(ledger).actions).toEqual([{ item: 'field:title', step: 'peer', uid: ADA.uid }])
  })

  it('is dropped where the block was edited after the sign-off', () => {
    const ledger = hydrated(doc(para('one', 'b-1')), ADA)
    signedOff(ledger, 'b-1', ADA.uid)
    ledger.writer = human(FAGO.uid)
    creditWriter(ledger, doc(para('one, rewritten', 'b-1')))

    expect(sessionWindow(ledger).actions).toEqual([])
  })

  it('is off the books once Drupal has answered it', () => {
    const ledger = hydrated(doc(para('one', 'b-1')), ADA)
    signedOff(ledger, 'b-1', ADA.uid)
    const window = sessionWindow(ledger)

    dischargeWindow(ledger, window)

    expect(ledger.actions).toEqual([])
  })
})
