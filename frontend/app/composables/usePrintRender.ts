import type { H3Event } from 'h3'
import { readonly, ref, type Ref } from 'vue'
import { PRINT_RENDER_CLASS } from '#shared/utils/print-render'

/** The browser's print render: on while the page prints. */
const browserPrintRender = ref(false)

/**
 * Whether this render is a print render (docs/adr/0029-the-print-render.md).
 *
 * For markup that must differ on paper; print CSS cannot change markup.
 * - Server: on in the page export's render of the read page, which is never
 *   hydrated.
 * - Browser: on while the page prints (plugins/print-render.ts).
 */
export function usePrintRender(): Readonly<Ref<boolean>> {
  if (import.meta.server) {
    return ref(isPrintRenderRequest(useRequestEvent()))
  }
  return readonly(browserPrintRender)
}

/** Whether a server request is a print render: the export's render marks it. */
export function isPrintRenderRequest(event: H3Event | undefined): boolean {
  return event?.context.okbPrintRender === true
}

/** Switches the browser's print render: the root class and usePrintRender(). */
export function setBrowserPrintRender(on: boolean): void {
  browserPrintRender.value = on
  document.documentElement.classList.toggle(PRINT_RENDER_CLASS, on)
}
