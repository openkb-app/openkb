/**
 * Shows the images of a rendered body large, with PhotoSwipe. PhotoSwipe
 * loads on the first hover or click on an image, so it stays out of the
 * initial bundle.
 */

let loaded: Promise<typeof import('photoswipe')['default']> | null = null

/** Loads PhotoSwipe and its styles once. */
export function loadPhotoSwipe(): Promise<typeof import('photoswipe')['default']> {
  loaded ??= Promise.all([import('photoswipe'), import('photoswipe/style.css')])
    .then(([module]) => module.default, (error) => {
      loaded = null
      throw error
    })
  return loaded
}

/** The image's natural size; a lazy image not loaded yet is loaded first. */
async function naturalSize(link: HTMLAnchorElement): Promise<{ width: number, height: number }> {
  const img = link.querySelector('img')
  if (img?.complete && img.naturalWidth) return { width: img.naturalWidth, height: img.naturalHeight }
  const probe = new Image()
  probe.src = link.href
  await probe.decode().catch(() => {})
  return { width: probe.naturalWidth, height: probe.naturalHeight }
}

/**
 * Opens `opener`'s image large. The gallery is every image of the same
 * `.okb-prose` body (the read page, one chat answer), in document order.
 * - Only the opener is measured up front; another image not loaded yet gets
 *   its size when PhotoSwipe loads it.
 */
export async function openLightbox(opener: HTMLAnchorElement): Promise<void> {
  const root = opener.closest('.okb-prose') ?? opener.parentElement ?? opener
  const links = [...root.querySelectorAll<HTMLAnchorElement>('a[data-lightbox]')]
  const [PhotoSwipe, openerSize] = await Promise.all([loadPhotoSwipe(), naturalSize(opener)])
  const items = links.map((link) => {
    const img = link.querySelector('img')
    const size = link === opener
      ? openerSize
      : img?.complete && img.naturalWidth ? { width: img.naturalWidth, height: img.naturalHeight } : {}
    return { src: link.href, alt: img?.alt ?? '', element: link, ...size }
  })
  const pswp = new PhotoSwipe({
    dataSource: items,
    index: Math.max(0, links.indexOf(opener)),
    showHideAnimationType: 'none',
  })
  pswp.on('loadComplete', ({ content, slide }) => {
    const img = content.element
    if (content.width || !(img instanceof HTMLImageElement) || !img.naturalWidth) return
    content.width = slide.width = img.naturalWidth
    content.height = slide.height = img.naturalHeight
    slide.resize()
  })
  pswp.init()
  pswp.element?.setAttribute('aria-label', 'Image viewer')
  pswp.element?.setAttribute('aria-modal', 'true')
}
