import { describe, it, expect } from 'vitest'
import type { UIMessage } from 'ai'
import type { ToolRun } from '~/utils/chat-answer'
import { announceReceipt, isCommentTurn, receiptForToolRuns, receiptHref, receiptSummary, turnMetadata, turnPagePathOf } from '~/utils/chat-receipt'

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
function written(blocks: Record<string, string>, fields: string[] = [], unchanged: string[] = [], removed: string[] = []) {
  const applied = { fields, body: false, blocks, ...(removed.length ? { removed } : {}) }
  const result: Record<string, unknown> = { ok: true, nid: 39, applied, ...(unchanged.length ? { unchanged } : {}) }
  return { success: true, message: 'Updated node 39', outputs: { result } }
}

/** A page that holds every block. */
const ON_PAGE = () => true

describe('receiptForToolRuns', () => {
  it('reads a changed block as a change', () => {
    const receipt = receiptForToolRuns([run('update_blocks', { path: PAGE }, written({ 'b-1': 'v2' }))])

    expect(receipt).toEqual({ changed: true, blocks: ['b-1'], removed: [], fields: [], created: false })
    expect(receiptSummary(receipt!)).toBe('1 block changed')
  })

  it('reads a write that changed nothing as "Nothing changed"', () => {
    const receipt = receiptForToolRuns([run('update_blocks', { path: PAGE }, undefined, NOTHING_CHANGED)])

    expect(receipt).toEqual({ changed: false, blocks: [], removed: [], fields: [], created: false })
  })

  it('counts each block once per turn, and an unchanged block is no change', () => {
    const receipt = receiptForToolRuns([
      run('update_blocks', { path: PAGE }, undefined, NOTHING_CHANGED),
      run('update_blocks', { path: PAGE }, written({ 'b-1': 'v2' }, [], ['b-2'])),
      run('update_blocks', { nid: 39 }, written({ 'b-1': 'v3', 'b-3': 'v1' })),
      run('update_fields', { path: PAGE }, written({}, ['summary', 'tags'])),
    ])

    expect(receipt!.changed).toBe(true)
    expect(receipt!.blocks).toEqual(['b-1', 'b-3'])
    expect(receiptSummary(receipt!)).toBe('2 blocks changed, 2 fields changed')
  })

  it('sums writes to two pages in one receipt', () => {
    const receipt = receiptForToolRuns([
      run('create_page', { title: 'Release notes', space: 'demo-wiki' }, { success: true, outputs: { path: '/demo-wiki/release-notes', nid: 40 } }),
      run('update_blocks', { path: PAGE }, written({ 'b-1': 'v2' })),
      run('update_blocks', { path: '/demo-wiki/other' }, written({ 'b-7': 'v4' })),
    ])

    expect(receiptSummary(receipt!)).toBe('Page created, 2 blocks changed')
  })

  it('drops a block changed and then removed in the same turn from the changed ones', () => {
    const receipt = receiptForToolRuns([
      run('update_blocks', { path: PAGE }, written({ 'b-1': 'v2', 'b-2': 'v2' })),
      run('update_blocks', { path: PAGE }, written({}, [], [], ['b-1'])),
    ])

    expect(receipt).toMatchObject({ blocks: ['b-2'], removed: ['b-1'] })
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
    expect(receiptForToolRuns([done, running], true)).toMatchObject({ changed: true, blocks: ['b-1'] })
  })
})

describe('receiptHref', () => {
  const changed = receiptForToolRuns([run('update_blocks', { path: PAGE }, written({ 'b-1': 'v2', 'b-2': 'v1' }))])!

  it("opens the editor of the turn's page at the first changed block while that page is open", () => {
    expect(receiptHref(changed, PAGE, PAGE, ON_PAGE)).toBe('/demo-wiki/authoring-workflow?edit#b-1')
  })

  it('links nothing when that block is not on the page open now, or no page is open', () => {
    expect(receiptHref(changed, PAGE, PAGE, id => id === 'b-2')).toBeNull()
    expect(receiptHref(changed, PAGE, null, ON_PAGE)).toBeNull()
  })

  it('links nothing once the reader went to another page, or when the turn was sent from no page', () => {
    expect(receiptHref(changed, PAGE, '/demo-wiki/other', ON_PAGE)).toBeNull()
    expect(receiptHref(changed, null, PAGE, ON_PAGE)).toBeNull()
  })

  it('links nothing for a receipt without a changed block', () => {
    const removed = receiptForToolRuns([run('update_blocks', { path: PAGE }, written({}, [], [], ['b-1']))])!
    const unchanged = receiptForToolRuns([run('update_blocks', { path: PAGE }, undefined, NOTHING_CHANGED)])!

    expect(removed.changed).toBe(true)
    expect(receiptSummary(removed)).toBe('1 block removed')
    expect(receiptHref(removed, PAGE, PAGE, ON_PAGE)).toBeNull()
    expect(receiptHref(unchanged, PAGE, PAGE, ON_PAGE)).toBeNull()
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
  it('tells a comment turn from any other message, and keeps the page it was sent from', () => {
    const comment = { id: 'u1', role: 'user', parts: [], metadata: turnMetadata(true, PAGE) } as UIMessage
    const question = { id: 'u2', role: 'user', parts: [], metadata: turnMetadata(false, null) } as UIMessage
    const bare = { id: 'u3', role: 'user', parts: [] } as UIMessage

    expect(isCommentTurn(comment)).toBe(true)
    expect(turnPagePathOf(comment)).toBe(PAGE)
    expect(isCommentTurn(question)).toBe(false)
    expect(turnPagePathOf(question)).toBeNull()
    expect(isCommentTurn(bare)).toBe(false)
    expect(turnPagePathOf(bare)).toBeNull()
  })
})
