// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { Suspense, createApp, h, nextTick, shallowRef } from 'vue'
import { MarkdownDocument } from '@comark/vue'
import { markdownToTree } from '#shared/utils/comark-tree'
import CustomMention from './CustomMention.vue'

describe('CustomMention', () => {
  it('follows a re-rendered tree with a new label', async () => {
    const nodes = shallowRef(await markdownToTree('Ping :mention[alice]{uid="2"}'))
    const root = document.createElement('div')
    // `MarkdownDocument` sets up async; Nuxt's app root is the Suspense for it.
    createApp({
      render: () => h(Suspense, null, () =>
        h(MarkdownDocument, { value: { nodes: nodes.value }, components: { mention: CustomMention } })),
    }).mount(root)
    await vi.waitFor(() => expect(root.querySelector('.mention')?.getAttribute('data-label')).toBe('alice'))

    nodes.value = await markdownToTree('Ping :mention[bob]{uid="3"}')
    await nextTick()
    const chip = root.querySelector('.mention')
    expect(chip?.textContent).toBe('@bob')
    expect(chip?.getAttribute('data-label')).toBe('bob')
    expect(chip?.getAttribute('data-id')).toBe('3')
  })
})
