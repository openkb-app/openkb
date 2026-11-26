// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { computed, createSSRApp, h, onMounted, ref, watch } from 'vue'
import { renderToString } from 'vue/server-renderer'
import type { ResolvedFile } from '#shared/utils/files'

vi.stubGlobal('computed', computed)
vi.stubGlobal('ref', ref)
vi.stubGlobal('watch', watch)
vi.stubGlobal('onMounted', onMounted)

const { default: EmbedFrame } = await import('./EmbedFrame.vue')

const FILE: ResolvedFile = { url: 'https://drupal.example/system/files/probe.pdf', name: 'probe.pdf', size: 10, mime: 'application/pdf', owner: null, created: null }

/** An embed, server-rendered, as an element tree. */
async function renderEmbed(file: ResolvedFile): Promise<HTMLElement> {
  const app = createSSRApp({ render: () => h(EmbedFrame, { file }) })
  app.component('UIcon', { render: () => h('span') })
  const root = document.createElement('div')
  root.innerHTML = await renderToString(app)
  return root
}

describe('EmbedFrame', () => {
  it('prints a link to the file instead of the frame', async () => {
    for (const mime of ['application/pdf', 'text/html']) {
      const root = await renderEmbed({ ...FILE, mime })
      expect(root.querySelector('iframe')!.classList.contains('print:hidden'), mime).toBe(true)
      const link = root.querySelector<HTMLAnchorElement>('a.print\\:block')!
      expect(link.classList.contains('hidden')).toBe(true)
      expect(link.getAttribute('href')).toBe(FILE.url)
      expect(link.textContent).toBe('probe.pdf')
    }
  })
})
