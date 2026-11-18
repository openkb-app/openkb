// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { ySyncPluginKey } from '@tiptap/y-tiptap'
import { Editor, EditorContent, VueNodeViewRenderer } from '@tiptap/vue-3'
import { createApp, h, nextTick } from 'vue'
import type { App } from 'vue'
import { comarkComponentDeclarations, insertedComponentMeta } from '#shared/utils/comark-components'
import { createComponentNode } from '~/editor/nodes/component-node'
import CustomDetailsEditor from './CustomDetails.editor.vue'

let editor: Editor | undefined
let app: App | undefined

afterEach(() => {
  app?.unmount()
  editor?.destroy()
  document.body.innerHTML = ''
})

const Details = createComponentNode(comarkComponentDeclarations.details!).extend({
  addNodeView: () => VueNodeViewRenderer(CustomDetailsEditor),
})

/** Mounts an editor holding a paragraph, a closed section and an open one, its node views placed. */
async function mountEditorWithSections(): Promise<Editor> {
  editor = new Editor({
    extensions: [Document, Paragraph, Text, Details],
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Before.' }] },
        { type: 'details', attrs: { summary: 'Closed', open: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Inside.' }] }] },
        { type: 'details', attrs: { summary: 'Open', open: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Shown.' }] }] },
      ],
    },
  })
  app = createApp({ render: () => h(EditorContent, { editor }) })
    .component('UIcon', { render: () => h('span') })
  app.mount(document.body.appendChild(document.createElement('div')))
  await nextTick()
  await Promise.resolve()
  return editor
}

/** The start of each section. */
function sectionStartsOf(e: Editor): number[] {
  const starts: number[] = []
  e.state.doc.forEach((node, offset) => { if (node.type.name === 'details') starts.push(offset) })
  return starts
}

/** Whether each section shows its body, in document order. */
function shownOpenOfSections(): boolean[] {
  return [...document.querySelectorAll<HTMLElement>('[data-test="details"] > .okb-box-body')].map(body => body.style.display !== 'none')
}

/** The stored `open` of each section, in document order. */
function storedOpenOfSections(e: Editor): unknown[] {
  return sectionStartsOf(e).map(pos => e.state.doc.nodeAt(pos)!.attrs.open)
}

/** Clicks the caret to `from`, then moves it to `to` (a key press, or as `meta` says). */
async function moveCaret(e: Editor, from: number, to: number, meta?: [unknown, unknown]) {
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, from)).setMeta('pointer', true))
  const tr = e.state.tr.setSelection(TextSelection.create(e.state.doc, to))
  if (meta) tr.setMeta(meta[0] as string, meta[1])
  e.view.dispatch(tr)
  await nextTick()
  await nextTick()
}

