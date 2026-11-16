import { defineComarkEditorPart } from '#shared/utils/comark-components'

export default defineComarkEditorPart({
  menu: {
    label: 'Infobox',
    icon: 'i-lucide-square',
    description: 'Titled bordered box',
    attrs: { title: 'Info' },
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'New infobox — set a title above and edit text here.' }] }],
  },
})
