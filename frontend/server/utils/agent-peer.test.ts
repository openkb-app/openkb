import { describe, it, expect, vi } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap'
import { editorSchema } from './editor-schema'
import { serializeYDoc } from './commit'
import { agentAwarenessUser } from './agent-awareness'
import {
  agentLabel,
  applyBlockOps,
  applyBodyMarkdown,
  applyComment,
  applyFieldValues,
  UnanchoredBlockError,
  UnchainedBlockError,
  UnknownBlockError,
  UnknownThreadError,
  isAgentOrigin,
  openAgentSession,
  readBlockOpList,
  refuseStaleBlocks,
  StaleBlockError,
  validateFieldOps,
  type AgentActor,
  type AgentPeerHost,
} from './agent-peer'
import { blockVersions } from './block-versions'
import type { FieldSpec } from './entity-fields'
import { readBlockMeta } from '#shared/page-blocks'
import { readThreads } from '#shared/block-comments'
import { collabColor } from '#shared/utils/presence'

const ACTOR: AgentActor = { token: 'tok-1', uid: 7, name: 'fago', via: 'Claude' }

const SPECS: FieldSpec[] = [
  { key: 'summary', name: 'field_summary', multiple: false, reference: false },
  { key: 'tags', name: 'field_tags', multiple: true, reference: true, entityType: 'taxonomy_term', bundles: ['topic'] },
]

