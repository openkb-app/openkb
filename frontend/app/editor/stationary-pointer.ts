import { defaultDocument, useEventListener } from '@vueuse/core'

/**
 * Keeps a resting pointer from moving the highlight in the editor's menus.
 *
 * - Nuxt UI's editor menus highlight an option on `mouseenter`.
 * - Chromium fires one when a menu opens or reorders under a pointer that did not move, so Enter picks that option instead of the best match.
 * - Upstream: Nuxt UI `useEditorMenu`.
 */
export function ignoreMenuMouseEnterWithoutPointerMove(menuOptionSelector: string): void {
  let lastX = Number.NaN
  let lastY = Number.NaN
  useEventListener(defaultDocument, 'mousemove', (event: MouseEvent) => {
    lastX = event.clientX
    lastY = event.clientY
  }, { capture: true, passive: true })
  useEventListener(defaultDocument, 'mouseenter', (event: MouseEvent) => {
    const pointerMoved = event.clientX !== lastX || event.clientY !== lastY
    if (!pointerMoved && event.target instanceof Element && event.target.matches(menuOptionSelector)) {
      event.stopPropagation()
    }
  }, { capture: true })
}
