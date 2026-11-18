// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { EditorState, NodeSelection, Plugin, Selection, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { GapCursor } from '@tiptap/pm/gapcursor'
import { editorSchema } from '~~/server/utils/editor-schema'
import { parseMarkdownToDoc } from '~/comark/markdown-engine'
import { hiddenCaretPlugin } from './hidden-caret'

const plugin = hiddenCaretPlugin()

/** Node types whose text the stub renders hidden: a fence source, a closed section. */
const hiddenTypes = new Set(['codeBlock', 'details'])

/** What a view stub reports. */
interface StubOptions {
  /** Hidden-type text has client rects too. */
  shown?: boolean
  /** The caret is not on its block's edge line. */
  midBlock?: boolean
}

/**
 * A view stub: the caret is on its block's edge line, and text at a position
 * has no client rects when it is inside a `hiddenTypes` node.
 */
function viewStubFor(state: EditorState, { shown = false, midBlock = false }: StubOptions = {}) {
  const view = {
    state,
    endOfTextblock: () => !midBlock,
    domAtPos: (pos: number) => {
      const hidden = !shown && isInsideHiddenType(view.state, pos)
      const element = document.createElement('p')
      element.getClientRects = () => (hidden ? [] : [{}]) as unknown as DOMRectList
      return { node: element.appendChild(document.createTextNode('text')), offset: 0 }
    },
    dispatch: (tr: ReturnType<EditorState['tr']['setMeta']>) => {
      view.state = view.state.apply(tr)
    },
  }
  return view
}

/** Whether `pos` lies inside a node of one of the `hiddenTypes`. */
function isInsideHiddenType(state: EditorState, pos: number): boolean {
  const $pos = state.doc.resolve(pos)
  for (let depth = 1; depth <= $pos.depth; depth++) {
    if (hiddenTypes.has($pos.node(depth).type.name)) {
      return true
    }
  }
  return false
}

/** Runs the plugin's keydown handler for `key`; true when it took the key. */
function press(view: ReturnType<typeof viewStubFor>, key: string, init: KeyboardEventInit = {}): boolean {
  const handle = plugin.props.handleKeyDown!.bind(plugin)
  return Boolean(handle(view as unknown as EditorView, new KeyboardEvent('keydown', { key, ...init })))
}

/** An editor state of `markdown`, the selection placed by `place`. */
async function stateWithSelection(markdown: string, place: (doc: EditorState['doc']) => Selection, plugins: Plugin[] = []): Promise<EditorState> {
  const doc = await parseMarkdownToDoc(markdown)
  return EditorState.create({ schema: editorSchema, doc, selection: place(doc), plugins })
}

/** Whether the caret is inside a code block (the fence's source). */
function isCaretInCodeBlock(state: EditorState): boolean {
  return state.selection.$head.parent.type.name === 'codeBlock'
}

const markdown = 'Above.\n\n```stub\none\ntwo\n```\n\nBelow.'

describe('the caret into hidden text', () => {
  it('steps down into a hidden fence source', async () => {
    const view = viewStubFor(await stateWithSelection(markdown, doc => TextSelection.atStart(doc)))
    expect(press(view, 'ArrowDown')).toBe(true)
    expect(isCaretInCodeBlock(view.state)).toBe(true)
  })

  it('steps up into a hidden fence source', async () => {
    const view = viewStubFor(await stateWithSelection(markdown, doc => TextSelection.atEnd(doc)))
    expect(press(view, 'ArrowUp')).toBe(true)
    expect(isCaretInCodeBlock(view.state)).toBe(true)
  })

  it('steps up into the end of a closed section\'s body, from the line\'s start', async () => {
    const details = 'Above.\n\n::details{summary="Logs"}\nFirst.\n\nLast.\n::\n\nBelow.'
    const view = viewStubFor(await stateWithSelection(details, doc => TextSelection.create(doc, doc.content.size - 'Below.'.length - 1)))
    expect(press(view, 'ArrowUp')).toBe(true)
    expect(view.state.selection.$head.parent.textContent).toBe('Last.')
    expect(view.state.selection.$head.parentOffset).toBe('Last.'.length)
  })

  it('leaves shown text, modified keys and an open suggestion menu to the browser', async () => {
    expect(press(viewStubFor(await stateWithSelection(markdown, doc => TextSelection.atStart(doc)), { shown: true }), 'ArrowDown')).toBe(false)
    expect(press(viewStubFor(await stateWithSelection(markdown, doc => TextSelection.atStart(doc))), 'ArrowDown', { shiftKey: true })).toBe(false)
    const menu = new Plugin({ state: { init: () => ({ active: true, range: { from: 1, to: 2 } }), apply: value => value } })
    expect(press(viewStubFor(await stateWithSelection(markdown, doc => TextSelection.atStart(doc), [menu])), 'ArrowDown')).toBe(false)
  })

  it('leaves a caret off its block\'s edge line to the browser', async () => {
    expect(press(viewStubFor(await stateWithSelection(markdown, doc => TextSelection.atStart(doc)), { midBlock: true }), 'ArrowDown')).toBe(false)
  })

  it('leaves an atom block before hidden text to ProseMirror', async () => {
    const ruled = 'Above.\n\n---\n\n```stub\none\n```'
    expect(press(viewStubFor(await stateWithSelection(ruled, doc => TextSelection.atStart(doc))), 'ArrowDown')).toBe(false)
  })

  it('leaves a shown paragraph between the caret and a closed section to the browser', async () => {
    const between = 'Above.\n\nMiddle.\n\n::details{summary="Logs"}\nInside.\n::'
    expect(press(viewStubFor(await stateWithSelection(between, doc => TextSelection.atStart(doc))), 'ArrowDown')).toBe(false)
  })

  it('ignores a node selection and a gap cursor', async () => {
    expect(press(viewStubFor(await stateWithSelection(markdown, doc => NodeSelection.create(doc, 0))), 'ArrowDown')).toBe(false)
    const tableFirst = '| a |\n| - |\n| b |\n\n```stub\none\n```'
    expect(press(viewStubFor(await stateWithSelection(tableFirst, doc => new GapCursor(doc.resolve(0)))), 'ArrowUp')).toBe(false)
  })
})
