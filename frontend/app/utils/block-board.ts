/**
 * The block board on the read page — the dashed edge that says which block a
 * margin mark is about (main.css, `.okb-block-board`).
 *
 * The editor draws the same board, on the block holding the caret, and the two
 * share one rule so they cannot drift apart. The read page has no caret, so
 * what it draws the board on is the block whose card is open: the one question
 * a reader can be asking, and one at a time by construction — the page holds a
 * single open block id.
 *
 * Kept out of the component so "exactly one" is a pinned property rather than
 * a loop somebody has to read.
 */

/** Carries the board's edge properties (main.css). */
export const BOARD_CLASS = 'okb-block-board'

/** The one block the board is painted on — the class the editor's rules key on. */
export const BOARD_ACTIVE_CLASS = 'okb-block-active'

/**
 * Paints the board on `activeId`'s block and on no other.
 *
 * The paint needs both classes (main.css). Nothing is written until a card is
 * open: part of the page body hydrates through async components after this
 * page mounts, and Vue silently drops a class it never rendered.
 *
 * @param blocks
 *   The blocks this page put a card trigger under, by id.
 * @param activeId
 *   The block whose card is open, or null when none is.
 */
export function markActiveBlock(blocks: ReadonlyMap<string, HTMLElement>, activeId: string | null): void {
  for (const [id, block] of blocks) {
    const active = id === activeId
    block.classList.toggle(BOARD_CLASS, active)
    block.classList.toggle(BOARD_ACTIVE_CLASS, active)
  }
}

/** Takes the board back off — the blocks are the body's, not ours. */
export function clearBoards(blocks: Iterable<HTMLElement>): void {
  for (const block of blocks) block.classList.remove(BOARD_CLASS, BOARD_ACTIVE_CLASS)
}
