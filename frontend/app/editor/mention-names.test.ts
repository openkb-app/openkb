// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { buildUEditorBaseExtensions } from '~~/server/utils/editor-schema'
import { parseMarkdownToDoc } from '~/comark/markdown-engine'

/** The accounts the name lookup answers, by uid. */
const currentNames = new Map<number, string>([[11, 'Grace']])

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const uids = new URL(url, 'http://localhost').searchParams.get('uid')!.split(',').map(Number)
    const users = uids.filter(uid => currentNames.has(uid)).map(uid => ({ uid, name: currentNames.get(uid) }))
    return new Response(JSON.stringify({ users }))
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

/** Lets the batched lookups run and the editor redraw. */
async function settled(): Promise<void> {
  for (let round = 0; round < 5; round++) await new Promise(resolve => setTimeout(resolve, 0))
}

/** An editor over `markdown`, with a fresh name map. */
async function editorOver(markdown: string): Promise<Editor> {
  vi.resetModules()
  const { MentionNames } = await import('./mention-names')
  const doc = await parseMarkdownToDoc(markdown)
  return new Editor({
    element: document.createElement('div'),
    extensions: [...buildUEditorBaseExtensions(), MentionNames],
    content: doc.toJSON(),
  })
}

/** What each chip is labelled with now: its current name, or the stored label. */
function chips(editor: Editor): Array<string | null> {
  return [...editor.view.dom.querySelectorAll('.mention')].map(chip => chip.getAttribute('data-current-label'))
}

describe('the editor\'s mention chips', () => {
  it('name a renamed account as it is called now', async () => {
    const editor = await editorOver('ask :mention[grace-old]{uid="11"} or :mention[gone]{uid="99"}')
    expect(chips(editor)).toEqual([null, null])

    await settled()

    expect(chips(editor)).toEqual(['Grace', null])
    expect(editor.view.dom.querySelector('.mention .mention__label')!.textContent).toBe('@grace-old')
    expect([...editor.view.dom.querySelectorAll('.mention')].map(chip => chip.classList.contains('mention--unknown'))).toEqual([false, true])
    editor.destroy()
  })
})
