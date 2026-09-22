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
})
