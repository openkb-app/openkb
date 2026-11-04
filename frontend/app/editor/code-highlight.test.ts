import { describe, it, expect } from 'vitest'
import { EditorState } from '@tiptap/pm/state'
import type { DecorationSet } from '@tiptap/pm/view'
import { editorSchema } from '~~/server/utils/editor-schema'
import { parseMarkdownToDoc } from '~/comark/markdown-engine'
import { loadCodeLanguage } from '#shared/utils/code-highlight'
import { codeHighlightKey, codeHighlightPlugin } from './code-highlight'

async function stateFor(markdown: string): Promise<EditorState> {
  return EditorState.create({ schema: editorSchema, doc: await parseMarkdownToDoc(markdown), plugins: [codeHighlightPlugin()] })
}

/** The decorated text runs with their style, in document order. */
function runs(state: EditorState): Array<{ text: string, style: string }> {
  const set = codeHighlightKey.getState(state)!.set as DecorationSet
  return set.find().map(d => ({
    text: state.doc.textBetween(d.from, d.to),
    style: String((d as unknown as { type: { attrs: { style: string } } }).type.attrs.style),
  }))
}

describe('the editor’s code highlighting', () => {
  it('decorates a ts fence with the theme variables', async () => {
    await loadCodeLanguage('ts')
    const state = await stateFor('```ts\nconst a = 1\n```')
    const keyword = runs(state).find(run => run.text === 'const')
    expect(keyword?.style).toMatch(/--shiki-light:#[0-9a-f]{6};--shiki-dark:#[0-9a-f]{6}/i)
  })

  it('places the runs of a later line past the line break', async () => {
    await loadCodeLanguage('ts')
    const state = await stateFor('```ts\nlet x\nconst y\n```')
    expect(runs(state).map(run => run.text)).toEqual(['let', 'const', 'y'])
  })

  it('leaves a plain fence and an unknown language undecorated', async () => {
    expect(runs(await stateFor('```\nconst a = 1\n```'))).toEqual([])
    expect(runs(await stateFor('```foobar\nconst a = 1\n```'))).toEqual([])
    expect(codeHighlightKey.getState(await stateFor('```foobar\nx\n```'))!.pending.size).toBe(0)
  })

  it('names a language not loaded yet as pending, then decorates once it is in', async () => {
    const state = await stateFor('```go\nfunc main() {}\n```')
    expect([...codeHighlightKey.getState(state)!.pending]).toEqual(['go'])
    expect(runs(state)).toEqual([])
    await loadCodeLanguage('go')
    const redrawn = state.apply(state.tr.setMeta(codeHighlightKey, true))
    expect(runs(redrawn).map(run => run.text)).toContain('func')
  })

  it('follows an edit to the code', async () => {
    await loadCodeLanguage('ts')
    const state = await stateFor('```ts\nx\n```')
    const next = state.apply(state.tr.insertText('return ', 1))
    expect(runs(next).map(run => run.text)).toContain('return')
  })

  it('reuses an unchanged block’s tokens and drops a removed block’s', async () => {
    await loadCodeLanguage('ts')
    const state = await stateFor('```ts\nconst a = 1\n```\n\n```ts\nlet b\n```')
    const before = codeHighlightKey.getState(state)!.lines
    const edited = state.apply(state.tr.insertText('x', state.doc.content.size - 3))
    const after = codeHighlightKey.getState(edited)!.lines
    expect(after.get('ts\u0000const a = 1')).toBe(before.get('ts\u0000const a = 1'))
    expect([...after.keys()]).toEqual(['ts\u0000const a = 1', 'ts\u0000letx b'])
  })
})
