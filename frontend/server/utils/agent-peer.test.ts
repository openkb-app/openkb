import { describe, it, expect, vi, onTestFinished } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { initProseMirrorDoc, prosemirrorJSONToYDoc } from '@tiptap/y-tiptap'
import { editorSchema } from './editor-schema'
import { serializeYDoc } from './commit'
import { agentAwarenessUser } from './agent-awareness'
import {
  agentLabel,
  applyBlockOps,
  applyBodyMarkdown,
  applyComment,
  applyFieldValues,
  DuplicatedBlockError,
  UnanchoredBlockError,
  UnchainedBlockError,
  UnknownBlockError,
  UnknownThreadError,
  UnlistedFileError,
  isAgentOrigin,
  openAgentSession,
  placedVersions,
  readBlockOpList,
  refuseStaleBlocks,
  StaleBlockError,
  validateFieldOps,
  type AgentActor,
  type BlockOp,
  type AgentPeerHost,
} from './agent-peer'
import { blockSegmentsOfDoc, blockVersions } from './block-versions'
import { parseMarkdownToJson } from '../../app/comark/markdown-engine'
import type { FieldSpec } from './entity-fields'
import type { ProseMirrorJSON } from './commit'
import { readBlockMeta } from '#shared/page-blocks'
import { liveFileLists, liveFileNames, liveHiddenFiles, setFileHidden } from '#shared/utils/page-files'
import { readThreads } from '#shared/block-comments'
import { collabColor } from '#shared/utils/presence'

/** Runs while the stale check renders its snapshot: a peer edit landing mid-render. */
const render = vi.hoisted(() => ({ during: undefined as (() => void) | undefined }))
vi.mock('./block-versions', async (original) => {
  const actual = await original<typeof import('./block-versions')>()
  return {
    ...actual,
    blockSegmentsOfDoc: async (json: ProseMirrorJSON) => {
      const segments = await actual.blockSegmentsOfDoc(json)
      render.during?.()
      return segments
    },
  }
})

/** {@link applyBodyMarkdown} as a session calls it: the markdown parsed first. */
async function writeBody(doc: Y.Doc, markdown: string, authored = false): Promise<void> {
  applyBodyMarkdown(doc, await parseMarkdownToJson(markdown), authored)
}

/** {@link applyBlockOps} as a session calls it: ops parsed first, versions read off the write. */
async function writeBlocks(doc: Y.Doc, ops: BlockOp[], authored = false): Promise<Record<string, string>> {
  const parsed = await Promise.all(ops.map(op => parseMarkdownToJson(op.markdown)))
  const { written, placed } = applyBlockOps(doc, ops, parsed, authored)
  return placedVersions(written, placed)
}

/** {@link refuseStaleBlocks} against the document as it stands. */
async function checkStale(doc: Y.Doc, ops: BlockOp[]): Promise<void> {
  const { doc: current } = initProseMirrorDoc(doc.getXmlFragment('default'), editorSchema)
  refuseStaleBlocks(await blockSegmentsOfDoc(current.toJSON() as ProseMirrorJSON), ops)
}

