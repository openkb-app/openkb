import * as Y from 'yjs'
import type { Schema } from '@tiptap/pm/model'
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap'
import { parseMarkdownToJson } from '~/comark/markdown-engine'

/**
 * Seeds the empty body fragment with `body`, parsed, by applying a binary
 * update from a temporary Y.Doc: y-prosemirror owns the live doc.
 *
 * Seeds nothing when a peer filled the fragment while the body parsed, or
 * when `cancelled` says the session went meanwhile.
 */
export async function seedEmptyFragment(
  ydoc: Y.Doc,
  schema: Schema,
  body: string,
  cancelled: () => boolean = () => false,
): Promise<void> {
  const json = body ? await parseMarkdownToJson(body) : null
  if (!json || cancelled() || ydoc.getXmlFragment('default').length > 0) return
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(schema, json, 'default')))
}
