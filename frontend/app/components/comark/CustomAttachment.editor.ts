import { defineComarkEditorPart } from '#shared/utils/comark-components'
import CustomAttachmentEditor from './CustomAttachment.editor.vue'

// Inserted through the page-file picker (`app/editor/menu-items.ts`).
export default defineComarkEditorPart({
  menu: false,
  nodeView: CustomAttachmentEditor,
})