function docFromMarkdownBlocks(paragraphs: string[]): Y.Doc {
  const json = {
    type: 'doc',
    content: paragraphs.map(text => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
  }
  return prosemirrorJSONToYDoc(editorSchema, json as never, 'default')
}

/** Blocks that carry ids, which is what a block op can name. */
function docWithIdentifiedBlocks(blocks: Array<[string, string]>): Y.Doc {
  const json = {
    type: 'doc',
    content: blocks.map(([id, text]) => ({
      type: 'paragraph',
      attrs: { id },
      content: [{ type: 'text', text }],
    })),
  }
  return prosemirrorJSONToYDoc(editorSchema, json as never, 'default')
}

/** A hocuspocus stand-in: a plain Y.Doc dressed with the bits we touch. */
function hostFor(doc: Y.Doc, options: { live?: boolean, websocketPeers?: number } = {}) {
  const document = doc as Y.Doc & { awareness: Awareness, getConnections: () => unknown[] }
  document.awareness = new Awareness(doc)
  document.awareness.setLocalState(null)
  document.getConnections = () => Array.from({ length: options.websocketPeers ?? 0 })

  const disconnect = vi.fn(async () => {})
  const host = {
    documents: new Map(options.live ? [['node:1', document]] : []),
    openDirectConnection: vi.fn(async () => ({ document, disconnect, transact: vi.fn() })),
  } as unknown as AgentPeerHost

  return { host, document, disconnect }
}

const noTimers = {
  setTimer: vi.fn(() => 0 as unknown as ReturnType<typeof setInterval>),
  clearTimer: vi.fn(),
}

describe('agent identity + presence', () => {
  it('reads as "owner via label" and carries the owner colour', () => {
    expect(agentLabel(ACTOR)).toBe('fago via Claude')
    expect(agentAwarenessUser(ACTOR)).toEqual({
      name: 'fago',
      color: collabColor(7),
      uid: 7,
      via: 'Claude',
    })
  })
})

describe('applyFieldValues', () => {
  it('writes whole keys and skips values that already match', () => {
    const doc = new Y.Doc()
    doc.getMap('fields').set('summary', 'old')
    doc.getMap('fields').set('tags', [{ id: 'u-1', label: 'One' }])

    const written = applyFieldValues(doc, {
      summary: 'new',
      tags: [{ id: 'u-1', label: 'One' }],
    })

    expect(written).toEqual(['summary'])
    expect(doc.getMap('fields').get('summary')).toBe('new')
  })

  it('leaves keys the ops do not mention alone', () => {
    const doc = new Y.Doc()
    doc.getMap('fields').set('title', 'Kept')
    applyFieldValues(doc, { summary: 'set' })
    expect(doc.getMap('fields').get('title')).toBe('Kept')
  })
})

describe('validateFieldOps', () => {
  it('refuses a key the exposure contract does not carry', () => {
    expect(validateFieldOps(SPECS, { nope: 'x' })).toEqual({
      nope: ['No exposed field for frontmatter key "nope".'],
    })
  })

  it('refuses a cardinality mismatch in either direction', () => {
    expect(Object.keys(validateFieldOps(SPECS, { tags: 'one' }))).toEqual(['tags'])
    expect(Object.keys(validateFieldOps(SPECS, { summary: ['a', 'b'] }))).toEqual(['summary'])
  })

  it('accepts the title (a base field, outside the schema) and valid shapes', () => {
    expect(validateFieldOps(SPECS, { title: 'A title', summary: 'x', tags: [] })).toEqual({})
    expect(validateFieldOps(SPECS, { title: 42 })).toEqual({ title: ['The title must be a string.'] })
  })
})

describe('applyBodyMarkdown', () => {
  it('serializes back to the markdown it was given', () => {
    const doc = docFromMarkdownBlocks(['first', 'second'])
    applyBodyMarkdown(doc, 'first\n\nsecond changed')
    expect(serializeYDoc(doc)).toBe('first\n\nsecond changed')
  })

  it('leaves untouched blocks as the same Y types — peer positions survive', () => {
    const doc = docFromMarkdownBlocks(['keep me', 'edit me'])
    const fragment = doc.getXmlFragment('default')
    const firstBefore = fragment.get(0)
    // A relative position anchored in the untouched block, as a peer's cursor
    // would be: it must still resolve after the agent rewrites block two.
    const cursor = Y.createRelativePositionFromTypeIndex(
      (firstBefore as Y.XmlElement).get(0) as unknown as Y.AbstractType<unknown>,
      3,
    )

    applyBodyMarkdown(doc, 'keep me\n\nrewritten')

    expect(fragment.get(0)).toBe(firstBefore)
    expect(Y.createAbsolutePositionFromRelativePosition(cursor, doc)?.index).toBe(3)
    expect(serializeYDoc(doc)).toBe('keep me\n\nrewritten')
  })

  it('a no-op body writes no ops at all', () => {
    const doc = docFromMarkdownBlocks(['unchanged'])
    const before = Y.encodeStateAsUpdate(doc)
    applyBodyMarkdown(doc, 'unchanged')
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })
})

describe('applyBlockOps', () => {
  it('rewrites the named block and leaves the rest byte-identical', () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first'], ['b-2', 'second'], ['b-3', 'third']])

    applyBlockOps(doc, [{ id: 'b-2', markdown: 'second, rewritten' }])

    expect(serializeYDoc(doc)).toBe('first {#b-1}\n\nsecond, rewritten {#b-2}\n\nthird {#b-3}')
  })

  it('leaves the untouched blocks as the same Y types — peer positions survive', () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'keep me'], ['b-2', 'edit me']])
    const fragment = doc.getXmlFragment('default')
    const firstBefore = fragment.get(0)
    const cursor = Y.createRelativePositionFromTypeIndex(
      (firstBefore as Y.XmlElement).get(0) as unknown as Y.AbstractType<unknown>,
      3,
    )

    applyBlockOps(doc, [{ id: 'b-2', markdown: 'rewritten' }])

    expect(fragment.get(0)).toBe(firstBefore)
    expect(Y.createAbsolutePositionFromRelativePosition(cursor, doc)?.index).toBe(3)
  })

  it('inserts before and after the block it is anchored to', () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first'], ['b-2', 'second']])

    applyBlockOps(doc, [
      { after: 'b-1', markdown: 'inserted after one' },
      { before: 'b-2', markdown: 'inserted before two' },
    ])

    expect(serializeYDoc(doc).split('\n\n').map(line => line.replace(/ \{#b-[\w-]+\}$/, ''))).toEqual([
      'first',
      'inserted after one',
      'inserted before two',
      'second',
    ])
  })

  it('mints an id for the content it authors, so the sidecar can key on it', () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first']])

    applyBlockOps(doc, [{ after: 'b-1', markdown: 'brand new' }], {
      actor: { uid: 7, via: 'Claude', name: 'fago' },
      at: () => 1000,
    })

    expect(serializeYDoc(doc)).toMatch(/^first \{#b-1\}\n\nbrand new \{#b-[\da-f]+\}$/)
  })

  it('answers the version each named block holds now', () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first'], ['b-2', 'second']])

    const versions = applyBlockOps(doc, [{ id: 'b-2', markdown: 'second, rewritten' }])

    // The one canonical helper's answer, read off the body the document now
    // serves — not a second hash of the op's own markdown.
    expect(versions).toEqual({ 'b-2': blockVersions(serializeYDoc(doc))['b-2'] })
  })

  it('names an inserted block by the id minted for it, not by the anchor', () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first']])

    const versions = applyBlockOps(doc, [{ after: 'b-1', markdown: 'brand new' }], true)

    // The anchor was not written, so it is not reported; the minted id is the
    // caller's only way to learn where its content landed.
    const [id, ...rest] = Object.keys(versions)
    expect(rest).toEqual([])
    expect(id).toMatch(/^b-[\da-f]+$/)
    expect(id).not.toBe('b-1')
    expect(versions[id!]).toBe(blockVersions(serializeYDoc(doc))[id!])
  })

  it('chains an edit onto a just-inserted block from the id and hash it answered', () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first']])

    const inserted = applyBlockOps(doc, [{ after: 'b-1', markdown: 'brand new' }], true)
    const [id, version] = Object.entries(inserted)[0]!
    const ops = [{ id, expect: version, markdown: 'brand new, edited' }]

    // No read between: the id and the hash both came out of the write.
    expect(() => refuseStaleBlocks(doc, ops)).not.toThrow()
    applyBlockOps(doc, ops, true)
    expect(serializeYDoc(doc)).toBe(`first {#b-1}\n\nbrand new, edited {#${id}}`)
  })

  it('reports every block a write produced, replacements and insertions alike', () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first'], ['b-2', 'second']])

    const versions = applyBlockOps(doc, [
      { id: 'b-1', markdown: 'first, rewritten' },
      { before: 'b-2', markdown: 'inserted before two' },
    ], true)

    const served = blockVersions(serializeYDoc(doc))
    expect(Object.keys(versions)).toHaveLength(2)
    expect(versions['b-1']).toBe(served['b-1'])
    // The insertion's own id, and it is not the anchor's.
    const minted = Object.keys(versions).find(id => id !== 'b-1')!
    expect(minted).not.toBe('b-2')
    expect(versions[minted]).toBe(served[minted])
  })

  it('chains two edits to one block on the version it answered, with no read between', () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first']])

    const first = applyBlockOps(doc, [{ id: 'b-1', expect: blockVersions(serializeYDoc(doc))['b-1'], markdown: 'pass one' }])
    const ops = [{ id: 'b-1', expect: first['b-1'], markdown: 'pass two' }]

    // The returned version is a usable `expect`: the CAS check accepts it, so
    // the second edit costs no read.
    expect(() => refuseStaleBlocks(doc, ops)).not.toThrow()
    applyBlockOps(doc, ops)
    expect(serializeYDoc(doc)).toBe('pass two {#b-1}')
  })

  it('chains an anchorless op after the block the op before it wrote', () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first'], ['b-2', 'second']])

    const versions = applyBlockOps(doc, [
      { after: 'b-1', markdown: 'inserted' },
      { markdown: 'chained one' },
      { markdown: 'chained two' },
    ], true)

    // Op order is document order: each lands after the one before it, not all
    // three after the same anchor.
    expect(serializeYDoc(doc).split('\n\n').map(line => line.replace(/ \{#b-[\w-]+\}$/, ''))).toEqual([
      'first',
      'inserted',
      'chained one',
      'chained two',
      'second',
    ])
    // Each reports the id minted for it, so the caller can edit what it wrote.
    expect(Object.keys(versions)).toHaveLength(3)
  })

  it('chains after a replacement too — the last block that op wrote', () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first'], ['b-2', 'second']])

    applyBlockOps(doc, [
      { id: 'b-1', markdown: 'rewritten' },
      { markdown: 'chained' },
    ], true)

    expect(serializeYDoc(doc).split('\n\n').map(line => line.replace(/ \{#b-[\w-]+\}$/, ''))).toEqual([
      'rewritten',
      'chained',
      'second',
    ])
  })

  it('fills a document that holds no blocks from an anchorless first op', () => {
    const doc = docWithIdentifiedBlocks([])

    const versions = applyBlockOps(doc, [
      { markdown: 'the agent writes the first block' },
      { markdown: 'and the second' },
    ], true)

    expect(serializeYDoc(doc).split('\n\n').map(line => line.replace(/ \{#b-[\w-]+\}$/, ''))).toEqual([
      'the agent writes the first block',
      'and the second',
    ])
    // Both minted ids come back, so the follow-up edit needs no read.
    expect(Object.keys(versions)).toHaveLength(2)
  })

  it('refuses an anchorless first op when the document holds blocks, writing nothing', () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first']])
    const before = Y.encodeStateAsUpdate(doc)

    expect(() => applyBlockOps(doc, [{ markdown: 'orphan' }]))
      .toThrow('blocks[0] needs one of id / after / before — no op precedes it to chain after.')
    expect(() => applyBlockOps(doc, [{ markdown: 'orphan' }])).toThrow(UnanchoredBlockError)

    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })

  it('refuses an anchorless op whose predecessor wrote no block, writing nothing', () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first']])
    const before = Y.encodeStateAsUpdate(doc)

    expect(() => applyBlockOps(doc, [
      { id: 'b-1', markdown: '' },
      { markdown: 'nothing to follow' },
    ])).toThrow(UnchainedBlockError)

    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })

  it('refuses a block the page does not hold, writing nothing', () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first']])
    const before = Y.encodeStateAsUpdate(doc)

    expect(() => applyBlockOps(doc, [
      { id: 'b-1', markdown: 'fine' },
      { id: 'b-nope', markdown: 'not fine' },
    ])).toThrow(UnknownBlockError)

    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })
})

