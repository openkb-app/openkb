import { parse, render as renderSvg } from 'pele'
import { fenceError, type FenceError, type FenceRender } from '#shared/utils/fences'
import { PELE_OPTIONS } from './pele-options'

/**
 * Server-side rendering and checking, with every diagram type registered.
 * Pele needs no DOM, so this runs in Nitro as is. Its SVG is escaped and
 * link-filtered, safe as HTML.
 */

export function render(source: string, { idPrefix }: { idPrefix: string }): FenceRender {
  try {
    return { html: renderSvg(source, { ...PELE_OPTIONS, idPrefix }).svg }
  }
  catch (err) {
    return { error: fenceError(err) }
  }
}

export function check(source: string): FenceError | null {
  try {
    parse(source, { limit: PELE_OPTIONS.limit })
    return null
  }
  catch (err) {
    return fenceError(err)
  }
}
