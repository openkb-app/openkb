import { describe, it, expect } from 'vitest'
import type { JSONContent } from '@tiptap/core'
import { editorSchema } from './editor-schema'
import { parseMarkdownToJson } from '../../app/comark/markdown-engine'
import { mintAuthoredIds } from './agent-block-ids'

/** Sequential ids, so a minting assertion can name them. */
function ids(): () => string {
  let n = 0
  return () => `m${++n}`
}

function docFrom(markdown: string) {
  return editorSchema.nodeFromJSON(parseMarkdownToJson(markdown))
}

/** Top-level `attrs.id` per block, `null` where absent. */
function blockIds(json: JSONContent): Array<string | null> {
  return (json.content ?? []).map(n => (n.attrs as { id?: string } | undefined)?.id ?? null)
}

describe('mintAuthoredIds', () => {
  it('ids the blocks the write authored and leaves carried-through blocks alone', () => {
    const before = docFrom('kept\n\nedited {#b-2}')
    const after = parseMarkdownToJson('kept\n\nedited more {#b-2}\n\nbrand new')

    const { json, minted } = mintAuthoredIds(before, after, ids())

    // The untouched id-less block stays id-less — a commit must not stamp ids
    // into content the session never touched.
    expect(blockIds(json)).toEqual([null, 'b-2', 'b-m1'])
    expect(minted).toEqual(['b-m1'])
  })

  it('keeps the ids the markdown already carries', () => {
    const before = docFrom('one {#b-1}\n\ntwo {#b-2}')
    const { json, minted } = mintAuthoredIds(before, parseMarkdownToJson('one {#b-1}\n\ntwo {#b-2}'), ids())
    expect(blockIds(json)).toEqual(['b-1', 'b-2'])
    expect(minted).toEqual([])
  })

  it('re-mints a duplicated id, first occurrence keeping it', () => {
    const before = docFrom('one {#b-1}')
    const { json, minted } = mintAuthoredIds(before, parseMarkdownToJson('one {#b-1}\n\ntwo {#b-1}'), ids())
    expect(blockIds(json)).toEqual(['b-1', 'b-m1'])
    expect(minted).toEqual(['b-m1'])
  })

  it('leaves a duplicated id a peer left in the document to the commit', () => {
    const before = docFrom('copied {#b-1}\n\ncopied {#b-1}\n\nother {#b-2}')
    const after = parseMarkdownToJson('copied {#b-1}\n\ncopied {#b-1}\n\nother, edited {#b-2}')

    const { json, minted } = mintAuthoredIds(before, after, ids())

    // The copy is the peer's block; only the peer's write may credit it.
    expect(blockIds(json)).toEqual(['b-1', 'b-1', 'b-2'])
    expect(minted).toEqual([])
  })

  it('mints for the extra copy when a block is duplicated verbatim', () => {
    const before = docFrom('same')
    const { json } = mintAuthoredIds(before, parseMarkdownToJson('same\n\nsame'), ids())
    expect(blockIds(json)).toEqual([null, 'b-m1'])
  })

  it('ids an authored container — its id rides the ::block wrapper fence', () => {
    const before = docFrom('intro')
    const { json, minted } = mintAuthoredIds(before, parseMarkdownToJson('intro\n\n- a\n- b'), ids())
    expect(blockIds(json)).toEqual([null, 'b-m1'])
    expect(minted).toEqual(['b-m1'])
  })

  it('re-mints an authored block that copies an id, even placed before the carried one', () => {
    const before = docFrom('one {#b-1}\n\ntwo {#b-2}')
    const after = parseMarkdownToJson('copied id {#b-2}\n\none {#b-1}\n\ntwo {#b-2}')

    const { json, minted } = mintAuthoredIds(before, after, ids())

    expect(blockIds(json)).toEqual(['b-m1', 'b-1', 'b-2'])
    expect(minted).toEqual(['b-m1'])
  })

  it('re-mints the same authored block placed after the carried one', () => {
    const before = docFrom('one {#b-1}\n\ntwo {#b-2}')
    const after = parseMarkdownToJson('one {#b-1}\n\ntwo {#b-2}\n\ncopied id {#b-2}')

    expect(blockIds(mintAuthoredIds(before, after, ids()).json)).toEqual(['b-1', 'b-2', 'b-m1'])
  })
})
