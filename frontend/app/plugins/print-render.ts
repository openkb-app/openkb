import { PRINT_RENDER_CLASS } from '#shared/utils/print-render'

/**
 * The print render's switch (docs/adr/0029-the-print-render.md).
 *
 * - Server: the export's render carries the root class.
 * - Browser: the print render is on while the page prints, in the light
 *   scheme: the dark tokens hang off `.dark` on <html>, so it comes off for the
 *   print and back afterwards.
 *
 * `beforeprint` covers the print dialog; the `print` media change covers a
 * print emulated without one (headless PDF, `emulateMedia`).
 */
export default defineNuxtPlugin(() => {
  if (import.meta.server) {
    if (usePrintRender().value) {
      useHead({ htmlAttrs: { class: PRINT_RENDER_CLASS } })
    }
    return
  }

  const root = document.documentElement
  let wasDark = false

  /** Starts the print render, in the light scheme. */
  function startPrintRender(): void {
    setBrowserPrintRender(true)
    if (!root.classList.contains('dark')) return
    wasDark = true
    root.classList.remove('dark')
  }

  /** Ends the print render and gives the screen its scheme back. */
  function endPrintRender(): void {
    setBrowserPrintRender(false)
    if (wasDark) root.classList.add('dark')
    wasDark = false
  }

  window.addEventListener('beforeprint', startPrintRender)
  window.addEventListener('afterprint', endPrintRender)
  window.matchMedia('print').addEventListener('change', event => (event.matches ? startPrintRender() : endPrintRender()))
})
