// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { EditorState, NodeSelection, Selection, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { GapCursor } from '@tiptap/pm/gapcursor'
import { editorSchema } from '~~/server/utils/editor-schema'
import { parseMarkdownToDoc } from '~/comark/markdown-engine'
import { fenceCaretPlugin } from './fence-caret'

const plugin = fenceCaretPlugin('codeBlock')

/**
 * A view stub: every caret is on its block's edge line, and the fence's code
 * has client rects only when `shown`.
 */
function viewFor(state: EditorState, shown = false) {
  const view = {
    state,
    coordsAtPos: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    nodeDOM: () => {
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      code.getClientRects = () => (shown ? [{}] : []) as unknown as DOMRectList
      pre.append(code)
      return pre
    },
    dispatch: (tr: ReturnType<EditorState['tr']['setMeta']>) => {
      view.state = view.state.apply(tr)
    },
  }
  return view
}

function press(view: ReturnType<typeof viewFor>, key: string, init: KeyboardEventInit = {}): boolean {
  const handle = plugin.props.handleKeyDown!.bind(plugin)
  return Boolean(handle(view as unknown as EditorView, new KeyboardEvent('keydown', { key, ...init })))
}

function at(markdown: string, place: (doc: EditorState['doc']) => Selection): EditorState {
  const doc = parseMarkdownToDoc(markdown)
  return EditorState.create({ schema: editorSchema, doc, selection: place(doc) })
}

function inCode(state: EditorState): boolean {
  return state.selection.$head.parent.type.name === 'codeBlock'
}

const markdown = 'Above.\n\n```stub\none\ntwo\n```\n\nBelow.'

describe('the fence caret', () => {
  it('steps down into a hidden fence source', () => {
    const view = viewFor(at(markdown, doc => TextSelection.atStart(doc)))
    expect(press(view, 'ArrowDown')).toBe(true)
    expect(inCode(view.state)).toBe(true)
  })

  it('steps up into a hidden fence source', () => {
    const view = viewFor(at(markdown, doc => TextSelection.atEnd(doc)))
    expect(press(view, 'ArrowUp')).toBe(true)
    expect(inCode(view.state)).toBe(true)
  })

  it('leaves a shown source, a plain code block and modified keys to the browser', () => {
    expect(press(viewFor(at(markdown, doc => TextSelection.atStart(doc)), true), 'ArrowDown')).toBe(false)
    const plain = 'Above.\n\n```js\none\n```\n\nBelow.'
    expect(press(viewFor(at(plain, doc => TextSelection.atStart(doc))), 'ArrowDown')).toBe(false)
    expect(press(viewFor(at(markdown, doc => TextSelection.atStart(doc))), 'ArrowDown', { shiftKey: true })).toBe(false)
  })

  it('ignores a node selection and a gap cursor', () => {
    expect(press(viewFor(at(markdown, doc => NodeSelection.create(doc, 0))), 'ArrowDown')).toBe(false)
    const tableFirst = '| a |\n| - |\n| b |\n\n```stub\none\n```'
    expect(press(viewFor(at(tableFirst, doc => new GapCursor(doc.resolve(0)))), 'ArrowUp')).toBe(false)
  })
})