describe('applyComment', () => {
  it('says it as the agent — the owner\'s account, carrying the agent label', () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first']])

    const { threadId, msgId } = applyComment(doc, ACTOR, { blockId: 'b-1', text: 'Fixed the figure.' })

    const [thread] = readThreads(doc)
    expect(thread).toMatchObject({ blockId: 'b-1', threadId, resolved: false, anchor: null })
    // The identity a revision and the presence strip use for the same actor:
    // the account is the owner's, `via` is what marks it as the agent's doing.
    expect(thread!.messages).toEqual([expect.objectContaining({
      id: msgId,
      uid: 7,
      name: 'fago',
      via: 'Claude',
      text: 'Fixed the figure.',
    })])
  })

  it('replies into the thread it names rather than opening a second one', () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first']])
    const opened = applyComment(doc, ACTOR, { blockId: 'b-1', text: 'What about the units?' })

    applyComment(doc, ACTOR, { blockId: 'b-1', threadId: opened.threadId, text: 'Metric now.' })

    const threads = readThreads(doc)
    expect(threads).toHaveLength(1)
    // Both messages, in one thread. Their order between themselves is the
    // model's clock, and these two are written in the same millisecond.
    expect(threads[0]!.messages.map(m => m.text).sort())
      .toEqual(['Metric now.', 'What about the units?'])
  })

  it('resolves nothing: the message carries no standing whatever it says', () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first']])
    const { threadId } = applyComment(doc, ACTOR, { blockId: 'b-1', text: 'Done, resolved.' })

    applyComment(doc, ACTOR, { blockId: 'b-1', threadId, text: 'Really done.' })

    expect(readThreads(doc)[0]!.resolved).toBe(false)
  })

  it('refuses a block or a thread nobody could read the message on', () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first']])
    const before = Y.encodeStateAsUpdate(doc)

    expect(() => applyComment(doc, ACTOR, { blockId: 'b-nope', text: 'hello' }))
      .toThrow(UnknownBlockError)
    expect(() => applyComment(doc, ACTOR, { blockId: 'b-1', threadId: 'c-nope', text: 'hello' }))
      .toThrow(UnknownThreadError)

    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })
})

