import { describe, it, expect } from 'vitest'
import type { JSONContent } from '@tiptap/core'
import * as Y from 'yjs'
import {
  blockByline,
  blockers,
  collectBlockIds,
  contributorsSince,
  hasRecord,
  isPending,
  mayApprove,
  mintBlockId,
  mintMissingIds,
  parseBlockMeta,
  readBlockMeta,
  serializeBlockMeta,
  writeBlockMeta,
  type PageBlock,
  type BlockMetaMap,
} from '#shared/page-blocks'
import { parseMarkdownToJson, serializeDocToMarkdown } from '../app/comark/markdown-engine'

/** A paragraph whose whole content is one text node. */
function para(text: string, id?: string): JSONContent {
  return {
    type: 'paragraph',
    ...(id ? { attrs: { id } } : {}),
    content: text ? [{ type: 'text', text }] : [],
  }
}

/** A document wrapping the given top-level blocks. */
function doc(...blocks: JSONContent[]): JSONContent {
  return { type: 'doc', content: blocks }
}

describe('mintBlockId', () => {
  it('prefixes b- and passes the source through', () => {
    expect(mintBlockId(() => 'deadbeef')).toBe('b-deadbeef')
  })

  it('produces distinct ids from the default source', () => {
    const ids = new Set(Array.from({ length: 50 }, () => mintBlockId()))
    expect(ids.size).toBe(50)
  })
})

describe('collectBlockIds', () => {
  it('collects the top-level ids only', () => {
    const tree = doc(
      { type: 'heading', attrs: { level: 2, id: 'b-h' }, content: [{ type: 'text', text: 'H' }] },
      { type: 'callout', attrs: { type: 'info', id: 'b-c' }, content: [para('x', 'b-nested')] },
      para('no id'),
    )
    expect([...collectBlockIds(tree)].sort()).toEqual(['b-c', 'b-h'])
  })
})

describe('mintMissingIds', () => {
  it('assigns an id to each top-level id-bearing block that lacks one', () => {
    const tree = doc(
      para('a'),
      { type: 'heading', attrs: { level: 2, id: 'b-keep' }, content: [{ type: 'text', text: 'b' }] },
      { type: 'callout', attrs: { type: 'info' }, content: [para('c')] },
    )
    let n = 0
    const { json, minted } = mintMissingIds(tree, () => `m${n++}`)
    // The paragraph and the callout. The paragraph INSIDE the callout is not
    // a provenance unit and gets nothing.
    expect(minted).toEqual(['b-m0', 'b-m1'])
    expect(json.content?.[0]?.attrs?.id).toBe('b-m0')
    expect(json.content?.[1]?.attrs?.id).toBe('b-keep')
    expect(json.content?.[2]?.attrs?.id).toBe('b-m1')
    expect(json.content?.[2]?.content?.[0]?.attrs?.id).toBeUndefined()
  })

  it('mints for containers — their id rides the ::block wrapper fence', () => {
    const tree = doc(
      { type: 'bulletList', content: [{ type: 'listItem', content: [para('x')] }] },
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [para('c')] }] }] },
      { type: 'codeBlock', content: [{ type: 'text', text: 'x' }] },
    )
    let n = 0
    const { json, minted } = mintMissingIds(tree, () => `c${n++}`)
    expect(minted).toEqual(['b-c0', 'b-c1', 'b-c2'])
    expect(json.content?.map(node => node.attrs?.id)).toEqual(['b-c0', 'b-c1', 'b-c2'])
  })

  it('re-mints a duplicated id, keeping the first occurrence', () => {
    // What a block split leaves behind: both halves carrying the same id.
    const tree = doc(para('first half', 'b-dup'), para('second half', 'b-dup'))
    const { json, minted } = mintMissingIds(tree, () => 'fresh')
    // Derived from the id it duplicates, not drawn from the source — the source
    // is only ever asked for a block that has no id at all.
    expect(minted).toEqual(['b-dup-2'])
    expect(json.content?.[0]?.attrs?.id).toBe('b-dup')
    expect(json.content?.[1]?.attrs?.id).toBe('b-dup-2')
  })

  it('gives the same duplicate the same id every time it runs', () => {
    // A pass whose answer moved on every run would give an unedited document a
    // different byte sequence at each commit, and the block a new review
    // history with it.
    const tree = doc(para('first half', 'b-dup'), para('second half', 'b-dup'))
    let draws = 0
    const source = () => `draw${draws++}`
    expect(mintMissingIds(tree, source).json).toEqual(mintMissingIds(tree, source).json)
    expect(draws).toBe(0)
  })

  it('steps past a derived id the document already holds', () => {
    const tree = doc(para('a', 'b-dup'), para('b', 'b-dup-2'), para('c', 'b-dup'))
    const { json } = mintMissingIds(tree, () => 'fresh')
    expect(json.content?.map(node => node.attrs?.id)).toEqual(['b-dup', 'b-dup-2', 'b-dup-3'])
  })

  it('does not collide with an existing id', () => {
    const tree = doc(para('a', 'b-x0'), para('b'))
    const seq = ['x0', 'x1']
    let i = 0
    const { json } = mintMissingIds(tree, () => seq[i++]!)
    expect(json.content?.[1]?.attrs?.id).toBe('b-x1')
  })

  it('is a no-op when every block already has a unique id', () => {
    expect(mintMissingIds(doc(para('a', 'b-1'))).minted).toEqual([])
  })
})

