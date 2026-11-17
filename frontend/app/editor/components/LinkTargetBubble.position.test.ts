// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import type { App } from 'vue'
import { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { buildCommitSchemaExtensions } from '~~/server/utils/editor-schema'
import { parseMarkdownToJson } from '~/comark/markdown-engine'
import { LinkTargetKeys, requestLinkBubble } from '~/editor/link-target'
import LinkTargetBubble from './LinkTargetBubble.vue'

vi.stubGlobal('useToast', () => ({ add: vi.fn() }))

let editor: Editor
let root: HTMLElement
let app: App | undefined

afterEach(() => {
  app?.unmount()
  app = undefined
  editor?.destroy()
  root?.remove()
})

describe('LinkTargetBubble with the floating plugin', () => {
  it('positions the bubble a request shows over selected words', async () => {
    root = document.createElement('div')
    document.body.appendChild(root)
    editor = new Editor({
      element: root,
      extensions: [...buildCommitSchemaExtensions(), LinkTargetKeys],
      content: await parseMarkdownToJson('See the plan here.'),
    })
    editor.view.focus()
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 5, 13)))
    const host = document.createElement('div')
    root.appendChild(host)
    app = createApp({ render: () => h(LinkTargetBubble as never, { editor, resolve: async () => null }) })
    app.component('UButton', { setup: (_props, { attrs }) => () => h('button', attrs) })
    app.component('UInput', { setup: () => () => h('input') })
    app.mount(host)
    await nextTick()

    requestLinkBubble(editor, 'url')
    /** The bubble's floating element: the panel's parent. */
    const bubble = () => document.querySelector<HTMLElement>('[data-testid="link-target-bubble"]')?.parentElement
    await vi.waitFor(() => expect(bubble()?.style.top).toMatch(/px$/))
  })
})
