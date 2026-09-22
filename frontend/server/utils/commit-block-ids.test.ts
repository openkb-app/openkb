import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap'
import { editorSchema } from './editor-schema'

vi.mock('./drupal', () => ({
  fetchCeWorkingCopy: vi.fn(),
  commitKbPageWithAuth: vi.fn(),
}))
import { fetchCeWorkingCopy, commitKbPageWithAuth } from './drupal'
import { commitDocument, mergeCommitHooks } from './commit'
import { splitTitleHeading } from './title-heading'
import { blockIdCommitHooks } from './commit-block-ids'
import { writeBlockMeta, type PageBlock } from '#shared/page-blocks'

const readMock = vi.mocked(fetchCeWorkingCopy)

/** The working copy the concurrency check reads, off a bare page. */
function readsPage(page: unknown): void {
  readMock.mockResolvedValue({ page } as never)
}
const commitMock = vi.mocked(commitKbPageWithAuth)

type Json = Record<string, unknown>

function body(...paragraphs: Array<[string, string | null]>): Json {
  return {
    type: 'doc',
    content: paragraphs.map(([text, id]) => ({
      type: 'paragraph',
      attrs: { id },
      content: [{ type: 'text', text }],
    })),
  }
}

function docWith(json: Json): Y.Doc {
  const doc = prosemirrorJSONToYDoc(editorSchema, json as never, 'default')
  doc.getMap('_meta').set('drupal_changed', 100)
  return doc
}

function hp(docName: string, ydoc: Y.Doc) {
  return { documents: new Map<string, unknown>([[docName, ydoc]]) } as never
}

const HOOKS = mergeCommitHooks(blockIdCommitHooks())

/** The stored text the commit sent: the title heading, the document, a final
 *  newline. The mocked page is titled `X` and carries no heading of its own,
 *  so every write here puts one in front, block id and all. */
function committedMarkdown(): string {
  return commitMock.mock.calls[0]![2] as unknown as string
}

/** The document inside it — the title heading is the write's, not the editor's. */
function committedDocument(): string {
  return splitTitleHeading(committedMarkdown()).body
}

beforeEach(() => {
  readMock.mockReset()
  commitMock.mockReset()
  readsPage({ titleHeading: '', id: 'uuid-1', nid: 1, path: '/kb/x', title: 'X', body: 'stale', changed: 100 } as never)
  commitMock.mockResolvedValue({ changed: 200, review: null })
})

