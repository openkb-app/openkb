import type { InjectionKey } from 'vue'
import type { ComarkNode } from '#shared/utils/comark-tree'
import { FENCE_TAG, type FenceRender } from '#shared/utils/fences'

/** A fence the read view rendered: its source and the server's HTML or error. */
export interface ReadFence extends FenceRender {
  source: string
}

/**
 * The read view's fences by block id. The editor's node view shows a fence's
 * read render until its own first draw, so pressing Edit changes no size
 * from the first frame (docs/adr/0022).
 */
export const readFencesKey: InjectionKey<() => Map<string, ReadFence>> = Symbol('okbReadFences')

/** Every fence in a body tree that carries a block id. */
export function readFences(nodes: ComarkNode[]): Map<string, ReadFence> {
  const fences = new Map<string, ReadFence>()
  const walk = (level: ComarkNode[]): void => {
    for (const node of level) {
      if (typeof node === 'string') continue
      const [tag, props, ...children] = node
      if (tag === FENCE_TAG && typeof props.id === 'string') {
        fences.set(props.id, { source: String(props.source ?? ''), html: props.html as string | undefined, error: props.error as FenceRender['error'] })
      }
      walk(children as ComarkNode[])
    }
  }
  walk(nodes)
  return fences
}
