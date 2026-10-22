// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

type LoadComplete = (event: { content: { element?: HTMLElement, width: number, height: number }, slide: { width: number, height: number, resize: () => void } }) => void

const opened: Array<{ options: { dataSource: Array<{ src: string, alt: string, width: number, height: number }>, index: number }, element: HTMLElement, handlers: Record<string, LoadComplete> }> = []

vi.mock('photoswipe/style.css', () => ({}))
vi.mock('photoswipe', () => ({
  default: class {
    element = document.createElement('div')
    constructor(public options: never) {}
    handlers: Record<string, LoadComplete> = {}
    on(name: string, handler: LoadComplete) {
      this.handlers[name] = handler
    }
    init() {
      opened.push(this as never)
    }
  },
}))

const { openLightbox } = await import('./image-lightbox')

/** A rendered body with an image link per `[alt, width, height]`. */
function body(images: Array<[string, number, number]>): HTMLAnchorElement[] {
  // A width of 0 is a lazy image not loaded yet.
  const root = document.createElement('div')
  root.className = 'okb-prose'
  for (const [alt, width, height] of images) {
    const link = document.createElement('a')
    link.href = `https://kb.example/system/files/images/${alt}.png`
    link.setAttribute('data-lightbox', '')
    const img = document.createElement('img')
    img.alt = alt
    Object.defineProperties(img, { complete: { value: width > 0 }, naturalWidth: { value: width }, naturalHeight: { value: height } })
    link.append(img)
    root.append(link)
  }
  document.body.append(root)
  return [...root.querySelectorAll('a')]
}

describe('openLightbox', () => {
  it('opens the clicked image in a gallery of the body\'s images, in order, at their natural size', async () => {
    const links = body([['first', 1600, 900], ['second', 800, 600]])
    body([['elsewhere', 10, 10]])
    await openLightbox(links[1]!)
    const { options, element } = opened.at(-1)!
    expect(options.index).toBe(1)
    expect(options.dataSource.map(({ src, alt, width, height }) => ({ src, alt, width, height }))).toEqual([
      { src: 'https://kb.example/system/files/images/first.png', alt: 'first', width: 1600, height: 900 },
      { src: 'https://kb.example/system/files/images/second.png', alt: 'second', width: 800, height: 600 },
    ])
    expect(element.getAttribute('aria-label')).toBe('Image viewer')
  })

  it('measures only the opener, leaving an image not loaded yet to PhotoSwipe', async () => {
    const links = body([['shown', 1600, 900], ['below', 0, 0]])
    const probe = vi.spyOn(globalThis, 'Image')
    await openLightbox(links[0]!)
    expect(probe).not.toHaveBeenCalled()
    const below = opened.at(-1)!.options.dataSource[1]!
    expect([below.width, below.height]).toEqual([undefined, undefined])
  })

  describe('on loadComplete', () => {
    /** A loaded PhotoSwipe image of `width`×`height`, a slide, and the handler. */
    async function loaded(width: number, height: number, contentWidth = 0) {
      const links = body([['shown', 1600, 900], ['below', 0, 0]])
      await openLightbox(links[0]!)
      const img = document.createElement('img')
      Object.defineProperties(img, { naturalWidth: { value: width }, naturalHeight: { value: height } })
      const content = { element: img as HTMLElement, width: contentWidth, height: contentWidth ? 300 : 0 }
      const slide = { width: contentWidth, height: contentWidth ? 300 : 0, resize: vi.fn() }
      opened.at(-1)!.handlers.loadComplete!({ content, slide })
      return { content, slide }
    }

    it('sizes an image not measured yet and resizes its slide', async () => {
      const { content, slide } = await loaded(800, 600)
      expect([content.width, content.height, slide.width, slide.height]).toEqual([800, 600, 800, 600])
      expect(slide.resize).toHaveBeenCalledOnce()
    })

    it('leaves an image with a size alone', async () => {
      const { content, slide } = await loaded(800, 600, 400)
      expect([content.width, slide.width]).toEqual([400, 400])
      expect(slide.resize).not.toHaveBeenCalled()
    })

    it('leaves a failed image alone', async () => {
      const { content, slide } = await loaded(0, 0)
      expect([content.width, slide.width]).toEqual([0, 0])
      expect(slide.resize).not.toHaveBeenCalled()
    })
  })
})