async function versionOf(doc: Y.Doc, id: string): Promise<string> {
  return blockVersions(await serializeYDoc(doc))[id]!
}

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
  it('reads as "owner via label" and carries the owner colour', async () => {
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
  it('writes whole keys and skips values that already match', async () => {
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

  it('leaves keys the ops do not mention alone', async () => {
    const doc = new Y.Doc()
    doc.getMap('fields').set('title', 'Kept')
    applyFieldValues(doc, { summary: 'set' })
    expect(doc.getMap('fields').get('title')).toBe('Kept')
  })
})

describe('validateFieldOps', () => {
  it('refuses a key the exposure contract does not carry', async () => {
    expect(validateFieldOps(SPECS, { nope: 'x' })).toEqual({
      nope: ['No exposed field for frontmatter key "nope".'],
    })
  })

  it('refuses a cardinality mismatch in either direction', async () => {
    expect(Object.keys(validateFieldOps(SPECS, { tags: 'one' }))).toEqual(['tags'])
    expect(Object.keys(validateFieldOps(SPECS, { summary: ['a', 'b'] }))).toEqual(['summary'])
  })

  it('accepts the title (a base field, outside the schema) and valid shapes', async () => {
    expect(validateFieldOps(SPECS, { title: 'A title', summary: 'x', tags: [] })).toEqual({})
    expect(validateFieldOps(SPECS, { title: 42 })).toEqual({ title: ['The title must be a string.'] })
  })
})

describe('applyBodyMarkdown', () => {
  it('serializes back to the markdown it was given', async () => {
    const doc = docFromMarkdownBlocks(['first', 'second'])
    await writeBody(doc, 'first\n\nsecond changed')
    expect(await serializeYDoc(doc)).toBe('first\n\nsecond changed')
  })

  it('leaves untouched blocks as the same Y types — peer positions survive', async () => {
    const doc = docFromMarkdownBlocks(['keep me', 'edit me'])
    const fragment = doc.getXmlFragment('default')
    const firstBefore = fragment.get(0)
    // A relative position anchored in the untouched block, as a peer's cursor
    // would be: it must still resolve after the agent rewrites block two.
    const cursor = Y.createRelativePositionFromTypeIndex(
      (firstBefore as Y.XmlElement).get(0) as unknown as Y.AbstractType<unknown>,
      3,
    )

    await writeBody(doc, 'keep me\n\nrewritten')

    expect(fragment.get(0)).toBe(firstBefore)
    expect(Y.createAbsolutePositionFromRelativePosition(cursor, doc)?.index).toBe(3)
    expect(await serializeYDoc(doc)).toBe('keep me\n\nrewritten')
  })

  it('a no-op body writes no ops at all', async () => {
    const doc = docFromMarkdownBlocks(['unchanged'])
    const before = Y.encodeStateAsUpdate(doc)
    await writeBody(doc, 'unchanged')
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })
})

describe('applyBlockOps', () => {
  it('rewrites the named block and leaves the rest byte-identical', async () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first'], ['b-2', 'second'], ['b-3', 'third']])

    await writeBlocks(doc, [{ id: 'b-2', markdown: 'second, rewritten' }])

    expect(await serializeYDoc(doc)).toBe('first {#b-1}\n\nsecond, rewritten {#b-2}\n\nthird {#b-3}')
  })

  it('leaves the untouched blocks as the same Y types — peer positions survive', async () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'keep me'], ['b-2', 'edit me']])
    const fragment = doc.getXmlFragment('default')
    const firstBefore = fragment.get(0)
    const cursor = Y.createRelativePositionFromTypeIndex(
      (firstBefore as Y.XmlElement).get(0) as unknown as Y.AbstractType<unknown>,
      3,
    )

    await writeBlocks(doc, [{ id: 'b-2', markdown: 'rewritten' }])

    expect(fragment.get(0)).toBe(firstBefore)
    expect(Y.createAbsolutePositionFromRelativePosition(cursor, doc)?.index).toBe(3)
  })

  it('inserts before and after the block it is anchored to', async () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first'], ['b-2', 'second']])

    await writeBlocks(doc, [
      { after: 'b-1', markdown: 'inserted after one' },
      { before: 'b-2', markdown: 'inserted before two' },
    ])

    expect((await serializeYDoc(doc)).split('\n\n').map(line => line.replace(/ \{#b-[\w-]+\}$/, ''))).toEqual([
      'first',
      'inserted after one',
      'inserted before two',
      'second',
    ])
  })

  it('writes nothing to a duplicated block it was not asked to touch', async () => {
    // A person's copy of a block, its id not yet resolved by a commit.
    const doc = docWithIdentifiedBlocks([['b-1', 'caption'], ['b-1', 'caption'], ['b-2', 'second']])
    const fragment = doc.getXmlFragment('default')
    const copy = fragment.get(1)
    const writes: Y.YEvent<Y.AbstractType<unknown>>[] = []
    fragment.observeDeep(events => writes.push(...events))

    await writeBlocks(doc, [{ id: 'b-2', markdown: 'second, rewritten' }], true)

    expect(await serializeYDoc(doc)).toBe('caption {#b-1}\n\ncaption {#b-1}\n\nsecond, rewritten {#b-2}')
    expect(fragment.get(1)).toBe(copy)
    expect(writes.every(event => !event.path.length || event.path[0] === 2)).toBe(true)
  })

  it('refuses an op naming an id two blocks wear, writing nothing', async () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'caption'], ['b-1', 'caption'], ['b-2', 'second']])
    const before = await serializeYDoc(doc)

    await expect(writeBlocks(doc, [{ id: 'b-1', markdown: 'rewritten' }], true)).rejects.toThrow(DuplicatedBlockError)
    await expect(writeBlocks(doc, [{ after: 'b-1', markdown: 'next' }], true)).rejects.toThrow(DuplicatedBlockError)
    expect(await serializeYDoc(doc)).toBe(before)
  })

  it('mints an id for the content it authors, so the sidecar can key on it', async () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first']])

    await writeBlocks(doc, [{ after: 'b-1', markdown: 'brand new' }], true)

    expect(await serializeYDoc(doc)).toMatch(/^first \{#b-1\}\n\nbrand new \{#b-[\da-f]+\}$/)
  })

  it('answers the version each named block holds now', async () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first'], ['b-2', 'second']])

    const versions = await writeBlocks(doc, [{ id: 'b-2', markdown: 'second, rewritten' }])

    // The one canonical helper's answer, read off the body the document now
    // serves — not a second hash of the op's own markdown.
    expect(versions).toEqual({ 'b-2': blockVersions(await serializeYDoc(doc))['b-2'] })
  })

  it('names an inserted block by the id minted for it, not by the anchor', async () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first']])

    const versions = await writeBlocks(doc, [{ after: 'b-1', markdown: 'brand new' }], true)

    // The anchor was not written, so it is not reported; the minted id is the
    // caller's only way to learn where its content landed.
    const [id, ...rest] = Object.keys(versions)
    expect(rest).toEqual([])
    expect(id).toMatch(/^b-[\da-f]+$/)
    expect(id).not.toBe('b-1')
    expect(versions[id!]).toBe(blockVersions(await serializeYDoc(doc))[id!])
  })

  it('chains an edit onto a just-inserted block from the id and hash it answered', async () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first']])

    const inserted = await writeBlocks(doc, [{ after: 'b-1', markdown: 'brand new' }], true)
    const [id, version] = Object.entries(inserted)[0]!
    const ops = [{ id, expect: version, markdown: 'brand new, edited' }]

    // No read between: the id and the hash both came out of the write.
    await expect(checkStale(doc, ops)).resolves.toBeUndefined()
    await writeBlocks(doc, ops, true)
    expect(await serializeYDoc(doc)).toBe(`first {#b-1}\n\nbrand new, edited {#${id}}`)
  })

  it('reports every block a write produced, replacements and insertions alike', async () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first'], ['b-2', 'second']])

    const versions = await writeBlocks(doc, [
      { id: 'b-1', markdown: 'first, rewritten' },
      { before: 'b-2', markdown: 'inserted before two' },
    ], true)

    const served = blockVersions(await serializeYDoc(doc))
    expect(Object.keys(versions)).toHaveLength(2)
    expect(versions['b-1']).toBe(served['b-1'])
    // The insertion's own id, and it is not the anchor's.
    const minted = Object.keys(versions).find(id => id !== 'b-1')!
    expect(minted).not.toBe('b-2')
    expect(versions[minted]).toBe(served[minted])
  })

  it('chains two edits to one block on the version it answered, with no read between', async () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first']])

    const first = await writeBlocks(doc, [{ id: 'b-1', expect: blockVersions(await serializeYDoc(doc))['b-1'], markdown: 'pass one' }])
    const ops = [{ id: 'b-1', expect: first['b-1'], markdown: 'pass two' }]

    // The returned version is a usable `expect`: the CAS check accepts it, so
    // the second edit costs no read.
    await expect(checkStale(doc, ops)).resolves.toBeUndefined()
    await writeBlocks(doc, ops)
    expect(await serializeYDoc(doc)).toBe('pass two {#b-1}')
  })

  it('chains an anchorless op after the block the op before it wrote', async () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first'], ['b-2', 'second']])

    const versions = await writeBlocks(doc, [
      { after: 'b-1', markdown: 'inserted' },
      { markdown: 'chained one' },
      { markdown: 'chained two' },
    ], true)

    // Op order is document order: each lands after the one before it, not all
    // three after the same anchor.
    expect((await serializeYDoc(doc)).split('\n\n').map(line => line.replace(/ \{#b-[\w-]+\}$/, ''))).toEqual([
      'first',
      'inserted',
      'chained one',
      'chained two',
      'second',
    ])
    // Each reports the id minted for it, so the caller can edit what it wrote.
    expect(Object.keys(versions)).toHaveLength(3)
  })

  it('chains after a replacement too — the last block that op wrote', async () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first'], ['b-2', 'second']])

    await writeBlocks(doc, [
      { id: 'b-1', markdown: 'rewritten' },
      { markdown: 'chained' },
    ], true)

    expect((await serializeYDoc(doc)).split('\n\n').map(line => line.replace(/ \{#b-[\w-]+\}$/, ''))).toEqual([
      'rewritten',
      'chained',
      'second',
    ])
  })

  it('fills a document that holds no blocks from an anchorless first op', async () => {
    const doc = docWithIdentifiedBlocks([])

    const versions = await writeBlocks(doc, [
      { markdown: 'the agent writes the first block' },
      { markdown: 'and the second' },
    ], true)

    expect((await serializeYDoc(doc)).split('\n\n').map(line => line.replace(/ \{#b-[\w-]+\}$/, ''))).toEqual([
      'the agent writes the first block',
      'and the second',
    ])
    // Both minted ids come back, so the follow-up edit needs no read.
    expect(Object.keys(versions)).toHaveLength(2)
  })

  it('refuses an anchorless first op when the document holds blocks, writing nothing', async () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first']])
    const before = Y.encodeStateAsUpdate(doc)

    await expect(writeBlocks(doc, [{ markdown: 'orphan' }])).rejects
      .toThrow('blocks[0] needs one of id / after / before — no op precedes it to chain after.')
    await expect(writeBlocks(doc, [{ markdown: 'orphan' }])).rejects.toThrow(UnanchoredBlockError)

    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })

  it('refuses an anchorless op whose predecessor wrote no block, writing nothing', async () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first']])
    const before = Y.encodeStateAsUpdate(doc)

    await expect(writeBlocks(doc, [
      { id: 'b-1', markdown: '' },
      { markdown: 'nothing to follow' },
    ])).rejects.toThrow(UnchainedBlockError)

    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })

  it('refuses a block the page does not hold, writing nothing', async () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first']])
    const before = Y.encodeStateAsUpdate(doc)

    await expect(writeBlocks(doc, [
      { id: 'b-1', markdown: 'fine' },
      { id: 'b-nope', markdown: 'not fine' },
    ])).rejects.toThrow(UnknownBlockError)

    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })
})

