// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { createApp, h } from 'vue'

const loadPhotoSwipe = vi.fn(async () => {})
const openLightbox = vi.fn(async () => {})
vi.mock('~/utils/image-lightbox', () => ({ loadPhotoSwipe, openLightbox }))

const { default: CustomImage } = await import('./CustomImage.vue')

function mount(props: Record<string, unknown>): HTMLElement {
  const root = document.createElement('div')
  createApp({ render: () => h(CustomImage, props) }, {}).component('UIcon', { render: () => null }).mount(root)
  return root
}

describe('CustomImage', () => {
  it('links the image to its file and loads PhotoSwipe only on interaction', async () => {
    const link = mount({ src: '/system/files/images/a.png', alt: 'A chart' }).querySelector('a')!
    expect(link.getAttribute('href')).toBe('/system/files/images/a.png')
    expect(link.hasAttribute('data-lightbox')).toBe(true)
    expect(link.getAttribute('aria-label')).toBeNull()
    expect(loadPhotoSwipe).not.toHaveBeenCalled()
    link.dispatchEvent(new PointerEvent('pointerenter'))
    expect(loadPhotoSwipe).toHaveBeenCalledTimes(1)
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(openLightbox).toHaveBeenCalledWith(link)
  })

  it('names an image without alt text, and leaves a modified click to the browser', () => {
    openLightbox.mockClear()
    const link = mount({ src: '/system/files/images/a.png', alt: '' }).querySelector('a')!
    expect(link.getAttribute('aria-label')).toBe('View image')
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })
    link.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(false)
    expect(openLightbox).not.toHaveBeenCalled()
  })

  it('sizes the link to the fence width and fills it with the image', () => {
    const link = mount({ src: '/system/files/images/a.png', alt: 'A chart', width: '40%' }).querySelector('a')!
    expect(link.style.width).toBe('40%')
    expect(link.classList).toContain('w-fit')
    expect(link.querySelector('img')!.classList).toContain('w-full')
  })
})
