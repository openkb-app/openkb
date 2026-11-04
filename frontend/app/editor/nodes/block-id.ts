import { Extension } from '@tiptap/core'
import { TEXT_BLOCK_TYPES, WRAPPED_BLOCK_TYPES } from '#shared/page-blocks'

/**
 * Adds the stable block-id attribute (`id`) to the blocks whose markdown form
 * cannot declare one itself: the native text blocks (trailing `{#b-…}`) and
 * the wrapped containers (their id rides a `::block{#id}` fence). The
 * component fences (callout / infobox / image / attachment / embed) declare their own `id`
 * attribute, so they are left out of this global set.
 *
 * ProseMirror attributes are declared per node *type*, not per position, so a
 * nested paragraph (list item, table cell) also gains the slot. Only top-level
 * ids are minted and written (app/comark/pm-mapper.ts); a nested id is inert.
 *
 * This contributes only an attribute, not a node or mark, so the commit-schema
 * drift tripwire (server/utils/editor-schema.test.ts) stays green as long as
 * the extension is registered on both the live editor and the commit schema.
 * Here it gives the DOM (read-page paste, NodeView HTML) an `id` attribute to
 * hang the value on.
 */
export const BlockId = Extension.create({
  name: 'blockId',

  addGlobalAttributes() {
    return [
      {
        types: [...TEXT_BLOCK_TYPES, ...WRAPPED_BLOCK_TYPES],
        attributes: {
          id: {
            default: null,
            parseHTML: element => element.getAttribute('id'),
            renderHTML: (attributes) => {
              const id = (attributes as { id?: string | null }).id
              return id ? { id } : {}
            },
          },
        },
      },
    ]
  },
})