describe('markdown engine block-id integration', () => {
  it('parses a heading id into a structured attribute (not text)', async () => {
    const json = await parseMarkdownToJson('## Section title {#b-3f9a}')
    const heading = json.content?.[0]
    expect(heading?.type).toBe('heading')
    expect(heading?.attrs?.id).toBe('b-3f9a')
    expect(heading?.content).toEqual([{ type: 'text', text: 'Section title' }])
  })

  it('serializes a block id back to canonical trailing {#id}', async () => {
    const json: JSONContent = {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { id: 'b-71c2' }, content: [{ type: 'text', text: 'A paragraph carrying a block id.' }] }],
    }
    expect(await serializeDocToMarkdown(json)).toBe('A paragraph carrying a block id. {#b-71c2}')
  })

  it('round-trips markdown byte-identically through the structured attribute', async () => {
    const md = '## Section title {#b-3f9a}\n\nA paragraph carrying a block id. {#b-71c2}'
    expect(await serializeDocToMarkdown(await parseMarkdownToJson(md))).toBe(md)
  })

  it('round-trips a block whose last span is marked', async () => {
    for (const md of [
      'some text **ends bold** {#b-71c2}',
      'some text *ends emphasis* {#b-71c2}',
      'some text `ends code` {#b-71c2}',
      'some text [ends link](https://example.com) {#b-71c2}',
      '**all bold** {#b-71c2}',
      '## Heading **ending bold** {#b-3f9a}',
    ]) {
      expect(await serializeDocToMarkdown(await parseMarkdownToJson(md))).toBe(md)
    }
  })

  it('drops an id written into a marked tail: comark reads it as the mark\'s attribute, not as text', async () => {
    expect(await serializeDocToMarkdown(await parseMarkdownToJson('some text **ends bold {#b-71c2}**')))
      .toBe('some text **ends bold**')
  })
})

