import { FileHandler } from '@tiptap/extension-file-handler'
import { posAfterEnclosingList } from '~/editor/menu-items'
import { uploadIntoEditor } from '~/editor/page-file-insert'

/** The types `field_kb_images` takes (png gif jpg jpeg webp). */
const IMAGE_TYPES = ['image/png', 'image/gif', 'image/jpeg', 'image/webp']

/** Names browsers give a pasted image. */
const NAMELESS = /^(?:image\.\w+|blob)?$/i

/** `pasted-<YYYYMMDD>-<HHMMSS>.<ext>`, in local time. */
export function pastedName(type: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const ext = (type.split('/')[1] ?? 'png').replace('jpeg', 'jpg')
  return `pasted-${date}-${time}.${ext}`
}

/** Names a nameless pasted file; a dropped file keeps its own name. */
function named(file: File): File {
  return NAMELESS.test(file.name) ? new File([file], pastedName(file.type), { type: file.type }) : file
}

/**
 * Pasted or dropped image files become page images, through the block menu's
 * image upload.
 * - A paste with HTML (a web snippet, table cells) pastes as text: the plugin
 *   leaves it to the editor while `consumePasteEvent` is off.
 */
export const PageImageFileHandler = FileHandler.configure({
  allowedMimeTypes: IMAGE_TYPES,
  onPaste: (editor, files, htmlContent) => {
    if (htmlContent) return
    void uploadIntoEditor(editor, 'image', files.map(named), posAfterEnclosingList(editor) ?? editor.state.selection.to)
  },
  onDrop: (editor, files, pos) => {
    void uploadIntoEditor(editor, 'image', files, posAfterEnclosingList(editor, editor.state.doc.resolve(pos)) ?? pos)
  },
})
