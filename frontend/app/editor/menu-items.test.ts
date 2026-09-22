import { describe, it, expect, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import type { Node as ProseNode } from '@tiptap/pm/model'
import { editorSchema } from '../../server/utils/editor-schema'
import { comarkHandlers, slashItems, tableBubbleItems, tableOpItems, tableToolbarItem } from './menu-items'
import { takeLinkSelection } from './doc-link-selection'

/** An editor whose chain records the calls a handler makes on it. */
function recordingEditor(selection: { from: number, to: number }, text = '') {
  const calls: Array<[string, unknown]> = []
  const chain: Record<string, (arg?: unknown) => unknown> = {}
  for (const name of ['focus', 'setTextSelection', 'insertContent']) {
    chain[name] = (arg?: unknown) => {
      calls.push([name, arg])
      return chain
    }
  }
  const editor = {
    chain: () => chain,
    state: { selection, doc: { textBetween: () => text } },
  } as unknown as Editor
  return { editor, calls }
}

describe('the document-link opener', () => {
  it('puts the trigger at the caret when there is no selection', () => {
    const { editor, calls } = recordingEditor({ from: 17, to: 17 })

    comarkHandlers.docLink!.execute(editor)

    expect(calls).toEqual([
      ['focus', undefined],
      ['setTextSelection', 17],
      ['insertContent', '[['],
    ])
  })

  it('puts the trigger over a selection, whose words it records as the label', () => {
    const { editor, calls } = recordingEditor({ from: 12, to: 31 }, 'the escalation path')

    comarkHandlers.docLink!.execute(editor)

    // No `setTextSelection`: the `[[` replaces the selected words, and the
    // pick puts them back as the link's label.
    expect(calls).toEqual([
      ['focus', undefined],
      ['insertContent', '[['],
    ])
    expect(takeLinkSelection(12)).toBe('the escalation path')
  })

  it('is offered by the slash menu', () => {
    const item = slashItems.flat().find(entry => 'kind' in entry && entry.kind === 'docLink')
    expect(item).toMatchObject({ label: 'Link to a page' })
  })
})

/**
 * A recording editor over a real document, for the handlers that read the
 * document to place the caret.
 */
function docEditor(doc: ProseNode) {
  const calls: Array<[string, unknown]> = []
  const chain: Record<string, (arg?: unknown) => unknown> = {}
  for (const name of ['focus', 'setTextSelection', 'addRowAfter', 'addColumnAfter']) {
    chain[name] = (arg?: unknown) => {
      calls.push([name, arg])
      return chain
    }
  }
  // `can().chain()` answers whether the chain would apply; `run` says it would.
  const canChain: Record<string, (arg?: unknown) => unknown> = { run: () => true }
  for (const name of ['setTextSelection', 'addRowAfter', 'addColumnAfter']) canChain[name] = () => canChain
  const editor = {
    chain: () => chain,
    can: () => ({ chain: () => canChain }),
    state: { doc },
  } as unknown as Editor
  return { editor, calls }
}

/** A 2×2 table at the top of the document, cells 'A' 'B' / '1' '2'. */
function tableDoc(): ProseNode {
  const cell = (text: string) =>
    editorSchema.node('tableCell', null, [editorSchema.node('paragraph', null, editorSchema.text(text))])
  const row = (...texts: string[]) => editorSchema.node('tableRow', null, texts.map(cell))
  return editorSchema.node('doc', null, [
    editorSchema.node('table', null, [row('A', 'B'), row('1', '2')]),
  ])
}

describe('the table controls', () => {
  it('offers every row and column operation, once, on every surface', () => {
    expect(tableOpItems.map(item => item.label)).toEqual([
      'Add row above', 'Add row below', 'Delete row',
      'Add column left', 'Add column right', 'Delete column',
    ])
    for (const item of tableOpItems) expect(comarkHandlers[item.kind]).toBeTruthy()
  })

  it('frames the toolbar dropdown with insert and delete', () => {
    expect(tableToolbarItem.items.map(item => item.kind)).toEqual([
      'table', ...tableOpItems.map(item => item.kind), 'tableDeleteTable',
    ])
  })

  it('gives the bubble the same operations as icon buttons that name themselves', () => {
    expect(tableBubbleItems.map(item => item.kind)).toEqual(tableOpItems.map(item => item.kind))
    expect(tableBubbleItems.map(item => item['aria-label'])).toEqual(tableOpItems.map(item => item.label))
    for (const item of tableBubbleItems) expect(item.tooltip.text).toBe(item['aria-label'])
  })

  // The block menu opens with the table node-selected, which prosemirror-tables
  // cannot read a row or column off.
  it('puts the caret in the table’s last cell before a block-menu operation', () => {
    const doc = tableDoc()
    const { editor, calls } = docEditor(doc)

    comarkHandlers.tableBlockOp!.execute(editor, { pos: 0, op: 'addRowAfter' })

    expect(calls.map(([name]) => name)).toEqual(['focus', 'setTextSelection', 'addRowAfter'])
    const caret = calls[1]![1] as number
    expect(doc.resolve(caret).parent.textContent).toBe('2')
  })

  it('does nothing when the position names no node', () => {
    const { editor, calls } = docEditor(tableDoc())

    comarkHandlers.tableBlockOp!.execute(editor, { pos: 999, op: 'addRowAfter' })

    expect(calls).toEqual([['focus', undefined]])
  })

  it('reads disabled when the position names no node', () => {
    const { editor } = docEditor(tableDoc())

    expect(comarkHandlers.tableBlockOp!.canExecute(editor, { pos: 0, op: 'addRowAfter' })).toBe(true)
    expect(comarkHandlers.tableBlockOp!.canExecute(editor, { pos: 999, op: 'addRowAfter' })).toBe(false)
  })
})
