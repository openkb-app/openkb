import { describe, it, expect } from 'vitest'
import type { UIMessage } from 'ai'
import type { ToolRun } from '~/utils/chat-answer'
import { announceReceipt, isCommentTurn, receiptForToolRuns, receiptParts, receiptSummary, turnMetadata } from '~/utils/chat-receipt'

const PAGE = '/demo-wiki/authoring-workflow'
const NOTHING_CHANGED = 'Nothing changed: block b-1 already holds exactly this markdown.'

/** A finished tool run as `toolRunsFor()` reads it off a message. */
function run(name: string, input: Record<string, unknown>, output?: unknown, errorText?: string): ToolRun {
  return {
    toolCallId: `${name}-${Math.random()}`,
    name: `tool__openkb_${name}`,
    input,
    output,
    errorText,
    failed: errorText !== undefined,
    running: false,
  }
}

/** A successful write, as the Tool API bridge answers it. */
function written(blocks: Record<string, string>, fields: string[] = [], unchanged: string[] = [], removed: string[] = [], nid = 39) {
  const applied = { fields, body: false, blocks, ...(removed.length ? { removed } : {}) }
  const result: Record<string, unknown> = { ok: true, nid, applied, ...(unchanged.length ? { unchanged } : {}) }
  return { success: true, message: `Updated node ${nid}`, outputs: { result } }
}

describe('receiptForToolRuns', () => {
  it('reads a changed block as a change', () => {
    const receipt = receiptForToolRuns([run('update_blocks', { path: PAGE }, written({ 'b-1': 'v2' }))])

    expect(receipt).toEqual({ changed: true, pages: [{ nid: 39, blocks: ['b-1'] }], removed: [], fields: [], created: false })
    expect(receiptSummary(receipt!)).toBe('1 block changed')
  })

  it('reads a write that changed nothing as "Nothing changed"', () => {
    const receipt = receiptForToolRuns([run('update_blocks', { path: PAGE }, undefined, NOTHING_CHANGED)])

    expect(receipt).toEqual({ changed: false, pages: [], removed: [], fields: [], created: false })
  })

  it('counts each block once per turn, and an unchanged block is no change', () => {
    const receipt = receiptForToolRuns([
      run('update_blocks', { path: PAGE }, undefined, NOTHING_CHANGED),
      run('update_blocks', { path: PAGE }, written({ 'b-1': 'v2' }, [], ['b-2'])),
      run('update_blocks', { nid: 39 }, written({ 'b-1': 'v3', 'b-3': 'v1' })),
      run('update_fields', { path: PAGE }, written({}, ['summary', 'tags'])),
    ])

    expect(receipt!.changed).toBe(true)
    expect(receipt!.pages).toEqual([{ nid: 39, blocks: ['b-1', 'b-3'] }])
    expect(receiptSummary(receipt!)).toBe('2 blocks changed, 2 fields changed')
  })

  it('counts changed blocks per page in one receipt', () => {
    const receipt = receiptForToolRuns([
      run('create_page', { title: 'Release notes', space: 'demo-wiki' }, { success: true, outputs: { path: '/demo-wiki/release-notes', nid: 40 } }),
      run('update_blocks', { path: PAGE }, written({ 'b-1': 'v2' })),
      run('update_blocks', { path: '/demo-wiki/other' }, written({ 'b-7': 'v4', 'b-8': 'v1' }, [], [], [], 41)),
    ])

    expect(receiptSummary(receipt!)).toBe('Page created, 1 block changed, 2 blocks changed')
  })

  it('drops a block changed and then removed in the same turn from the changed ones', () => {
    const receipt = receiptForToolRuns([
      run('update_blocks', { path: PAGE }, written({ 'b-1': 'v2', 'b-2': 'v2' })),
      run('update_blocks', { path: PAGE }, written({}, [], [], ['b-1'])),
    ])

    expect(receipt).toMatchObject({ pages: [{ nid: 39, blocks: ['b-2'] }], removed: ['b-1'] })
    expect(receiptSummary(receipt!)).toBe('1 block changed, 1 block removed')
  })

  it('gives a comment turn that wrote nothing a "Nothing changed" receipt', () => {
    const reply = run('comment_on_block', { path: PAGE, blockId: 'b-1', threadId: 'c-1', text: 'Yes, it is correct.' }, written({}))

    expect(receiptForToolRuns([reply], true)).toMatchObject({ changed: false })
  })

  it('gives a turn without a write tool no receipt', () => {
    expect(receiptForToolRuns([run('comment_on_block', { path: PAGE, blockId: 'b-1', text: 'Noted.' }, written({}))])).toBeNull()
    expect(receiptForToolRuns([])).toBeNull()
  })

  it('reads a result whose lists are not lists as no change, without throwing', () => {
    const applied = { blocks: ['b-1'], removed: { 'b-2': true }, fields: 3 }
    const odd = { success: true, outputs: { result: { ok: true, nid: 39, applied } } }

    expect(receiptForToolRuns([run('update_blocks', { path: PAGE }, odd)])).toMatchObject({ changed: false })
  })

  it('waits for a running write before it says anything', () => {
    const running = { ...run('update_blocks', { path: PAGE }), running: true }

    expect(receiptForToolRuns([running])).toBeNull()
  })

  it('says nothing for a comment turn while its write runs, but keeps a change already made', () => {
    const running = { ...run('update_blocks', { path: PAGE }), running: true }
    const done = run('update_blocks', { path: PAGE }, written({ 'b-1': 'v2' }))

    expect(receiptForToolRuns([running], true)).toBeNull()
    expect(receiptForToolRuns([done, running], true)).toMatchObject({ changed: true, pages: [{ nid: 39, blocks: ['b-1'] }] })
  })
})