describe('the review model', () => {
  /** A block as Drupal's presave leaves it. */
  function block(entry: Partial<PageBlock>): PageBlock {
    return { contributors: [], ...entry }
  }

  const PENDING = block({ 'pending:peer': { by: [3, 7], ok: [] } })
  const SIGNED = block({ 'review:peer': { uid: 9, name: 'ada', at: 1000, vid: 4 } })

  it('reads the flag as the flag — a key present is the whole fact', () => {
    expect(isPending(PENDING, 'peer')).toBe(true)
    expect(isPending(PENDING, 'agent')).toBe(false)
    expect(isPending(SIGNED, 'peer')).toBe(false)
    expect(isPending(undefined, 'peer')).toBe(false)
  })

  // The collab server mirrors the flags its next checkpoint will earn, so a
  // mark follows the edit. It is the same flag: a peer signs it off where the
  // rule lets them, and the checkpoint it rides on carries the session first.
  it('reads an estimated flag as the flag it will be', () => {
    const estimated = block({ 'pending:peer': { by: [3], ok: [], estimated: true } })

    expect(isPending(estimated, 'peer')).toBe(true)
    expect(blockers({ 'b-1': estimated })).toEqual({ 'b-1': ['peer'] })
    expect(mayApprove(estimated, 'peer', { uid: 7, isAdmin: false })).toBe(true)
    expect(mayApprove(estimated, 'peer', { uid: 7, isAdmin: true })).toBe(true)
  })

  // The mirror's baseline is the writer set the collab server witnessed, so
  // four-eyes holds on it exactly as it holds on Drupal's own flag.
  it('withholds an estimated flag from its own sole contributor', () => {
    const estimated = block({ 'pending:peer': { by: [3], ok: [], estimated: true } })

    expect(mayApprove(estimated, 'peer', { uid: 3, isAdmin: false })).toBe(false)
    expect(mayApprove(estimated, 'peer', { uid: 3, isAdmin: true })).toBe(true)
  })

  // An estimate naming nobody is the unaccounted case: no author to exclude,
  // so anybody signs it off — the answer a witnessed empty baseline gives.
  it('offers an estimated flag that names nobody to anybody', () => {
    const nameless = block({ 'pending:peer': { by: [], ok: [], estimated: true } })

    expect(mayApprove(nameless, 'peer', { uid: 7, isAdmin: false })).toBe(true)
    expect(mayApprove(nameless, 'peer', { uid: 7, isAdmin: true })).toBe(true)
    expect(mayApprove(nameless, 'peer', { uid: null, isAdmin: false })).toBe(false)
  })

  it('names the accounts a step is still waiting on', () => {
    expect(contributorsSince(PENDING, 'peer')).toEqual([3, 7])
    expect(contributorsSince(SIGNED, 'peer')).toEqual([])
  })

  it('lists the blockers per enforced step, in block-id order', () => {
    const map: BlockMetaMap = {
      'b-2': block({ 'pending:agent': { by: [9], ok: [] } }),
      'b-1': PENDING,
      'b-3': SIGNED,
    }

    expect(blockers(map)).toEqual({ 'b-1': ['peer'], 'b-2': ['agent'] })
    expect(blockers(map, ['agent'])).toEqual({ 'b-2': ['agent'] })
  })

  // Drupal's gate (PageBlocks::blockers()) owes a review of unaccounted
  // writing in every space: no policy may wave through what nobody was witnessed writing.
  it('lists a step naming no writer even where the space does not enforce it', () => {
    const map: BlockMetaMap = {
      'b-1': block({ 'pending:peer': { by: [], ok: [] } }),
      'b-2': block({ 'pending:peer': { by: [3], ok: [] } }),
    }

    expect(blockers(map, ['agent'])).toEqual({ 'b-1': ['peer'] })
    expect(blockers(map, [])).toEqual({ 'b-1': ['peer'] })
  })

  // The policy names which steps a space asks for; the order a block's debts
  // read in is REVIEW_STEPS', agent first.
  it('owes its steps agent-first, whatever order the policy names them in', () => {
    const map: BlockMetaMap = {
      'b-1': block({ 'pending:peer': { by: [3], ok: [] }, 'pending:agent': { by: [3], ok: [] } }),
    }

    expect(blockers(map, ['peer', 'agent'])).toEqual({ 'b-1': ['agent', 'peer'] })
    expect(blockers(map, ['agent', 'peer'])).toEqual({ 'b-1': ['agent', 'peer'] })
  })

  it('orders contributors by last edit, agent kept apart from the human', () => {
    const byline = blockByline(block({
      contributors: [
        { uid: 3, via: null, name: 'fago', lastEdit: 1000 },
        { uid: 3, via: 'Claude', name: 'fago', lastEdit: 2000 },
      ],
    }))

    expect(byline.contributors.map(c => c.via)).toEqual(['Claude', null])
  })

  it('says nothing about a block that owes nothing and attributes nobody', () => {
    const byline = blockByline(block({}))

    expect(byline.pending).toEqual([])
    expect(byline.review).toEqual({})
    expect(hasRecord(byline)).toBe(false)
  })

  it('round-trips the flags through the stored JSON byte-identically', () => {
    const map: BlockMetaMap = { 'b-1': PENDING, 'b-2': SIGNED }
    const encoded = serializeBlockMeta(map)

    expect(parseBlockMeta(encoded)).toEqual(map)
    expect(serializeBlockMeta(parseBlockMeta(encoded))).toBe(encoded)
  })

  it('serializes an empty sidecar as nothing at all', () => {
    expect(serializeBlockMeta({})).toBe('')
    expect(parseBlockMeta(null)).toEqual({})
    expect(parseBlockMeta('not json')).toEqual({})
  })
})

describe('the sidecar in a session document', () => {

  it('carries Drupal\'s flags through the seed untouched — they are not ours', () => {
    const doc = new Y.Doc()
    const seeded: BlockMetaMap = {
      'b-1': { contributors: [], 'pending:peer': { by: [3], ok: [] } },
    }

    doc.transact(() => writeBlockMeta(doc, seeded))

    expect(readBlockMeta(doc)).toEqual(seeded)
  })
})
