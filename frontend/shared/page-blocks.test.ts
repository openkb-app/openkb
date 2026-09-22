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
  liftBlockIds,
  lowerBlockIds,
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

/** The first top-level block of a lifted/lowered document. */
function first(d: JSONContent): JSONContent {
  return d.content![0]!
}

describe('liftBlockIds', () => {
  it('lifts a trailing {#id} off a top-level paragraph onto attrs.id', () => {
    const p = first(liftBlockIds(doc(para('Hello world {#b-71c2}'))))
    expect(p.attrs?.id).toBe('b-71c2')
    expect(p.content).toEqual([{ type: 'text', text: 'Hello world' }])
  })

  it('lifts off a heading and preserves the heading level', () => {
    const h = first(liftBlockIds(doc({
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Section title {#b-3f9a}' }],
    })))
    expect(h.attrs).toMatchObject({ level: 2, id: 'b-3f9a' })
    expect(h.content).toEqual([{ type: 'text', text: 'Section title' }])
  })

  it('leaves a nested paragraph alone — a blockquote keeps its id as text', () => {
    // comark attaches this id to the BLOCKQUOTE, not the inner paragraph; a
    // container's own id rides the ::block wrapper fence, never trailing
    // text. Untouched text round-trips byte-identically.
    const bq = first(liftBlockIds(doc({
      type: 'blockquote',
      content: [para('A quoted block. {#b-8d4e}')],
    })))
    expect(bq.content?.[0]?.attrs?.id).toBeUndefined()
    expect(bq.content?.[0]?.content).toEqual([{ type: 'text', text: 'A quoted block. {#b-8d4e}' }])
  })

  it('leaves list-item text alone', () => {
    const list = first(liftBlockIds(doc({
      type: 'bulletList',
      content: [{ type: 'listItem', content: [para('first item {#b-a001}')] }],
    })))
    expect(list.attrs?.id).toBeUndefined()
    expect(list.content?.[0]?.content?.[0]?.content)
      .toEqual([{ type: 'text', text: 'first item {#b-a001}' }])
  })

  it('leaves a block with no trailing id untouched', () => {
    const p = first(liftBlockIds(doc(para('Just prose.'))))
    expect(p.attrs?.id).toBeUndefined()
    expect(p.content).toEqual([{ type: 'text', text: 'Just prose.' }])
  })

  it('does not treat a non-id trailing brace as an id', () => {
    // `{#anything with spaces}` is not the `[\w-]+` shorthand shape.
    expect(first(liftBlockIds(doc(para('See rule {#a b}')))).attrs?.id).toBeUndefined()
  })

  it('drops the text node entirely when the block is only an id', () => {
    const p = first(liftBlockIds(doc(para('{#b-only}'))))
    expect(p.attrs?.id).toBe('b-only')
    expect(p.content).toEqual([])
  })

  it('does not mutate its input', () => {
    const input = doc(para('Hello {#b-1234}'))
    const snapshot = JSON.parse(JSON.stringify(input))
    liftBlockIds(input)
    expect(input).toEqual(snapshot)
  })

  it('dissolves a ::block wrapper onto its container', () => {
    const table = { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [para('c')] }] }] }
    const lifted = liftBlockIds(doc({ type: 'blockWrapper', attrs: { id: 'b-w1' }, content: [table] }))
    expect(lifted.content).toHaveLength(1)
    expect(first(lifted).type).toBe('table')
    expect(first(lifted).attrs?.id).toBe('b-w1')
  })

  it('dissolves a hand-authored multi-child wrapper into top-level blocks', () => {
    const lifted = liftBlockIds(doc({
      type: 'blockWrapper',
      attrs: { id: 'b-w2' },
      content: [para('one'), para('two {#b-own}')],
    }))
    expect(lifted.content?.map(node => node.type)).toEqual(['paragraph', 'paragraph'])
    // The wrapper id lands on the first child; a child's own trailing id wins.
    expect(lifted.content?.[0]?.attrs?.id).toBe('b-w2')
    expect(lifted.content?.[1]?.attrs?.id).toBe('b-own')
  })
})

