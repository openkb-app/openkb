// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import type { DropdownMenuItem } from '@nuxt/ui'
import PageMenu from './PageMenu.vue'

const MD_HREF = '/api/kb/general/getting-started.md'

/**
 * The menu in a bare Vue app, with the dropdown stubbed to hand its items back:
 * under test is which entries each mode offers, not how Nuxt UI renders them.
 */
async function mountMenu(props: { edit?: boolean, dirty?: boolean, markdownHref?: string }): Promise<DropdownMenuItem[][]> {
  let items: DropdownMenuItem[][] = []
  vi.stubGlobal('useToast', () => ({ add: () => {} }))

  const app = createApp({
    render: () => h(PageMenu, { nid: 1, title: 'Getting started', historyHref: '/node/1/revisions', ...props }),
  })
  app.component('UDropdownMenu', {
    props: ['items'],
    setup: (stub) => {
      return () => {
        items = stub.items
        return h('div')
      }
    },
  })
  for (const name of ['UButton', 'UModal', 'SpaceMoveDialog']) {
    app.component(name, { render: () => h('div') })
  }
  app.mount(document.createElement('div'))
  await nextTick()
  return items
}

/** The labels of the menu's groups, a submenu's under its parent's. */
function labels(groups: DropdownMenuItem[][]): unknown[][] {
  return groups.map(group => group.map((item) => {
    if (!item.children) {
      return item.label
    }
    return { [item.label!]: (item.children as DropdownMenuItem[]).map(child => child.label) }
  }))
}

/** The entry labelled `label`, searched through the submenus too. */
function entry(groups: DropdownMenuItem[][], label: string): DropdownMenuItem | undefined {
  const all = groups.flat().flatMap(item => [item, ...((item.children as DropdownMenuItem[] | undefined) ?? [])])
  return all.find(item => item.label === label)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the page menu', () => {
  it('offers view, export and print of the published page, reading', async () => {
    const groups = await mountMenu({ markdownHref: MD_HREF })

    expect(labels(groups)).toEqual([
      ['Versions', 'View as Markdown', { Export: ['Markdown', 'HTML'] }, 'Print…'],
      ['Shortcuts'],
    ])
    expect(entry(groups, 'View as Markdown')).toMatchObject({ to: MD_HREF, target: '_blank' })
    expect(entry(groups, 'View as Markdown')).not.toHaveProperty('download')
    expect(entry(groups, 'Markdown')).toMatchObject({ to: MD_HREF, download: 'getting-started.md' })
    expect(entry(groups, 'HTML')).toMatchObject({ to: '/api/kb/general/getting-started.html' })
  })

  it('offers print alone where the page has no markdown address', async () => {
    const groups = await mountMenu({})

    expect(labels(groups)[0]).toEqual(['Versions', 'Print…'])
  })

  it('offers nothing about the content, editing', async () => {
    const groups = await mountMenu({ edit: true, dirty: true, markdownHref: MD_HREF })

    expect(labels(groups)).toEqual([
      ['Versions'],
      ['Shortcuts'],
      ['Revert unsaved changes'],
    ])
  })
})
