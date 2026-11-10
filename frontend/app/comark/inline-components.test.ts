import { describe, it, expect } from 'vitest'
import { Window } from 'happy-dom'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { MarkdownDocument } from '@comark/vue'
import { shippedAllowedHtml } from '~~/test/shipped-comark-format'
import { markdownToTree } from '#shared/utils/comark-tree'
import { CITATION_TAG } from '#shared/utils/citations'
import { comarkComponents } from './components'

/** A stand-in renderer that marks where a component landed. */
function stubComponentMarkedAs(name: string) {
  return defineComponent({
    setup: (_, { slots }) => () => h('span', { 'data-rendered': name }, slots.default?.()),
  })
}

// The read page's map, with the link and citation chips stubbed: they need
// the Nuxt app, the mention does not.
const components = {
  ...comarkComponents,
  doc: stubComponentMarkedAs('doc'),
  [CITATION_TAG]: stubComponentMarkedAs('citation'),
}

const resolvers = {
  allowedHtml: shippedAllowedHtml(),
  resolveDocs: async () => ({ 7: { title: 'Release process', path: '/handbook/release' } }),
  resolveCites: async () => ({ 7: { title: 'Release process', path: '/handbook/release', versions: {} } }),
}

/** Renders a stored body the way the read page does. */
async function renderBody(markdown: string): Promise<HTMLElement> {
  const nodes = await markdownToTree(markdown, resolvers)
  const html = await renderToString(createSSRApp({
    render: () => h(MarkdownDocument, { value: { nodes }, components }),
  }))
  const root = new Window().document.createElement('div')
  root.innerHTML = html
  return root as unknown as HTMLElement
}

const POSITIONS = {
  'after a space': (component: string) => `Ping ${component} please review.`,
  'at a line start': (component: string) => `${component} please review.`,
  'inside bold': (component: string) => `Ping **${component}** please review.`,
  'inside italic': (component: string) => `Ping *${component}* please review.`,
}

describe('inline components on the read page', () => {
  it.each(Object.entries(POSITIONS))('renders a mention %s as a chip', async (_, place) => {
    const root = await renderBody(place(':mention[editor2]{uid="2"}'))
    const chip = root.querySelector('.mention')
    expect(chip?.textContent).toBe('@editor2')
    expect(chip?.getAttribute('data-id')).toBe('2')
    expect(chip?.getAttribute('data-label')).toBe('editor2')
    expect(chip?.hasAttribute('inline')).toBe(false)
  })

  it.each([
    ['bold', ':mention[**bo**ld]{uid="2"}'],
    ['code', ':mention[`bo`ld]{uid="2"}'],
  ])('keeps all words of a mention label holding %s', async (_, body) => {
    const chip = (await renderBody(body)).querySelector('.mention')
    expect(chip?.textContent).toBe('@bold')
    expect(chip?.getAttribute('data-label')).toBe('bold')
  })

  it.each(Object.entries(POSITIONS))('renders a doc link and a citation %s', async (_, place) => {
    const root = await renderBody(place(':doc[Old]{nid="7"} :citation{nid="7"}'))
    expect(root.querySelector('[data-rendered="doc"]')?.textContent).toBe('Release process')
    expect(root.querySelector('[data-rendered="citation"]')).not.toBeNull()
  })
})
