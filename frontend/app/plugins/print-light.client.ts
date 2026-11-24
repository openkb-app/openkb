/**
 * Prints in the light scheme whatever the screen shows: the dark tokens hang
 * off `.dark` on <html>, so it comes off for the print and back afterwards.
 *
 * `beforeprint` covers the print dialog; the `print` media change covers a
 * print emulated without one (headless PDF, `emulateMedia`).
 */
export default defineNuxtPlugin(() => {
  const root = document.documentElement
  let wasDark = false

  function toLight() {
    if (!root.classList.contains('dark')) return
    wasDark = true
    root.classList.remove('dark')
  }
  function restore() {
    if (wasDark) root.classList.add('dark')
    wasDark = false
  }

  window.addEventListener('beforeprint', toLight)
  window.addEventListener('afterprint', restore)
  window.matchMedia('print').addEventListener('change', event => (event.matches ? toLight() : restore()))
})
