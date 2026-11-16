// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import type { AnyExtension, JSONContent } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Link from '@tiptap/extension-link'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { computed, createApp, defineComponent, h } from 'vue'
import type { Component } from 'vue'
import { comarkComponentDeclarations } from '#shared/utils/comark-components'
import CustomCitation from '~/components/comark/inline/CustomCitation.vue'
import CustomDoc from '~/components/comark/inline/CustomDoc.vue'
import CustomMention from '~/components/comark/inline/CustomMention.vue'
import { createChipNode, createComponentNode } from './component-node'
import { OkbMention } from './mention'

const NuxtLink = defineComponent({
  props: { to: String },
  setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()),
})
const UTooltip = defineComponent({ setup: (_, { slots }) => () => slots.default?.() })

beforeEach(() => {
  // Nuxt auto-imports the read components use.
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('resolveComponent', (name: string) => (name === 'NuxtLink' ? NuxtLink : name))
})
afterEach(() => vi.unstubAllGlobals())

/** The editor's DOM element of one inline node, as the chip's node draws it. */
function editorChipElement(node: AnyExtension, chip: JSONContent): Element {
  const element = document.createElement('div')
  const editor = new Editor({ element, extensions: [Document, Paragraph, Text, node], content: { type: 'doc', content: [{ type: 'paragraph', content: [chip] }] } })
  const rendered = element.querySelector('p > [data-type]')!.cloneNode(true) as Element
  editor.destroy()
  return rendered
}

/** The root element the read component renders for the props. */
function readChipElement(component: Component, props: Record<string, unknown>, label = ''): Element | null {
  const root = document.createElement('div')
  createApp({ render: () => h(component, props, () => label) }).component('NuxtLink', NuxtLink).component('UTooltip', UTooltip).mount(root)
  return root.firstElementChild
}

/** An element's `data-*` attributes. */
function dataAttributesOf(element: Element): Record<string, string> {
  return Object.fromEntries([...element.attributes].filter(a => a.name.startsWith('data-')).map(a => [a.name, a.value]))
}

/** Expects the read chip to carry the editor chip's class and every one of its data attributes. */
function expectSameClassAndData(editorChip: Element, readChip: Element | null): void {
  expect(readChip).not.toBeNull()
  for (const name of editorChip.classList) expect([...readChip!.classList], name).toContain(name)
  expect(dataAttributesOf(readChip!)).toMatchObject(dataAttributesOf(editorChip))
}

describe('a chip in the editor and on the read page', () => {
  it('a mention', () => {
    const editorChip = editorChipElement(OkbMention, { type: 'mention', attrs: { id: '3', label: 'bob' } })
    // Tiptap's own: the trigger character the mention was typed with.
    editorChip.removeAttribute('data-mention-suggestion-char')
    expect(dataAttributesOf(editorChip)).toMatchObject({ 'data-type': 'mention', 'data-id': '3', 'data-label': 'bob' })
    expectSameClassAndData(editorChip, readChipElement(CustomMention, { uid: '3', label: 'bob' }, 'bob'))
  })

  it('a document link', () => {
    const editorChip = editorChipElement(createChipNode(comarkComponentDeclarations.doc!), { type: 'docLink', attrs: { nid: 42, block: 'b-4f2a', label: 'Rollback' } })
    expect(dataAttributesOf(editorChip)).toEqual({ 'data-type': 'doc-link', 'data-nid': '42', 'data-block': 'b-4f2a' })
    expect(editorChip.textContent).toBe('Rollback')
    expectSameClassAndData(editorChip, readChipElement(CustomDoc, { href: '/a#b-4f2a', nid: 42, block: 'b-4f2a' }, 'Rollback'))
  })

  it('a citation', () => {
    const citation = createChipNode(comarkComponentDeclarations.citation!)
    const editorChip = editorChipElement(citation, { type: 'citation', attrs: { nid: 42, block: 'b-4f2a', v: 'e0ff367d5ce8' } })
    expect(dataAttributesOf(editorChip)).toEqual({ 'data-type': 'citation', 'data-nid': '42', 'data-block': 'b-4f2a', 'data-v': 'e0ff367d5ce8' })

    // The read tree passes no stored prop (`citeNode` in comark-tree.ts): a paste keeps the link.
    const readChip = readChipElement(CustomCitation, { n: '1', title: 'Rollback', path: '/a#b-4f2a', state: 'stale' })!
    // No editor chip markers: the editor's citation styles stay off the pasted link.
    expect(readChip.matches('.okb-cite, [data-type]')).toBe(false)
    const element = document.createElement('div')
    const editor = new Editor({ element, extensions: [Document, Paragraph, Text, Link.configure({ openOnClick: false }), citation], content: `<p>${readChip.outerHTML}</p>` })
    expect(editor.getJSON().content![0]!.content).toEqual([
      { type: 'text', text: readChip.textContent, marks: [{ type: 'link', attrs: expect.objectContaining({ href: '/a#b-4f2a' }) }] },
    ])
    editor.destroy()
  })
})

describe('the node of a block component', () => {
  it('copies its props, not its block id, to the clipboard', () => {
    const element = document.createElement('div')
    const editor = new Editor({
      element,
      extensions: [Document, Paragraph, Text, createComponentNode(comarkComponentDeclarations.callout!)],
      content: { type: 'doc', content: [{ type: 'callout', attrs: { type: 'danger', id: 'b-1' }, content: [{ type: 'paragraph' }] }] },
    })
    expect(editor.getHTML()).toBe('<custom-callout type="danger"><p></p></custom-callout>')
    editor.destroy()
  })

  it('is an atom without a slot', () => {
    const node = createComponentNode(comarkComponentDeclarations.embed!)
    expect(node.config.atom).toBe(true)
    expect(node.config.content).toBeUndefined()
  })
})
