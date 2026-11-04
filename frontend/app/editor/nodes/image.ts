import Image from '@tiptap/extension-image'
import { parseImageWidth } from '#shared/utils/image-width'

/** Attrs the image node carries; only `file`/`alt`/`width` (or `src`/`alt`/`title`) reach markdown. */
export interface ImageAttrs {
  /** UUID of a page file in `field_kb_images` (ADR 0020). */
  file?: string | null
  src?: string | null
  alt?: string | null
  title?: string | null
  /** Percent of the content column, 10–100; unset = natural size. */
  width?: number | null
  /** Stable block id: the fence `#id` shorthand, or trailing `{#id}` when plain (OKB-137). */
  id?: string | null
}

/**
 * The editor's Image node — UEditor's @tiptap/extension-image (block-level)
 * extended with a `file` attribute carrying a page file UUID. One node, two
 * markdown forms (app/comark/pm-mapper.ts):
 *
 * - `file` set   → `::image{file="<uuid>" alt="…" width="…%"}`, a childless
 *   fence naming a file in `field_kb_images` (ADR 0020); `src` is a display
 *   value resolved at render time and never stored.
 * - `file` unset → `![alt](src "title")` for plain/external URLs.
 *
 * Vue-free — the live preview NodeView is layered on in
 * app/editor/extensions.ts, exactly like Callout / Infobox.
 */
export const OkbImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      file: { default: null },
      // A percent, not TipTap's pixels: kept off the `width` HTML attribute.
      width: {
        default: null,
        parseHTML: (element: HTMLElement) => parseImageWidth(element.dataset.width),
        renderHTML: (attrs: ImageAttrs) => attrs.width ? { 'data-width': `${attrs.width}%` } : {},
      },
      // Block id carried through the fence round-trip (OKB-137), as callout
      // and infobox carry theirs — the review gate needs every producible
      // block identified.
      id: { default: null },
    }
  },

  parseHTML() {
    return [
      { tag: 'img[src]:not([src^="data:"])' },
      {
        tag: 'custom-image',
        getAttrs: (element: HTMLElement) => ({
          file: element.getAttribute('file'),
          alt: element.getAttribute('alt'),
          src: element.getAttribute('src'),
        }),
      },
    ]
  },
})
