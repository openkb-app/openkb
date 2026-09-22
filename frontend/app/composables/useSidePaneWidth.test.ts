import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useSidePaneWidth, SIDE_PANE_MIN, SIDE_PANE_MAX, SIDE_PANE_DEFAULT } from './useSidePaneWidth'

/**
 * The keys, which are the only part of the resizing this composable owns — the
 * pointer, the clamping and the store are Nuxt UI's, stubbed here as the one
 * share they keep between them.
 */
const resizing = vi.hoisted(() => ({ share: 0 }))

vi.mock('@nuxt/ui/composables', () => ({
  useResizable: () => ({
    el: { value: null },
    size: { get value() { return resizing.share } },
    isDragging: { value: false },
    onMouseDown: () => {},
    onTouchStart: () => {},
    onDoubleClick: () => {},
  }),
}))

beforeEach(() => {
  resizing.share = SIDE_PANE_DEFAULT
  vi.stubGlobal('useCookie', () => ({
    get value() { return { size: resizing.share } },
    set value(next: { size?: number }) { resizing.share = next.size ?? SIDE_PANE_DEFAULT },
  }))
  vi.stubGlobal('refreshCookie', () => {})
})

const press = (key: string) =>
  useSidePaneWidth().onKeydown({ key, preventDefault: () => {} } as KeyboardEvent)

describe('resizing the side pane by keyboard', () => {
  it('grows on the arrow that points away from the pane, and shrinks on the other', () => {
    press('ArrowLeft')
    expect(useSidePaneWidth().width.value).toBeGreaterThan(SIDE_PANE_DEFAULT)

    press('ArrowRight')
    press('ArrowRight')
    expect(useSidePaneWidth().width.value).toBeLessThan(SIDE_PANE_DEFAULT)
  })

  it('stays inside the bounds the pane is usable at', () => {
    for (let i = 0; i < 40; i++) press('ArrowLeft')
    expect(useSidePaneWidth().width.value).toBe(SIDE_PANE_MAX)

    for (let i = 0; i < 40; i++) press('ArrowRight')
    expect(useSidePaneWidth().width.value).toBe(SIDE_PANE_MIN)
  })

  it('jumps to either end of the share the separator carries', () => {
    press('Home')
    expect(useSidePaneWidth().width.value).toBe(SIDE_PANE_MIN)

    press('End')
    expect(useSidePaneWidth().width.value).toBe(SIDE_PANE_MAX)
  })

  it('starts at a share that can still be nudged either way', () => {
    expect(SIDE_PANE_DEFAULT).toBeGreaterThan(SIDE_PANE_MIN)
    expect(SIDE_PANE_DEFAULT).toBeLessThan(SIDE_PANE_MAX)
  })

  it('leaves the width alone on any other key', () => {
    press('Enter')
    expect(useSidePaneWidth().width.value).toBe(SIDE_PANE_DEFAULT)
  })
})
