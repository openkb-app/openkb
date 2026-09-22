// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApp, h, ref } from 'vue'
import PageMetaStrip from './PageMetaStrip.vue'

const RAW_HREF = '/api/kb/general/getting-started.md'

interface Copies { published: number, plain: [string, string][] }

/**
 * The strip in a bare Vue app, with the two copy composables and `useState`
 * stubbed — what is under test is which act each mode offers, not how a badge
 * or an icon renders.
 */
function mount(props: {
  docType?: string
  rawHref?: string
  workingCopy?: () => string
  editable?: boolean
}) {
  const copies: Copies = { published: 0, plain: [] }
  const edited: string[] = []
  vi.stubGlobal('useState', (_key: string, init: () => number) => ref(init()))
  vi.stubGlobal('useCopyMarkdown', () => ({
    copy: () => { copies.published++ },
    copying: ref(false),
  }))
  vi.stubGlobal('useCopyText', () => ({
    copy: (text: string, label: string) => { copies.plain.push([text, label]) },
  }))

  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp({
    render: () => h(PageMetaStrip, { ...props, onEditField: (key: string) => edited.push(key) }),
  })
  // Render functions, not templates: the suite runs against Vue's runtime
  // build, which carries no template compiler.
  app.component('UIcon', { props: ['name'], render: () => h('span') })
  app.component('UBadge', {
    props: ['as', 'color', 'variant', 'size'],
    setup: (props, { slots, attrs }) => () =>
      h(props.as ?? 'span', { ...attrs, 'data-size': props.size }, slots.default?.()),
  })
  app.mount(root)
  return { root, copies, edited }
}

afterEach(() => { vi.unstubAllGlobals() })

/**
 * Read mode hands out the published page at its `.md` address; edit mode has no
 * address for the document being edited, so it hands out the editor's own
 * markdown and leaves the link out.
 */
describe('the page meta strip', () => {
  it('offers the .md address and copies it, reading a published page', async () => {
    const { root, copies } = mount({ docType: 'guide', rawHref: RAW_HREF })

    expect(root.querySelector(`a[href="${RAW_HREF}"]`)).not.toBeNull()

    const copy = root.querySelector<HTMLButtonElement>('[data-testid="copy-as-markdown"]')!
    expect(copy.getAttribute('aria-label')).toBe('Copy as Markdown')
    copy.click()
    expect(copies.published).toBe(1)
    expect(copies.plain).toEqual([])
  })

  it('copies the working copy and hides the .md link, editing', async () => {
    const { root, copies } = mount({
      docType: 'guide',
      rawHref: RAW_HREF,
      workingCopy: () => 'The body as it stands.',
    })

    expect(root.querySelector(`a[href="${RAW_HREF}"]`)).toBeNull()

    const copy = root.querySelector<HTMLButtonElement>('[data-testid="copy-as-markdown"]')!
    expect(copy.getAttribute('aria-label')).toBe('Copy the working copy as Markdown')
    copy.click()
    expect(copies.plain).toEqual([['The body as it stands.', 'Working copy']])
    expect(copies.published).toBe(0)
  })

  it('renders the type pill at the size the row is laid out for', () => {
    const { root } = mount({ docType: 'guide' })

    expect(root.querySelector('[data-size]')?.getAttribute('data-size')).toBe('sm')
  })

  it('leaves the type pill inert while reading', () => {
    const { root, edited } = mount({ docType: 'guide', rawHref: RAW_HREF })

    const pill = root.querySelector<HTMLElement>('[data-testid="page-type-pill"]')!
    expect(pill.tagName).toBe('SPAN')
    pill.click()
    expect(edited).toEqual([])
  })

  it('makes the type pill a button that asks for its field, editing', () => {
    const { root, edited } = mount({ docType: 'guide', editable: true })

    const pill = root.querySelector<HTMLButtonElement>('[data-testid="page-type-pill"]')!
    expect(pill.tagName).toBe('BUTTON')
    expect(pill.getAttribute('aria-label')).toBe('Edit the page type: Guide')
    pill.click()
    expect(edited).toEqual(['type'])
  })
})
