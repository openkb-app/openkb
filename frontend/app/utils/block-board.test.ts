// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { BOARD_ACTIVE_CLASS, BOARD_CLASS, clearBoards, markActiveBlock } from './block-board'

/** Three blocks, as the read page would hand them over. */
function blocks(): Map<string, HTMLElement> {
  const map = new Map<string, HTMLElement>()
  for (const id of ['b-1', 'b-2', 'b-3']) {
    const el = document.createElement('p')
    el.id = id
    document.body.append(el)
    map.set(id, el)
  }
  return map
}

/** Which ids currently wear the painted board. */
function active(map: Map<string, HTMLElement>): string[] {
  return [...map].filter(([, el]) => el.classList.contains(BOARD_ACTIVE_CLASS)).map(([id]) => id)
}

describe('markActiveBlock', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  // Part of the page body hydrates after this page mounts, so nothing may
  // be written onto the blocks while no card is open.
  it('markActiveBlock writes no class while no card is open', () => {
    const map = blocks()
    markActiveBlock(map, null)
    for (const el of map.values()) expect(el.className).toBe('')
  })

  it('markActiveBlock puts both classes on the open block alone', () => {
    const map = blocks()
    markActiveBlock(map, 'b-2')
    expect(active(map)).toEqual(['b-2'])
    for (const [id, el] of map) expect(el.classList.contains(BOARD_CLASS)).toBe(id === 'b-2')
  })

  it('moves the board rather than adding a second one', () => {
    const map = blocks()
    markActiveBlock(map, 'b-2')
    markActiveBlock(map, 'b-3')
    expect(active(map)).toEqual(['b-3'])
  })

  it('markActiveBlock removes both classes when the card closes', () => {
    const map = blocks()
    markActiveBlock(map, 'b-2')
    markActiveBlock(map, null)
    expect(active(map)).toEqual([])
    for (const el of map.values()) expect(el.className).toBe('')
  })

  it('ignores an id no block on this page carries', () => {
    const map = blocks()
    markActiveBlock(map, 'b-gone')
    expect(active(map)).toEqual([])
  })
})

describe('clearBoards', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('leaves the blocks as it found them', () => {
    const map = blocks()
    markActiveBlock(map, 'b-1')
    clearBoards(map.values())
    for (const el of map.values()) expect(el.className).toBe('')
  })
})