describe('block ids at commit', () => {
  it('re-mints a duplicated id, first occurrence keeping it', async () => {
    // What a split leaves behind on a client without the minter.
    const doc = docWith(body(['first half', 'b-dup'], ['second half', 'b-dup']))
    const result = await commitDocument(hp('node:1', doc), 'node:1', {
      trigger: 'manual', identity: { token: 'collab' }, hooks: HOOKS,
    })
    expect(result.outcome).toBe('committed')
    const ids = [...committedDocument().matchAll(/\{#([\w-]+)\}/g)].map(m => m[1])
    expect(ids[0]).toBe('b-dup')
    expect(ids[1]).not.toBe('b-dup')
    expect(new Set(ids).size).toBe(2)
  })

  it('re-mints the same duplicate to the same id, so a second commit has nothing to write', async () => {
    // Nothing resolves the duplicate in the live document — a commit does not
    // write to the session. A re-mint drawn fresh each time would therefore
    // move the block's id, and its whole review history with it, at every quiet
    // interval for as long as the document is open.
    const doc = docWith(body(['first half', 'b-dup'], ['second half', 'b-dup']))
    const first = await commitDocument(hp('node:1', doc), 'node:1', {
      trigger: 'manual', identity: { token: 'collab' }, hooks: HOOKS,
    })
    expect(first.outcome).toBe('committed')
    const sent = committedMarkdown()
    readsPage({ titleHeading: '', id: 'uuid-1', nid: 1, path: '/kb/x', title: 'X', body: sent, changed: 100 } as never)
    commitMock.mockClear()

    const second = await commitDocument(hp('node:1', doc), 'node:1', {
      trigger: 'quiet', identity: { token: 'collab' }, hooks: HOOKS,
    })
    expect(second.outcome).toBe('clean')
    expect(commitMock).not.toHaveBeenCalled()
  })

  it('leaves the window\'s accounting on the block that keeps the id', async () => {
    // The accounting and the id pass resolve a shared id the same way — the
    // first occurrence — so nothing has to be rewritten to follow a re-mint,
    // and a duplicate cannot carry another block's credit away with it.
    const doc = docWith(body(['typed into', 'b-dup'], ['a duplicate wearing its id', 'b-dup']))
    const window = { 'b-dup': [{ uid: 7, via: null }] }
    const sessionWrite = { secret: 's', actingUid: 7, coAuthors: [{ name: 'ada', via: null }], blocks: window }
    await commitDocument(hp('node:1', doc), 'node:1', {
      trigger: 'manual', identity: { token: 'collab' }, hooks: HOOKS, sessionWrite,
    })

    const ids = [...committedDocument().matchAll(/\{#([\w-]+)\}/g)].map(m => m[1])
    expect(ids).toEqual(['b-dup', 'b-dup-2'])
    // The duplicate reaches Drupal named by nobody, and is stamped unapprovable
    // for it. That is the block the client introduced, never the one it aimed at.
    expect(commitMock.mock.calls[0]![3]?.session?.blocks).toEqual({ 'b-dup': [{ uid: 7, via: null }] })
  })

  it('leaves the id on the block the accounting names, not on the first one', async () => {
    // The attack the accounting resolves and this applies: a duplicate placed
    // BEFORE the block it is aimed at is first in document order, and taking
    // document order for ownership hands it the victim's id — and with it the
    // sidecar tally, the comments and the sign-offs keyed on that id.
    const doc = docWith(body(['a duplicate wearing its id', 'b-dup'], ['typed into', 'b-dup']))
    const window = { 'b-dup': [{ uid: 7, via: null }] }
    const sessionWrite = { secret: 's', actingUid: 7, coAuthors: [{ name: 'ada', via: null }], blocks: window }
    await commitDocument(hp('node:1', doc), 'node:1', {
      trigger: 'manual',
      identity: { token: 'collab' },
      hooks: mergeCommitHooks(blockIdCommitHooks(new Map([['b-dup', 1]]))),
      sessionWrite,
    })

    expect(committedDocument()).toBe('a duplicate wearing its id {#b-dup-2}\n\ntyped into {#b-dup}\n')
    // The window is untouched: it already names the block that keeps the id.
    expect(commitMock.mock.calls[0]![3]?.session?.blocks).toEqual({ 'b-dup': [{ uid: 7, via: null }] })
  })

  it('re-mints past an id the document already carries', async () => {
    // The derived id is only a candidate. `b-dup-2` is a block of its own here,
    // and landing the re-mint on it would merge two blocks' histories — the
    // very thing the pass exists to prevent.
    const doc = docWith(body(['first', 'b-dup'], ['second', 'b-dup'], ['a real b-dup-2', 'b-dup-2']))
    await commitDocument(hp('node:1', doc), 'node:1', {
      trigger: 'manual', identity: { token: 'collab' }, hooks: HOOKS,
    })
    const ids = [...committedDocument().matchAll(/\{#([\w-]+)\}/g)].map(m => m[1])
    expect(ids).toEqual(['b-dup', 'b-dup-3', 'b-dup-2'])
    expect(new Set(ids).size).toBe(3)
  })

  it('leaves the payload alone when no id had to move', async () => {
    const doc = docWith(body(['only one', 'b-1']))
    const sessionWrite = { secret: 's', actingUid: 7, coAuthors: [{ name: 'ada', via: null }], blocks: { 'b-1': [{ uid: 7, via: null }] } }
    await commitDocument(hp('node:1', doc), 'node:1', {
      trigger: 'manual', identity: { token: 'collab' }, hooks: HOOKS, sessionWrite,
    })
    expect(commitMock.mock.calls[0]![3]?.session?.blocks).toEqual({ 'b-1': [{ uid: 7, via: null }] })
  })

  it('leaves an id-less block id-less — a save must not rewrite untouched content', async () => {
    const doc = docWith(body(['keyed', 'b-1'], ['never edited here', null]))
    await commitDocument(hp('node:1', doc), 'node:1', {
      trigger: 'manual', identity: { token: 'collab' }, hooks: HOOKS,
    })
    expect(committedDocument()).toBe('keyed {#b-1}\n\nnever edited here\n')
  })

  it('never sends the review sidecar: it is Drupal\'s to write', async () => {
    const doc = docWith(body(['hello', 'b-1']))
    const forged: PageBlock = {
      contributors: [{ uid: 3, via: null, name: 'fago', lastEdit: 1000 }],
      'review:peer': { uid: 3, name: 'fago', at: 1000, vid: 1 },
    }
    writeBlockMeta(doc, { 'b-1': forged })
    await commitDocument(hp('node:1', doc), 'node:1', {
      trigger: 'manual', identity: { token: 'collab' }, hooks: HOOKS,
    })
    expect(commitMock.mock.calls[0]![3]?.attributes?.field_block_meta).toBeUndefined()
  })

  it('a sidecar-only change is not a reason to write a revision', async () => {
    const doc = docWith(body(['hello', 'b-1']))
    // Body already committed as it stands.
    const first = await commitDocument(hp('node:1', doc), 'node:1', {
      trigger: 'manual', identity: { token: 'collab' }, hooks: HOOKS,
    })
    expect(first.outcome).toBe('committed')
    commitMock.mockClear()

    writeBlockMeta(doc, { 'b-1': { contributors: [{ uid: 3, via: null, name: 'fago', lastEdit: 2000 }] } })
    const second = await commitDocument(hp('node:1', doc), 'node:1', {
      trigger: 'manual', identity: { token: 'collab' }, hooks: HOOKS,
    })
    expect(second.outcome).toBe('clean')
    expect(commitMock).not.toHaveBeenCalled()
  })
})
