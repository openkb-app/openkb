// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import type { H3Event } from 'h3'
import { isPrintRenderRequest, setBrowserPrintRender, usePrintRender } from './usePrintRender'

/** A server request with `context`, as server/utils/export-render.ts leaves it. */
function requestWith(context: Record<string, unknown>): H3Event {
  return { context } as unknown as H3Event
}

afterEach(() => {
  setBrowserPrintRender(false)
})

describe('usePrintRender', () => {
  it('is on for the server render the export marks, off for any other', () => {
    expect(isPrintRenderRequest(requestWith({ okbPrintRender: true }))).toBe(true)
    expect(isPrintRenderRequest(requestWith({}))).toBe(false)
    expect(isPrintRenderRequest(undefined)).toBe(false)
  })

  it('follows the browser print, with the class on the root', () => {
    const printRender = usePrintRender()
    expect(printRender.value).toBe(false)
    setBrowserPrintRender(true)
    expect(printRender.value).toBe(true)
    expect(document.documentElement.classList.contains('okb-print-render')).toBe(true)
    setBrowserPrintRender(false)
    expect(printRender.value).toBe(false)
    expect(document.documentElement.classList.contains('okb-print-render')).toBe(false)
  })
})
