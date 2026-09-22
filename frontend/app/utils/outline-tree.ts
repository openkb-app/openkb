import type { ComputedRef, InjectionKey, Ref } from 'vue'
import type { KbSpaceTree, KbTreeNode, OutlineDrop } from '#shared/utils/kb-outline'

/**
 * The contract between `KbOutlineTree` and the rows it renders.
 *
 * The tree is recursive and every row needs the same drag state, expansion
 * state and move handler, so those travel by injection rather than down the
 * nesting as props.
 */

/** Where on a row the cursor is: reorder above/below, or re-parent into it. */
export type DropZone = 'before' | 'after' | 'inside'

export interface OutlineTreeController {
  space: ComputedRef<KbSpaceTree>
  dense: ComputedRef<boolean>
  /** Id of the node being dragged, if any. */
  dragging: Ref<string | null>
  /** The row the cursor is over and the zone within it. */
  over: Ref<{ id: string, zone: DropZone } | null>
  isExpanded: (node: KbTreeNode) => boolean
  setExpanded: (id: string, value: boolean) => void
  toggle: (node: KbTreeNode) => void
  move: (id: string, drop: OutlineDrop) => void | Promise<void>
}

export const outlineTreeKey: InjectionKey<OutlineTreeController> = Symbol('kb-outline-tree')

/**
 * Which zone of a row the pointer sits in — the middle 40% re-parents, the
 * outer edges reorder. Wide enough that dropping *into* a page is easy to hit,
 * narrow enough that ordering a long list does not nest things by accident.
 */
export function zoneAt(event: DragEvent): DropZone {
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const offset = (event.clientY - box.top) / (box.height || 1)
  if (offset < 0.3) return 'before'
  if (offset > 0.7) return 'after'
  return 'inside'
}

/** The move a drop describes, in the "index as rendered" terms `moveNode` takes. */
export function dropFor(
  node: KbTreeNode,
  zone: DropZone,
  parentId: string | null,
  index: number,
): OutlineDrop {
  if (zone === 'inside') return { parentId: node.page.id, index: node.children.length }
  return { parentId, index: zone === 'before' ? index : index + 1 }
}