describe('readBlockOpList', () => {
  it('names the op at fault by its index, not the list as a whole', () => {
    expect(readBlockOpList([
      { id: 'b-1', markdown: 'fine' },
      { markdown: 42 },
    ])).toEqual({ fault: 'blocks[1] needs a "markdown" string.' })

    expect(readBlockOpList([
      { id: 'b-1', after: 'b-2', markdown: 'both' },
    ])).toEqual({ fault: 'blocks[0] names id and after — an op has one anchor.' })
  })

  it('takes an anchorless first op — only the document can say whether it lands', () => {
    const ops = [{ markdown: 'orphan' }]
    expect(readBlockOpList(ops)).toEqual({ ops })
  })

  it('takes an anchorless op that follows another one', () => {
    const ops = [{ after: 'b-1', markdown: 'one' }, { markdown: 'two' }]
    expect(readBlockOpList(ops)).toEqual({ ops })
  })

  it('refuses an expect on an anchorless op rather than ignoring it', () => {
    // The op names no block, so there is no version to compare — accepting the
    // field would report a CAS the write never ran.
    expect(readBlockOpList([
      { after: 'b-1', markdown: 'one' },
      { markdown: 'two', expect: 'deadbeef0000' },
    ])).toEqual({
      fault: 'blocks[1] chains after blocks[0], so it names no block to expect a version for.',
    })

    expect(readBlockOpList([{ markdown: 'one', expect: 'deadbeef0000' }])).toEqual({
      fault: 'blocks[0] names no block to expect a version for.',
    })
  })

  it('refuses a value that is not a list of objects', () => {
    expect(readBlockOpList('nope')).toEqual({ fault: '"blocks" must be a list of block ops.' })
    expect(readBlockOpList([null])).toEqual({ fault: 'blocks[0] must be an object.' })
  })
})

