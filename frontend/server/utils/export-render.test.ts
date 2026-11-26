import { describe, expect, it } from 'vitest'
import type { H3Event } from 'h3'
import { EXPORT_RENDER_HEADER, exportRenderHeaders, markExportRender } from './export-render'

/** A request with `headers`, as h3 reads them. */
function eventWith(headers: Record<string, string>): H3Event {
  return { node: { req: { headers: { ...headers } } }, context: {} } as unknown as H3Event
}

describe('export render mark', () => {
  it('marks a print render with its carrier on the context, and drops the mark', () => {
    const mark = exportRenderHeaders()[EXPORT_RENDER_HEADER]!
    const event = eventWith({ 'authorization': 'Bearer agent', 'cookie': 'SESSabc=1', [EXPORT_RENDER_HEADER]: mark })
    markExportRender(event)
    expect(event.context.okbPrintRender).toBe(true)
    expect(event.context.okbExportRenderAuth).toEqual({ Authorization: 'Bearer agent' })
    expect(event.node.req.headers[EXPORT_RENDER_HEADER]).toBeUndefined()
  })

  it('ignores a mark this process did not make', () => {
    const event = eventWith({ 'authorization': 'Bearer agent', [EXPORT_RENDER_HEADER]: 'guessed' })
    markExportRender(event)
    expect(event.context.okbPrintRender).toBeUndefined()
    expect(event.context.okbExportRenderAuth).toBeUndefined()
    expect(event.node.req.headers[EXPORT_RENDER_HEADER]).toBeUndefined()
  })

  it('leaves an unmarked request alone', () => {
    const event = eventWith({ authorization: 'Bearer agent' })
    markExportRender(event)
    expect(event.context.okbExportRenderAuth).toBeUndefined()
  })
})
