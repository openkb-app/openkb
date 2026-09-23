<script setup lang="ts">
/**
 * Opens Drupal's media-library dialog in this document.
 *
 * The backend's `okb-media-library` element: the dialog URL is its prop, the
 * dialog's libraries are the `<drupal-library-*>` elements in its slot, which
 * the editor loads before it renders this element. The dialog lives and dies
 * with the component.
 */
import { cancelMediaDialogKey } from '~/composables/useMediaLibraryPicker'

interface JQueryDialog {
  dialog: (...args: unknown[]) => unknown
}

interface DrupalGlobal {
  ajax: (settings: Record<string, unknown>) => { execute: () => void }
  AjaxCommands: { prototype: Record<string, unknown> }
}

const props = defineProps<{ dialogUrl: string }>()

const cancel = inject(cancelMediaDialogKey, null)

function drupal(): DrupalGlobal | undefined {
  return (window as unknown as { Drupal?: DrupalGlobal }).Drupal
}

/** The dialog is app markup once it is open, so it reads the app's Drupal-form rules. */
function onCreated(event: Event): void {
  const dialog = (event.target as HTMLElement | null)?.closest('.ui-dialog')
  dialog?.classList.add('drupal-form')
}

/** Closes and tears down Drupal's dialog, whatever state it is in. */
function closeDrupalDialog(): void {
  const element = document.getElementById('drupal-modal')
  const jquery = (window as unknown as { jQuery?: (el: Element) => Partial<JQueryDialog> }).jQuery
  if (element && jquery?.(element).dialog) {
    // Takes the wrapper, the overlay and jQuery UI's own document handlers
    // with it. The sweep below is for a dialog that never got that far.
    (jquery(element) as JQueryDialog).dialog('destroy')
  }
  element?.remove()
  document.querySelectorAll('.ui-dialog, .ui-widget-overlay').forEach(el => el.remove())
}

onMounted(() => {
  const Drupal = drupal()
  // A library script that failed to load leaves the loader resolved but
  // Drupal absent; without an answer the editor would wait forever.
  if (!Drupal?.ajax) {
    console.error('Media-library dialog failed: Drupal did not load.')
    cancel?.()
    return
  }
  document.addEventListener('dialog:aftercreate', onCreated)
  // Drupal's AJAX responses carry the stylesheets of whatever they render. The
  // app styles the dialog itself and takes no Drupal CSS at all, so this
  // command has nothing to do here.
  Drupal.AjaxCommands.prototype.add_css = () => {}
  Drupal.ajax({
    url: props.dialogUrl,
    dialogType: 'modal',
    dialog: { title: 'Media library', width: '80%' },
    progress: { type: 'fullscreen' },
  }).execute()
})

onBeforeUnmount(() => {
  document.removeEventListener('dialog:aftercreate', onCreated)
  closeDrupalDialog()
})
</script>

<template>
  <!-- The libraries in the slot; Drupal's dialog markup lives in `document`. -->
  <slot />
</template>
