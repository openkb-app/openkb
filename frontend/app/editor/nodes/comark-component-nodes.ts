import type { AnyExtension } from '@tiptap/core'
import { comarkComponentDeclarations } from '#shared/utils/comark-components'
import { OkbAttachment, OkbAttachmentInline } from './attachment'
import { OkbImage } from './image'
import { createChipNode, createComponentNode } from './component-node'

/**
 * Components whose editor nodes are not the generated ones, by tag:
 * - image: Tiptap's image node, which also holds a plain `![](src)` image;
 * - attachment: a block card and an inline link, two nodes for one tag;
 * - mention: Tiptap's mention node, in the UEditor base set
 *   (`server/utils/editor-schema.ts`), for its suggestion and Backspace.
 */
export const OWN_COMPONENT_NODES: Record<string, AnyExtension[]> = {
  image: [OkbImage],
  attachment: [OkbAttachment, OkbAttachmentInline],
  mention: [],
}

/** The editor nodes of every comark component, by tag; Vue-free, so the commit schema builds from it too. */
export function buildComarkComponentNodes(): Array<[tag: string, nodes: AnyExtension[]]> {
  return Object.values(comarkComponentDeclarations).map(declaration => [
    declaration.tag,
    OWN_COMPONENT_NODES[declaration.tag]
      ?? [declaration.inline ? createChipNode(declaration) : createComponentNode(declaration)],
  ])
}