describe('refuseStaleBlocks', () => {
  /** The version getPageForEditing would report for a block of this document. */
  function versionOf(doc: Y.Doc, id: string): string {
    return blockVersions(serializeYDoc(doc))[id]!
  }

  it('lets a write through on the version the block actually holds', () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first'], ['b-2', 'second']])
    const ops = [{ id: 'b-2', expect: versionOf(doc, 'b-2'), markdown: 'rewritten' }]

    refuseStaleBlocks(doc, ops)
    applyBlockOps(doc, ops)

    expect(serializeYDoc(doc)).toBe('first {#b-1}\n\nrewritten {#b-2}')
  })

  it('is optional — an op that sends no version is not checked', () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first']])
    expect(() => refuseStaleBlocks(doc, [{ id: 'b-1', markdown: 'rewritten' }])).not.toThrow()
  })

  it("refuses per index, carrying the block's current markdown and version", () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first'], ['b-2', 'second']])
    const stale = versionOf(doc, 'b-2')
    // A human edits the block between the agent's read and its write.
    applyBlockOps(doc, [{ id: 'b-2', markdown: 'second, edited by a human' }])

    const refuse = () => refuseStaleBlocks(doc, [
      { id: 'b-1', expect: versionOf(doc, 'b-1'), markdown: 'fine' },
      { id: 'b-2', expect: stale, markdown: 'agent rewrite' },
    ])

    expect(refuse).toThrow(StaleBlockError)
    // Only the stale op is named, and it carries everything a retry needs.
    expect(() => refuse()).toThrow(expect.objectContaining({
      conflicts: [{
        index: 1,
        id: 'b-2',
        expected: stale,
        version: versionOf(doc, 'b-2'),
        markdown: 'second, edited by a human {#b-2}',
      }],
    }))
  })

  it('refuses an expect it cannot check, naming the block', () => {
    // An expect the check cannot answer is not an expect that passes: no
    // version means the page does not expose the block, and applying the op
    // anyway would be a compare-and-swap with the compare left out.
    const doc = docWithIdentifiedBlocks([['b-1', 'first']])
    expect(() => refuseStaleBlocks(doc, [{ id: 'b-gone', expect: 'abc', markdown: 'x' }]))
      .toThrow(UnknownBlockError)
  })
})