describe('the collapsible section in the editor', () => {
  it('shows as stored on load', async () => {
    await mountEditorWithSections()
    expect(shownOpenOfSections()).toEqual([false, true])
    // `group-open:` styles the chevron by the attribute.
    expect([...document.querySelectorAll('[data-test="details"]')].map(section => section.getAttribute('open'))).toEqual([null, ''])
  })

  it('opens and closes with its button, for this user only', async () => {
    const e = await mountEditorWithSections()
    const doc = e.state.doc
    const [button] = document.querySelectorAll<HTMLButtonElement>('[data-test="details-toggle"]')
    expect(button!.getAttribute('aria-expanded')).toBe('false')
    button!.click()
    await nextTick()
    expect(shownOpenOfSections()).toEqual([true, true])
    expect(button!.getAttribute('aria-expanded')).toBe('true')
    button!.click()
    await nextTick()
    expect(shownOpenOfSections()).toEqual([false, true])
    expect(e.state.doc).toBe(doc)
  })

  it('has no native details or summary, and the button names the body it shows', async () => {
    await mountEditorWithSections()
    expect(document.querySelectorAll('details, summary')).toHaveLength(0)
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-test="details-toggle"]')]
    const ids = buttons.map(button => button.getAttribute('aria-controls'))
    expect(new Set(ids).size).toBe(2)
    expect(document.getElementById(ids[0]!)!.textContent).toBe('Inside.')
  })

  it('does not toggle on a click on its summary', async () => {
    await mountEditorWithSections()
    document.querySelector<HTMLElement>('[data-test="details"] > div')!.click()
    await nextTick()
    expect(shownOpenOfSections()).toEqual([false, true])
  })

  it('opens when the caret moves into a closed one, and stores nothing', async () => {
    const e = await mountEditorWithSections()
    const [closed] = sectionStartsOf(e)
    e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, closed! + 3)))
    await nextTick()
    expect(shownOpenOfSections()).toEqual([true, true])
    expect(storedOpenOfSections(e)).toEqual([false, true])
  })

  it('keeps this user\'s state through typing in its body and its summary', async () => {
    const e = await mountEditorWithSections()
    const [closed] = sectionStartsOf(e)
    document.querySelector<HTMLButtonElement>('[data-test="details-toggle"]')!.click()
    e.view.dispatch(e.state.tr.insertText('More ', closed! + 2))
    e.view.dispatch(e.state.tr.setNodeMarkup(closed!, undefined, { ...e.state.doc.nodeAt(closed!)!.attrs, summary: 'Renamed' }))
    await nextTick()
    expect(shownOpenOfSections()).toEqual([true, true])
  })

  it('opens when inserted from the menu; the stored value stays closed', async () => {
    const e = await mountEditorWithSections()
    e.chain().setTextSelection(8).insertContent({ type: 'details', attrs: { summary: '' }, content: [{ type: 'paragraph' }] }).setMeta(insertedComponentMeta, 'details').run()
    await nextTick()
    expect(shownOpenOfSections()).toEqual([true, false, true])
    expect(storedOpenOfSections(e)).toEqual([false, false, true])
  })

  it('stays closed when it arrives without the hint, as a paste does', async () => {
    const e = await mountEditorWithSections()
    e.chain().setTextSelection(8).insertContent({ type: 'details', attrs: { summary: '' }, content: [{ type: 'paragraph' }] }).run()
    await nextTick()
    expect(shownOpenOfSections()).toEqual([false, false, true])
  })

  it('opens when the caret jumps over it from the block before, the caret then at the body\'s start', async () => {
    const e = await mountEditorWithSections()
    await moveCaret(e, 8, 22)
    expect(shownOpenOfSections()).toEqual([true, true])
    expect(e.state.selection.head).toBe(11)
    expect(storedOpenOfSections(e)).toEqual([false, true])
  })

  it('opens when the caret jumps over it from the block after, the caret then at the body\'s end', async () => {
    const e = await mountEditorWithSections()
    await moveCaret(e, 22, 8)
    expect(shownOpenOfSections()).toEqual([true, true])
    expect(e.state.selection.head).toBe(18)
  })

  it('stays closed when the block after it is selected as a node, and keeps that selection', async () => {
    const e = await mountEditorWithSections()
    const [, after] = sectionStartsOf(e)
    e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, 2)).setMeta('pointer', true))
    e.view.dispatch(e.state.tr.setSelection(NodeSelection.create(e.state.doc, after!)))
    await nextTick()
    await nextTick()
    expect(shownOpenOfSections()).toEqual([false, true])
    expect(e.state.selection).toBeInstanceOf(NodeSelection)
    expect(e.state.selection.from).toBe(after)
  })

  it('stays closed when a click or a collaborator moves the caret over it', async () => {
    const e = await mountEditorWithSections()
    await moveCaret(e, 8, 22, ['pointer', true])
    await moveCaret(e, 22, 8, [ySyncPluginKey, {}])
    expect(shownOpenOfSections()).toEqual([false, true])
  })

  it('stays closed when a collaborator moves the caret into it', async () => {
    const e = await mountEditorWithSections()
    await moveCaret(e, 2, 12, [ySyncPluginKey, {}])
    expect(shownOpenOfSections()).toEqual([false, true])
  })

  it('stops listening to the selection once removed', async () => {
    const e = await mountEditorWithSections()
    const off = vi.spyOn(e, 'off')
    const [closed] = sectionStartsOf(e)
    e.view.dispatch(e.state.tr.delete(closed!, closed! + e.state.doc.nodeAt(closed!)!.nodeSize))
    await nextTick()
    const offs = off.mock.calls.filter(([event, listener]) => event === 'selectionUpdate' && listener?.name === 'openWhenCaretMovesIn')
    expect(offs).toHaveLength(1)
  })
})