describe('lowerBlockIds', () => {
  it('puts attrs.id back as trailing text and clears the attribute', () => {
    const p = first(lowerBlockIds(doc(para('Hello world', 'b-71c2'))))
    expect(p.content).toEqual([{ type: 'text', text: 'Hello world {#b-71c2}' }])
    expect((p.attrs as { id?: unknown })?.id).toBeUndefined()
  })

  it('keeps the id out of a marked tail', () => {
    // Joined onto the marked node, the id serializes inside the mark's
    // delimiters (`**ends bold {#b-1}**`), where it is no longer trailing and
    // no segmentation can find it.
    for (const mark of ['bold', 'italic', 'code', { type: 'link', attrs: { href: 'https://example.com' } }]) {
      const p = first(lowerBlockIds(doc({
        type: 'paragraph',
        attrs: { id: 'b-71c2' },
        content: [
          { type: 'text', text: 'some text ' },
          { type: 'text', text: 'tail', marks: [typeof mark === 'string' ? { type: mark } : mark] },
        ],
      })))
      expect(p.content?.[2]).toEqual({ type: 'text', text: ' {#b-71c2}' })
    }
  })

  it('adds no leading space for an id-only block', () => {
    const p = first(lowerBlockIds(doc({ type: 'paragraph', attrs: { id: 'b-only' }, content: [] })))
    expect(p.content).toEqual([{ type: 'text', text: '{#b-only}' }])
  })

  it('leaves a block without an id untouched', () => {
    expect(first(lowerBlockIds(doc(para('Plain')))).content)
      .toEqual([{ type: 'text', text: 'Plain' }])
  })

  it('never lowers an id sitting on a nested block', () => {
    // A stray nested id (e.g. a top-level paragraph dragged into a list) is
    // inert: it must not leak `{#id}` into list-item or table-cell text.
    const list = first(lowerBlockIds(doc({
      type: 'bulletList',
      content: [{ type: 'listItem', content: [para('item', 'b-stray')] }],
    })))
    expect(list.content?.[0]?.content?.[0]?.content)
      .toEqual([{ type: 'text', text: 'item' }])
  })

  it('does not mutate its input', () => {
    const input = doc(para('Hello', 'b-1234'))
    const snapshot = JSON.parse(JSON.stringify(input))
    lowerBlockIds(input)
    expect(input).toEqual(snapshot)
  })

  it('folds an id-carrying container into a ::block wrapper', () => {
    const table = { type: 'table', attrs: { id: 'b-w1' }, content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [para('c')] }] }] }
    const lowered = first(lowerBlockIds(doc(table)))
    expect(lowered.type).toBe('blockWrapper')
    expect(lowered.attrs).toEqual({ id: 'b-w1' })
    expect(lowered.content?.[0]?.type).toBe('table')
    expect((lowered.content?.[0]?.attrs as { id?: unknown } | undefined)?.id).toBeUndefined()
  })

  it('leaves either image form to its own renderer, which carries the id', () => {
    const plain = { type: 'image', attrs: { id: 'b-i1', src: 'https://example.com/a.png', alt: 'A', media: null } }
    const media = { type: 'image', attrs: { id: 'b-i2', media: '1111', alt: 'A' } }
    expect(first(lowerBlockIds(doc(plain)))).toEqual(plain)
    expect(first(lowerBlockIds(doc(media)))).toEqual(media)
  })

  it('serializes an id-less container bare — no wrapper to emit', () => {
    const table = { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [para('c')] }] }] }
    expect(first(lowerBlockIds(doc(table)))).toEqual(table)
  })
})

describe('lift/lower round-trip', () => {
  it('is the identity on a lifted tree', () => {
    const lowered = lowerBlockIds(liftBlockIds(doc(para('Hello world {#b-71c2}'))))
    expect(first(lowered).content).toEqual([{ type: 'text', text: 'Hello world {#b-71c2}' }])
  })
})

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
  it('parses a heading id into a structured attribute (not text)', () => {
    const json = parseMarkdownToJson('## Section title {#b-3f9a}')
    const heading = json.content?.[0]
    expect(heading?.type).toBe('heading')
    expect(heading?.attrs?.id).toBe('b-3f9a')
    expect(heading?.content).toEqual([{ type: 'text', text: 'Section title' }])
  })

  it('serializes a block id back to canonical trailing {#id}', () => {
    const json: JSONContent = {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { id: 'b-71c2' }, content: [{ type: 'text', text: 'A paragraph carrying a block id.' }] }],
    }
    expect(serializeDocToMarkdown(json)).toBe('A paragraph carrying a block id. {#b-71c2}')
  })

  it('round-trips markdown byte-identically through the structured attribute', () => {
    const md = '## Section title {#b-3f9a}\n\nA paragraph carrying a block id. {#b-71c2}'
    expect(serializeDocToMarkdown(parseMarkdownToJson(md))).toBe(md)
  })

  it('round-trips a block whose last span is marked', () => {
    for (const md of [
      'some text **ends bold** {#b-71c2}',
      'some text *ends emphasis* {#b-71c2}',
      'some text `ends code` {#b-71c2}',
      'some text [ends link](https://example.com) {#b-71c2}',
      '**all bold** {#b-71c2}',
      '## Heading **ending bold** {#b-3f9a}',
    ]) {
      expect(serializeDocToMarkdown(parseMarkdownToJson(md))).toBe(md)
    }
  })

  it('heals a block whose id was written into its marked tail', () => {
    expect(serializeDocToMarkdown(parseMarkdownToJson('some text **ends bold {#b-71c2}**')))
      .toBe('some text **ends bold** {#b-71c2}')
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

  // An estimate naming nobody is the unaccounted case, admins only — the same
  // answer a witnessed flag with an empty baseline gives.
  it('withholds an estimated flag that names nobody', () => {
    const nameless = block({ 'pending:peer': { by: [], ok: [], estimated: true } })

    expect(mayApprove(nameless, 'peer', { uid: 7, isAdmin: false })).toBe(false)
    expect(mayApprove(nameless, 'peer', { uid: 7, isAdmin: true })).toBe(true)
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