describe('receiptParts', () => {
  it("links each page's changed blocks to its editor at the first changed block, by node id", () => {
    const receipt = receiptForToolRuns([
      run('update_blocks', { path: PAGE }, written({ 'b-1': 'v2', 'b-2': 'v1' })),
      run('update_blocks', { nid: 41 }, written({ 'b-7': 'v4' }, [], [], [], 41)),
      run('update_blocks', { path: PAGE }, written({ 'b-3': 'v1' })),
    ])!

    expect(receiptParts(receipt)).toEqual([
      { text: '3 blocks changed', href: '/node/39/edit#b-1' },
      { text: '1 block changed', href: '/node/41/edit#b-7' },
    ])
  })

  it('links nothing but changed blocks, and nothing for a result without a node id', () => {
    const noNid = { success: true, outputs: { result: { ok: true, applied: { blocks: { 'b-1': 'v2' } } } } }
    const receipt = receiptForToolRuns([
      run('update_blocks', { path: PAGE }, noNid),
      run('update_blocks', { path: PAGE }, written({}, ['title'], [], ['b-5'])),
    ])!

    expect(receiptParts(receipt)).toEqual([
      { text: '1 block changed', href: null },
      { text: '1 block removed', href: null },
      { text: '1 field changed', href: null },
    ])
  })

  it('links nothing for a receipt without a changed block', () => {
    const removed = receiptForToolRuns([run('update_blocks', { path: PAGE }, written({}, [], [], ['b-1']))])!
    const unchanged = receiptForToolRuns([run('update_blocks', { path: PAGE }, undefined, NOTHING_CHANGED)])!

    expect(removed.changed).toBe(true)
    expect(receiptParts(removed)).toEqual([{ text: '1 block removed', href: null }])
    expect(receiptParts(unchanged)).toEqual([])
  })
})

describe('announceReceipt', () => {
  it('says what changed, or that nothing did', () => {
    const changed = receiptForToolRuns([run('update_blocks', { path: PAGE }, written({ 'b-1': 'v2' }))])!
    const unchanged = receiptForToolRuns([run('update_blocks', { path: PAGE }, undefined, NOTHING_CHANGED)])!

    expect(announceReceipt(changed)).toBe('Changed: 1 block changed.')
    expect(announceReceipt(unchanged)).toBe('Nothing changed.')
  })
})

describe('turn metadata', () => {
  it('tells a comment turn from any other message', () => {
    const comment = { id: 'u1', role: 'user', parts: [], metadata: turnMetadata(true) } as UIMessage
    const question = { id: 'u2', role: 'user', parts: [], metadata: turnMetadata(false) } as UIMessage
    const bare = { id: 'u3', role: 'user', parts: [] } as UIMessage

    expect(isCommentTurn(comment)).toBe(true)
    expect(question.metadata).toEqual({})
    expect(isCommentTurn(question)).toBe(false)
    expect(isCommentTurn(bare)).toBe(false)
  })
})