describe('applyComment', () => {
  it('says it as the agent — the owner\'s account, carrying the agent label', async () => {
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

  it('replies into the thread it names rather than opening a second one', async () => {
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

  it('resolves nothing: the message carries no standing whatever it says', async () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first']])
    const { threadId } = applyComment(doc, ACTOR, { blockId: 'b-1', text: 'Done, resolved.' })

    applyComment(doc, ACTOR, { blockId: 'b-1', threadId, text: 'Really done.' })

    expect(readThreads(doc)[0]!.resolved).toBe(false)
  })

  it('refuses a block or a thread nobody could read the message on', async () => {
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
  it('names the op at fault by its index, not the list as a whole', async () => {
    expect(readBlockOpList([
      { id: 'b-1', markdown: 'fine' },
      { markdown: 42 },
    ])).toEqual({ fault: 'blocks[1] needs a "markdown" string.' })

    expect(readBlockOpList([
      { id: 'b-1', after: 'b-2', markdown: 'both' },
    ])).toEqual({ fault: 'blocks[0] names id and after — an op has one anchor.' })
  })

  it('takes an anchorless first op — only the document can say whether it lands', async () => {
    const ops = [{ markdown: 'orphan' }]
    expect(readBlockOpList(ops)).toEqual({ ops })
  })

  it('takes an anchorless op that follows another one', async () => {
    const ops = [{ after: 'b-1', markdown: 'one' }, { markdown: 'two' }]
    expect(readBlockOpList(ops)).toEqual({ ops })
  })

  it('refuses an expect on an anchorless op rather than ignoring it', async () => {
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

  it('refuses a value that is not a list of objects', async () => {
    expect(readBlockOpList('nope')).toEqual({ fault: '"blocks" must be a list of block ops.' })
    expect(readBlockOpList([null])).toEqual({ fault: 'blocks[0] must be an object.' })
  })
})

describe('refuseStaleBlocks', () => {
  /** The version getPageForEditing would report for a block of this document. */
  it('lets a write through on the version the block actually holds', async () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first'], ['b-2', 'second']])
    const ops = [{ id: 'b-2', expect: await versionOf(doc, 'b-2'), markdown: 'rewritten' }]

    await checkStale(doc, ops)
    await writeBlocks(doc, ops)

    expect(await serializeYDoc(doc)).toBe('first {#b-1}\n\nrewritten {#b-2}')
  })

  it('is optional — an op that sends no version is not checked', async () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first']])
    await expect(checkStale(doc, [{ id: 'b-1', markdown: 'rewritten' }])).resolves.toBeUndefined()
  })

  it("refuses per index, carrying the block's current markdown and version", async () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first'], ['b-2', 'second']])
    const stale = await versionOf(doc, 'b-2')
    // A human edits the block between the agent's read and its write.
    await writeBlocks(doc, [{ id: 'b-2', markdown: 'second, edited by a human' }])

    const ops = [
      { id: 'b-1', expect: await versionOf(doc, 'b-1'), markdown: 'fine' },
      { id: 'b-2', expect: stale, markdown: 'agent rewrite' },
    ]

    await expect(checkStale(doc, ops)).rejects.toThrow(StaleBlockError)
    // Only the stale op is named, and it carries everything a retry needs.
    await expect(checkStale(doc, ops)).rejects.toThrow(expect.objectContaining({
      conflicts: [{
        index: 1,
        id: 'b-2',
        expected: stale,
        version: await versionOf(doc, 'b-2'),
        markdown: 'second, edited by a human {#b-2}',
      }],
    }))
  })

  it('refuses an expect it cannot check, naming the block', async () => {
    // An expect the check cannot answer is not an expect that passes: no
    // version means the page does not expose the block, and applying the op
    // anyway would be a compare-and-swap with the compare left out.
    const doc = docWithIdentifiedBlocks([['b-1', 'first']])
    await expect(checkStale(doc, [{ id: 'b-gone', expect: 'abc', markdown: 'x' }])).rejects
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
    const result = await session.apply({ fields: { summary: 'new' }, body: 'after' })

    expect(result).toEqual({ fields: ['summary'], body: true, blocks: {} })
    // The block the agent authored carries a minted id, exactly as a browser
    // peer's tracker would have given it.
    expect(await serializeYDoc(document)).toMatch(/^after \{#b-[\da-f]+\}$/)
    const agentOrigins = origins.filter(isAgentOrigin)
    expect(agentOrigins).toHaveLength(1)
    expect(agentOrigins[0]).toMatchObject({ agent: true, label: 'fago via Claude' })
  })

  it('hides a file the write newly shows as ::embed, and leaves the others\' flags alone', async () => {
    const OLD = '11111111-2222-4333-8444-555555555555'
    const NEW = '66666666-7777-4888-9999-000000000000'
    const { host, document } = hostFor(new Y.Doc())
    const session = await openAgentSession(host, 1, ACTOR, noTimers)
    await session.apply({ files: { attachments: { add: [OLD, NEW] } }, body: `::embed{file="${OLD}"}\n::` })
    setFileHidden(document, OLD, false)

    await session.apply({ body: `::embed{file="${OLD}"}\n::\n\n::embed{file="${NEW}"}\n::` })

    expect(liveHiddenFiles(document)).toEqual([NEW])
  })

  it('refuses a name for a file not on its list, and writes nothing', async () => {
    const A = '11111111-2222-4333-8444-555555555555'
    const B = '66666666-7777-4888-9999-000000000000'
    const { host, document } = hostFor(new Y.Doc())
    const session = await openAgentSession(host, 1, ACTOR, noTimers)
    await session.apply({ files: { attachments: { add: [A] } } })

    await expect(session.apply({ fields: { summary: 'new' }, files: { attachments: { names: { [A]: 'Report', [B]: 'Chart' } } } }))
      .rejects.toThrow(UnlistedFileError)
    await expect(session.apply({ files: { attachments: { remove: [A], names: { [A]: 'Report' } } } }))
      .rejects.toThrow(UnlistedFileError)
    expect(liveFileNames(document)).toEqual({})
    expect(liveFileLists(document).attachments).toEqual([A])
    expect(document.getMap('fields').get('summary')).toBeUndefined()

    await session.apply({ files: { attachments: { add: [B], names: { [B]: 'Chart' } } } })
    expect(liveFileNames(document)).toEqual({ [B]: 'Chart' })
  })

  it('seats an agent as a peer carrying its via (ADR 0003)', async () => {
    // Agents are session peers now: the write enters each block's set carrying
    // the agent's `via`, and that member is what raises the agent review step —
    // the requirement travels in the set, not on the checkpoint's credential.
    const { host, document } = hostFor(docFromMarkdownBlocks(['before']))
    const origins: unknown[] = []
    document.on('afterTransaction', tr => origins.push(tr.origin))

    const session = await openAgentSession(host, 1, ACTOR, noTimers)
    await session.apply({ body: 'after' })

    expect(origins.filter(isAgentOrigin)[0]!.seat).toEqual({ uid: 7, name: 'fago', via: 'Claude' })
  })

  it('writes no word about who wrote it — that is Drupal\'s to witness', async () => {
    const { host, document } = hostFor(docFromMarkdownBlocks(['before']))
    const session = await openAgentSession(host, 1, ACTOR, { ...noTimers, now: () => 1000 })

    await session.apply({ body: 'a whole new block' })

    // The block reaches the document with an id — it has to be addressable —
    // and with nothing said about its authorship. Drupal's presave credits the
    // agent credential and stamps the review flags when the write lands there.
    expect(await serializeYDoc(document)).toMatch(/^a whole new block \{#b-[\w-]+\}$/)
    expect(readBlockMeta(document)).toEqual({})
  })

  it('records nothing for a body that only restores what was already there', async () => {
    const { host, document } = hostFor(docFromMarkdownBlocks(['untouched']))
    const session = await openAgentSession(host, 1, ACTOR, { ...noTimers, now: () => 1000 })

    await session.apply({ body: 'untouched' })

    expect(await serializeYDoc(document)).toBe('untouched')
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

    await expect(session.apply({
      fields: { summary: 'would have been written' },
      blocks: [{ id: 'b-1', expect: 'deadbeef0000', markdown: 'rewritten' }],
    })).rejects.toThrow(StaleBlockError)

    expect(Y.encodeStateAsUpdate(document)).toEqual(before)
  })

  it('refuses a write whose block a peer deleted from while the check rendered', async () => {
    const doc = docWithIdentifiedBlocks([['b-1', 'first']])
    const { host, document } = hostFor(doc)
    const session = await openAgentSession(host, 1, ACTOR, noTimers)
    const version = await versionOf(document, 'b-1')
    onTestFinished(() => { render.during = undefined })
    // Delete-only: the state vector does not move, the fragment does.
    render.during = () => {
      render.during = undefined
      const text = document.getXmlFragment('default').get(0) as Y.XmlElement
      ;(text.get(0) as Y.XmlText).delete(0, 2)
    }

    await expect(session.apply({ blocks: [{ id: 'b-1', expect: version, markdown: 'rewritten' }] }))
      .rejects.toThrow(StaleBlockError)
    expect(await serializeYDoc(document)).toBe('rst {#b-1}')
  })

  it('writes one of two parallel applies on the same version, refuses the other', async () => {
    const { host, document } = hostFor(docWithIdentifiedBlocks([['b-1', 'first']]))
    const session = await openAgentSession(host, 1, ACTOR, noTimers)
    const version = await versionOf(document, 'b-1')

    const results = await Promise.allSettled([
      session.apply({ blocks: [{ id: 'b-1', expect: version, markdown: 'one' }] }),
      session.apply({ blocks: [{ id: 'b-1', expect: version, markdown: 'two' }] }),
    ])

    expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(StaleBlockError)
  })

  it('answers 409 when the page changed during every render', async () => {
    const { host, document } = hostFor(docWithIdentifiedBlocks([['b-1', 'first'], ['b-2', 'second']]))
    const session = await openAgentSession(host, 1, ACTOR, noTimers)
    const version = await versionOf(document, 'b-1')
    onTestFinished(() => { render.during = undefined })
    const renders = vi.fn(() => {
      const text = document.getXmlFragment('default').get(1) as Y.XmlElement
      ;(text.get(0) as Y.XmlText).insert(0, 'x')
    })
    render.during = renders

    await expect(session.apply({ blocks: [{ id: 'b-1', expect: version, markdown: 'rewritten' }] }))
      .rejects.toMatchObject({ statusCode: 409 })
    expect(renders).toHaveBeenCalledTimes(3)
  })

  it('a session that left while its versions were placed republishes no presence', async () => {
    const { host, document } = hostFor(docWithIdentifiedBlocks([['b-1', 'first']]))
    const session = await openAgentSession(host, 1, ACTOR, noTimers)

    onTestFinished(() => { render.during = undefined })
    // No expect: the only render is placedVersions', after the write.
    let leaving: Promise<void> | undefined
    render.during = () => {
      render.during = undefined
      leaving = session.leave()
    }

    await session.apply({ blocks: [{ id: 'b-1', markdown: 'rewritten' }] })
    await leaving

    expect(document.awareness.getStates().has(session.clientId)).toBe(false)
  })

  it('claims the blocks it wrote, so a watching human sees where it worked', async () => {
    const { host, document } = hostFor(docWithIdentifiedBlocks([['b-1', 'first']]))
    const session = await openAgentSession(host, 1, ACTOR, noTimers)

    await session.apply({ blocks: [{ id: 'b-1', markdown: 'rewritten' }] })

    expect(document.awareness.getStates().get(session.clientId)).toEqual({
      user: { name: 'fago', color: collabColor(7), uid: 7, via: 'Claude' },
      claim: { blocks: ['b-1'] },
    })
  })

  it('drops the claim once the write has stood for the hold, keeping its presence', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    onTestFinished(() => vi.useRealTimers())
    const { host, document } = hostFor(docWithIdentifiedBlocks([['b-1', 'first']]))
    const session = await openAgentSession(host, 1, ACTOR)

    await session.apply({ blocks: [{ id: 'b-1', markdown: 'rewritten' }] })
    vi.advanceTimersByTime(4_999)
    expect(document.awareness.getStates().get(session.clientId)?.claim).toEqual({ blocks: ['b-1'] })

    vi.advanceTimersByTime(1)
    expect(document.awareness.getStates().get(session.clientId)).toEqual({ user: agentAwarenessUser(ACTOR) })
  })

  it('a second write restarts the hold on the blocks it touched', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    onTestFinished(() => vi.useRealTimers())
    const { host, document } = hostFor(docWithIdentifiedBlocks([['b-1', 'first'], ['b-2', 'second']]))
    const session = await openAgentSession(host, 1, ACTOR)

    await session.apply({ blocks: [{ id: 'b-1', markdown: 'rewritten' }] })
    vi.advanceTimersByTime(4_000)
    await session.apply({ blocks: [{ id: 'b-2', markdown: 'rewritten too' }] })
    vi.advanceTimersByTime(4_000)

    expect(document.awareness.getStates().get(session.clientId)?.claim).toEqual({ blocks: ['b-2'] })
  })

  it('releaseClaim drops the claim at once', async () => {
    const { host, document } = hostFor(docWithIdentifiedBlocks([['b-1', 'first']]))
    const session = await openAgentSession(host, 1, ACTOR, noTimers)

    await session.apply({ blocks: [{ id: 'b-1', markdown: 'rewritten' }] })
    session.releaseClaim()

    expect(document.awareness.getStates().get(session.clientId)).toEqual({ user: agentAwarenessUser(ACTOR) })
  })

  it('leave is idempotent — a second call does not disconnect twice', async () => {
    const { host, disconnect } = hostFor(new Y.Doc())
    const session = await openAgentSession(host, 1, ACTOR, noTimers)
    await session.leave()
    await session.leave()
    expect(disconnect).toHaveBeenCalledOnce()
  })
})
