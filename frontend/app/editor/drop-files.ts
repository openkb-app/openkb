import { FileHandler } from '@tiptap/extension-file-handler'
import { posAfterEnclosingList } from '~/editor/menu-items'
import { pageFileLimits, uploadIntoEditor, type FilePickKind } from '~/editor/page-file-insert'
import { trackRange } from '~/editor/tracked-range'

/** A file with an extension the image field takes is a page image; any other file a file card. */
export function droppedKind(file: File, imageExtensions: string[]): FilePickKind {
  const extension = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : ''
  return imageExtensions.includes(extension) ? 'image' : 'file'
}

/**
 * Dropped files go on the page at the drop point (inside a list, after it), in
 * drop order, through the block menu's upload.
 */
export const PageFileDropHandler = FileHandler.extend({ name: 'pageFileDrop' }).configure({
  onDrop: async (editor, files, pos) => {
    const at = trackRange(editor, posAfterEnclosingList(editor, editor.state.doc.resolve(pos)) ?? pos)
    try {
      const imageExtensions = (await pageFileLimits('images'))?.extensions ?? []
      if (editor.isDestroyed) return
      const insertAt = at.current()?.from ?? editor.state.doc.content.size
      await uploadIntoEditor(editor, file => droppedKind(file, imageExtensions), files, insertAt)
    }
    finally {
      at.stop()
    }
  },
})
