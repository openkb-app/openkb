import { defineComarkEditorPart } from '#shared/utils/comark-components'
import CustomCalloutSettings from './CustomCallout.settings.vue'

export default defineComarkEditorPart({
  menu: {
    label: 'Callout',
    icon: 'i-lucide-info',
    description: 'Info box — switch the type inside',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'New callout — type here.' }] }],
  },
  controls: {
    type: { icons: { info: 'i-lucide-info', warning: 'i-lucide-alert-triangle', success: 'i-lucide-check-circle', danger: 'i-lucide-octagon-alert' } },
  },
  settingsMenu: CustomCalloutSettings,
})