describe('openAgentSession', () => {
  it('reports a cold document as started and a live one as joined', async () => {
    const cold = hostFor(new Y.Doc())
    expect((await openAgentSession(cold.host, 1, ACTOR, noTimers)).entry).toBe('started')

    const live = hostFor(new Y.Doc(), { live: true })
    expect((await openAgentSession(live.host, 1, ACTOR, noTimers)).entry).toBe('joined')
  })

  it('publishes bot presence as its own awareness peer, and withdraws it on leave', async () => {
    const { host, document } = hostFor(new Y.Doc())
    const session = await openAgentSession(host, 1, ACTOR, noTimers)

    const state = document.awareness.getStates().get(session.clientId)
    expect(state).toEqual({ user: { name: 'fago', color: collabColor(7), uid: 7, via: 'Claude' } })

    await session.leave()
    expect(document.awareness.getStates().has(session.clientId)).toBe(false)
  })

  it('republishes presence on the refresh tick — y-protocols would evict it', async () => {
    const timers: Array<() => void> = []
    const { host, document } = hostFor(new Y.Doc())
    const session = await openAgentSession(host, 1, ACTOR, {
      setTimer: (fn) => { timers.push(fn); return 0 as unknown as ReturnType<typeof setInterval> },
      clearTimer: vi.fn(),
    })

    // Simulate the eviction y-protocols performs on an outdated state.
    document.awareness.states.delete(session.clientId)
    timers.forEach(tick => tick())

    expect(document.awareness.getStates().has(session.clientId)).toBe(true)
  })

  it('applies both lanes in one transaction, tagged as an agent write', async () => {
    const { host, document } = hostFor(docFromMarkdownBlocks(['before']))
    const origins: unknown[] = []
    document.on('afterTransaction', tr => origins.push(tr.origin))

    const session = await openAgentSession(host, 1, ACTOR, noTimers)
    const result = session.apply({ fields: { summary: 'new' }, body: 'after' })

    expect(result).toEqual({ fields: ['summary'], body: true, blocks: {} })
    // The block the agent authored carries a minted id, exactly as a browser
    // peer's tracker would have given it.
    expect(serializeYDoc(document)).toMatch(/^after \{#b-[\da-f]+\}$/)
    const agentOrigins = origins.filter(isAgentOrigin)
    expect(agentOrigins).toHaveLength(1)
    expect(agentOrigins[0]).toMatchObject({ agent: true, label: 'fago via Claude' })
  })

  it('seats an agent as a peer carrying its via (ADR 0003)', async () => {
    // Agents are session peers now: the write enters each block's set carrying
    // the agent's `via`, and that member is what raises the agent review step —
    // the requirement travels in the set, not on the checkpoint's credential.
    const { host, document } = hostFor(docFromMarkdownBlocks(['before']))
    const origins: unknown[] = []
    document.on('afterTransaction', tr => origins.push(tr.origin))

    const session = await openAgentSession(host, 1, ACTOR, noTimers)
    session.apply({ body: 'after' })

    expect(origins.filter(isAgentOrigin)[0]!.seat).toEqual({ uid: 7, name: 'fago', via: 'Claude' })
  })

  it('writes no word about who wrote it — that is Drupal\'s to witness', async () => {
    const { host, document } = hostFor(docFromMarkdownBlocks(['before']))
    const session = await openAgentSession(host, 1, ACTOR, { ...noTimers, now: () => 1000 })

    session.apply({ body: 'a whole new block' })

    // The block reaches the document with an id — it has to be addressable —
    // and with nothing said about its authorship. Drupal's presave credits the
    // agent credential and stamps the review flags when the write lands there.
    expect(serializeYDoc(document)).toMatch(/^a whole new block \{#b-[\w-]+\}$/)
    expect(readBlockMeta(document)).toEqual({})
  })

  it('records nothing for a body that only restores what was already there', async () => {
    const { host, document } = hostFor(docFromMarkdownBlocks(['untouched']))
    const session = await openAgentSession(host, 1, ACTOR, { ...noTimers, now: () => 1000 })

    session.apply({ body: 'untouched' })

    expect(serializeYDoc(document)).toBe('untouched')
    expect([...document.getMap('blockMeta').keys()]).toEqual([])
  })

  it('counts browser peers only — its own direct connection is not an observer', async () => {
    const alone = hostFor(new Y.Doc())
    expect((await openAgentSession(alone.host, 1, ACTOR, noTimers)).humanPeers()).toBe(0)

    const watched = hostFor(new Y.Doc(), { websocketPeers: 2 })
    expect((await openAgentSession(watched.host, 1, ACTOR, noTimers)).humanPeers()).toBe(2)
  })

  it('refuses a stale block write, writing neither blocks nor fields', async () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first']])
    const { host, document } = hostFor(doc)
    const session = await openAgentSession(host, 1, ACTOR, noTimers)
    const before = Y.encodeStateAsUpdate(document)

    expect(() => session.apply({
      fields: { summary: 'would have been written' },
      blocks: [{ id: 'b-1', expect: 'deadbeef0000', markdown: 'rewritten' }],
    })).toThrow(StaleBlockError)

    expect(Y.encodeStateAsUpdate(document)).toEqual(before)
  })

  it('claims the blocks it wrote, so a watching human sees where it worked', async () => {
    const { host, document } = hostFor(docWithIdentifiedBlocks([['b-1', 'first']]))
    const session = await openAgentSession(host, 1, ACTOR, noTimers)

    session.apply({ blocks: [{ id: 'b-1', markdown: 'rewritten' }] })

    expect(document.awareness.getStates().get(session.clientId)).toEqual({
      user: { name: 'fago', color: collabColor(7), uid: 7, via: 'Claude' },
      claim: { blocks: ['b-1'] },
    })
  })

  it('leave is idempotent — a second call does not disconnect twice', async () => {
    const { host, disconnect } = hostFor(new Y.Doc())
    const session = await openAgentSession(host, 1, ACTOR, noTimers)
    await session.leave()
    await session.leave()
    expect(disconnect).toHaveBeenCalledOnce()
  })
})
