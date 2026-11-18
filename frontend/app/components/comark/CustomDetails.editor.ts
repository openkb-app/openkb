import { defineComarkEditorPart } from '#shared/utils/comark-components'
import CustomDetailsEditor from './CustomDetails.editor.vue'

export default defineComarkEditorPart({
  menu: {
    label: 'Collapsible section',
    icon: 'i-lucide-chevrons-down-up',
    description: 'A titled section readers open and close',
    content: [{ type: 'paragraph' }],
  },
  nodeView: CustomDetailsEditor,
})
