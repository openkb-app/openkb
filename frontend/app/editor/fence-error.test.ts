import { describe, it, expect } from 'vitest'
import { EditorState } from '@tiptap/pm/state'
import { editorSchema } from '~~/server/utils/editor-schema'
import { parseMarkdownToDoc } from '~/comark/markdown-engine'
import { fenceErrorKey, fenceErrorPlugin } from './fence-error'

function stateFor(markdown: string): EditorState {
  return EditorState.create({ schema: editorSchema, doc: parseMarkdownToDoc(markdown), plugins: [fenceErrorPlugin()] })
}

function codePos(state: EditorState): number {
  let at = -1
  state.doc.descendants((node, pos) => {
    if (node.type.name === 'codeBlock' && at < 0) at = pos
    return at < 0
  })
  return at
}

function marked(state: EditorState): string[] {
  return fenceErrorKey.getState(state)!.find().map(d => state.doc.textBetween(d.from, d.to))
}

function report(state: EditorState, line: number): EditorState {
  return state.apply(state.tr.setMeta(fenceErrorKey, { pos: codePos(state), line }))
}

describe('the fence error mark', () => {
  const markdown = 'Intro.\n\n```stub\none\n  two\n  thr!ee\n```'

  it('marks the line the error names', () => {
    expect(marked(report(stateFor(markdown), 3))).toEqual(['  thr!ee'])
    expect(marked(report(stateFor(markdown), 1))).toEqual(['one'])
  })

  it('replaces the mark on the next report, and clears it on a render', () => {
    const once = report(stateFor(markdown), 3)
    expect(marked(report(once, 2))).toEqual(['  two'])
    expect(marked(report(once, 0))).toEqual([])
  })

  it('moves with an edit above it', () => {
    const state = report(stateFor(markdown), 3)
    const edited = state.apply(state.tr.insertText('X', codePos(state) + 1))
    expect(marked(edited)).toEqual(['  thr!ee'])
  })

  it('goes once the block is no longer a code block of its fence', () => {
    const state = report(stateFor(markdown), 3)
    const pos = codePos(state)
    expect(marked(state.apply(state.tr.setNodeAttribute(pos, 'language', 'js')))).toEqual([])
    expect(marked(state.apply(state.tr.setNodeMarkup(pos, editorSchema.nodes.paragraph)))).toEqual([])
    expect(marked(state.apply(state.tr.delete(pos, pos + state.doc.nodeAt(pos)!.nodeSize)))).toEqual([])
  })

  it('ignores a line past the source', () => {
    expect(marked(report(stateFor(markdown), 9))).toEqual([])
  })
})
