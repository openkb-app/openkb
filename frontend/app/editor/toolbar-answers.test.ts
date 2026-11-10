// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { effect } from 'vue'
import { Editor } from '@tiptap/vue-3'
import Bold from '@tiptap/extension-bold'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { createHandlers } from '@nuxt/ui/utils/editor'
import { handlersAnsweringThroughComputeds } from './toolbar-answers'

/** Resolves once Tiptap has told Vue about the transactions dispatched so far. */
function editorStateReachedVue(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

describe('toolbar handlers answering through computeds', () => {
  const boldItem = { kind: 'mark', mark: 'bold' }
  let editor: Editor

  beforeEach(() => {
    const element = document.createElement('div')
    document.body.append(element)
    editor = new Editor({ element, extensions: [Document, Paragraph, Text, Bold], content: '<p>Weekly notes</p>' })
  })

  afterEach(() => editor.destroy())

  /** Counts how often a toolbar asking the handler about the bold button renders. */
  function countRendersAsking(handlers: ReturnType<typeof createHandlers>) {
    const counted = { renders: 0, active: false, disabled: false }
    effect(() => {
      counted.renders++
      counted.active = handlers.mark.isActive(editor, boldItem)
      counted.disabled = !handlers.mark.canExecute(editor, boldItem)
    })
    return counted
  }

  it('does not render the toolbar again for a keystroke', async () => {
    const toolbar = countRendersAsking(handlersAnsweringThroughComputeds(createHandlers()))

    editor.commands.insertContent('x')
    await editorStateReachedVue()

    expect(toolbar.renders).toBe(1)
  })

  it('renders the toolbar again when a button changes its state', async () => {
    const toolbar = countRendersAsking(handlersAnsweringThroughComputeds(createHandlers()))
    expect(toolbar.active).toBe(false)

    editor.commands.toggleBold()
    await editorStateReachedVue()

    expect(toolbar.renders).toBe(2)
    expect(toolbar.active).toBe(true)
  })

  it('renders the toolbar on every keystroke with plain handlers', async () => {
    const toolbar = countRendersAsking(createHandlers())

    editor.commands.insertContent('x')
    await editorStateReachedVue()

    expect(toolbar.renders).toBe(2)
  })
})
