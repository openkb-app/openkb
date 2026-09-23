<script setup lang="ts">
/**
 * Drupal's own media-library dialog, open inside the editor page.
 *
 * The dialog is a custom-elements payload like any other page: the route
 * answers with an `okb-media-library` element carrying the dialog URL, plus
 * the `<drupal-library-*>` elements that load the dialog's JavaScript. The
 * Nitro proxy (server/utils/drupal-proxy.ts) serves Drupal same-origin, so
 * `Drupal.ajax` then opens the native dialog (browse + upload) in this
 * document, exactly as a coupled admin page does. "Insert selected" answers
 * with an AJAX command that dispatches `okb:media-selected` on `document`
 * (js/selection.js in the openkb_media_library module) and closes the dialog.
 *
 * The dialog's look is this component's `<style>`, loaded with it and with
 * nothing from Drupal in it. Unmounting takes the payload — and with it the
 * dialog — away and answers the pending request, so a route change while the
 * dialog is open leaves nothing behind.
 */
import { cancelMediaDialogKey, closeMediaDialog } from '~/composables/useMediaLibraryPicker'
import { resolveDrupalLibrary, type DrupalLibraryProps } from '~/composables/useDrupalLibrary'

/** One element of a custom-elements payload, as the CE API ships it. */
interface CustomElementJson {
  element: string
  props?: Record<string, unknown>
  slots?: Record<string, (CustomElementJson | string)[]>
}

const props = defineProps<{ nid: number, token: number }>()

const { $ceApi, renderCustomElements, loadLibrary } = useDrupalCe()

const content = shallowRef<CustomElementJson | null>(null)
/** False from the moment this component starts unmounting. */
let active = true

/** Answers this request, and only this one — a later one owns the state now. */
const answer = (uuids: string[] | null) => closeMediaDialog(props.token, uuids)

const onSelected = (event: Event) => {
  const detail = (event as CustomEvent<{ uuids?: string[] }>).detail
  answer(Array.isArray(detail?.uuids) ? detail.uuids : [])
}
// The selection command runs before the close command, so a real selection
// always answers first and `dialog:afterclose` then finds nothing pending.
const onClosed = () => answer(null)

// The dialog element opens the dialog; it answers through this when it cannot.
provide(cancelMediaDialogKey, () => answer(null))

/**
 * The payload's `<drupal-library-*>` elements, in load order.
 *
 * They are the siblings of the dialog element in its own slot — the shape
 * `DrupalLibraryElementGenerator` emits for the attached libraries.
 */
function libraryElements(element: CustomElementJson): DrupalLibraryProps[] {
  return (element.slots?.default ?? []).filter(
    (entry): entry is CustomElementJson =>
      typeof entry !== 'string' && entry.element.startsWith('drupal-library-'),
  ).map(entry => entry.props as unknown as DrupalLibraryProps)
}

onMounted(async () => {
  document.addEventListener('okb:media-selected', onSelected)
  document.addEventListener('dialog:afterclose', onClosed)
  try {
    const page = await $ceApi()<{ content: CustomElementJson }>('/openkb/media-library', { query: { nid: props.nid } })
    if (!active) return
    // The libraries load before the dialog element renders: the element opens
    // the dialog on mount, and `Drupal.ajax` has to exist by then. One batch,
    // so the loader runs Drupal.attachBehaviors once at the end of it.
    // Rendering the library elements as well costs nothing — the loader skips
    // a script it already has.
    await Promise.all(libraryElements(page.content).map(library => loadLibrary(resolveDrupalLibrary(library))))
    if (!active) return
    content.value = page.content
  }
  catch (error) {
    console.error('Media-library dialog failed', error)
    if (active) answer(null)
  }
})

onBeforeUnmount(() => {
  active = false
  document.removeEventListener('okb:media-selected', onSelected)
  document.removeEventListener('dialog:afterclose', onClosed)
  // An unmount that is not a close — a route change — still owes the editor
  // an answer and has to release the request the `v-if` reads.
  answer(null)
})
</script>

<template>
  <component :is="renderCustomElements(content)" v-if="content" />
</template>

<style>
/* Drupal's media-library dialog. The dialog arrives as core's media-library
   markup with no CSS of its own — neither a theme's nor core's — so its whole
   look is here, on the class names core's templates emit. The forms read the
   app's Drupal-form rules (main.css): the dialog root carries `drupal-form`
   from the moment it opens. Everything is scoped to `.ui-dialog`, so none of
   it reaches the app behind the dialog, and it is loaded with this component,
   which exists only while the dialog is open. */
.ui-widget-overlay {
  position: fixed;
  z-index: 1000;
  inset: 0;
  background: var(--ui-bg-inverted);
  opacity: 0.4;
}
/* Position and size are jQuery UI's: it writes them as inline styles, and
   Drupal's dialog.position.js keeps the content box fitting the viewport. */
.ui-dialog {
  position: absolute;
  z-index: 1001;
  max-width: calc(100vw - 2rem);
  padding: 0;
  border: 1px solid var(--ui-border);
  border-radius: var(--okb-radius);
  background: var(--ui-bg);
  color: var(--ui-text);
  font-family: var(--font-sans);
  font-size: 0.875rem;
  box-shadow: 0 12px 32px rgb(0 0 0 / 0.18);
  overflow: hidden;
}
.ui-dialog .visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  clip-path: inset(50%);
  overflow: hidden;
}
/* The accent line marks the dialog's header the way the active Grid/Table tab
   below marks itself. */
.ui-dialog .ui-dialog-titlebar {
  position: relative;
  padding: 0.75rem 3rem 0.75rem 1rem;
  border-top: 3px solid var(--ui-primary);
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.ui-dialog .ui-dialog-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
  color: var(--ui-text-highlighted);
}
/* jQuery UI's close button is a label plus a sprite icon the app does not
   ship. The label stays in the flow for assistive tech, hidden by the indent,
   and the glyph is two bars — an empty `content` stays out of the button's
   accessible name. */
.ui-dialog .ui-dialog-titlebar-close {
  position: absolute;
  top: 50%;
  right: 0.75rem;
  width: 2rem;
  height: 2rem;
  margin-top: -1rem;
  padding: 0;
  border: 0;
  border-radius: var(--okb-radius);
  background: transparent;
  color: var(--ui-text-muted);
  text-indent: -9999px;
  overflow: hidden;
  cursor: pointer;
}
.ui-dialog .ui-dialog-titlebar-close::before,
.ui-dialog .ui-dialog-titlebar-close::after {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 0.875rem;
  height: 1.5px;
  content: '';
  background: currentcolor;
}
.ui-dialog .ui-dialog-titlebar-close::before {
  transform: translate(-50%, -50%) rotate(45deg);
}
.ui-dialog .ui-dialog-titlebar-close::after {
  transform: translate(-50%, -50%) rotate(-45deg);
}
.ui-dialog .ui-dialog-titlebar-close .ui-icon {
  display: none;
}
.ui-dialog .ui-dialog-titlebar-close:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}
.ui-dialog .ui-dialog-titlebar-close:hover {
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
}
.ui-dialog .ui-dialog-content {
  padding: 1rem;
  overflow: auto;
}
/* Upload form and exposed filters: two banded sections above the grid. */
.ui-dialog :is(.js-media-library-add-form, .views-exposed-form) {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0.75rem;
  margin-bottom: 1rem;
  padding: 0.75rem;
  border: 1px solid var(--ui-border);
  border-radius: var(--okb-radius);
  background: var(--ui-bg-muted);
}
.ui-dialog :is(.js-media-library-add-form, .views-exposed-form) .form-item {
  margin-bottom: 0;
}
.ui-dialog .form-actions {
  margin-top: 0;
}
/* The file widget is one row: the picker, its button, and the name and size
   of what was picked. */
.ui-dialog .form-managed-file {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 0.75rem;
  max-width: 100%;
}
/* The picker carries the browser's own button, so it takes none of the boxed
   field frame the app's form rules give a control. */
.ui-dialog .form-managed-file input[type='file'] {
  width: auto;
  max-width: 100%;
  min-height: 0;
  padding: 0;
  border: 0;
  background: none;
  font-size: 0.8125rem;
}
/* That button is reachable only as the pseudo-element, so it carries the
   compact secondary look itself. */
.ui-dialog input[type='file']::file-selector-button {
  margin-inline-end: 0.75rem;
  padding: 0.375rem 1rem;
  border: 1px solid var(--ui-border-accented);
  border-radius: var(--okb-radius);
  background: color-mix(in oklab, var(--ui-text) 8%, transparent);
  color: var(--ui-text-toned);
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
}
.ui-dialog input[type='file']::file-selector-button:hover {
  border-color: var(--ui-primary);
  background: var(--ui-primary);
  color: var(--ui-text-inverted);
}
.ui-dialog .form-managed-file .file {
  font-weight: 500;
  word-break: break-all;
}
.ui-dialog .form-managed-file .file + span {
  margin-inline-start: -0.375rem;
  font-size: 0.8125rem;
  color: var(--ui-text-muted);
}
/* Upload, Remove and Apply filters act on one field; only "Insert selected"
   answers the dialog, so the rest stay compact. */
.ui-dialog :is(input[type='submit'], .button) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 2rem;
  margin: 0;
  padding: 0 0.875rem;
  border: 1px solid var(--ui-border-accented);
  border-radius: var(--okb-radius);
  background: color-mix(in oklab, var(--ui-text) 8%, transparent);
  color: var(--ui-text-toned);
  font-family: inherit;
  font-size: 0.8125rem;
  font-weight: 500;
  line-height: 1;
  text-decoration: none;
  cursor: pointer;
}
.ui-dialog :is(input[type='submit'], .button):hover {
  background: var(--ui-bg-elevated);
}
/* The Grid/Table switch. */
.ui-dialog .js-media-library-view > header {
  display: flex;
  gap: 1rem;
  margin-bottom: 0.75rem;
  border-bottom: 1px solid var(--ui-border);
}
.ui-dialog .views-display-link {
  padding: 0 0 0.5rem;
  border-bottom: 2px solid transparent;
  color: var(--ui-text-muted);
  font-weight: 600;
  text-decoration: none;
}
.ui-dialog .views-display-link.is-active {
  border-bottom-color: var(--ui-primary);
  color: var(--ui-primary);
}
.ui-dialog .view-empty {
  padding: 1.5rem 0;
  color: var(--ui-text-muted);
}
/* The media grid: one column per ~10rem of dialog width. */
.ui-dialog .js-media-library-views-form {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
  gap: 0.75rem;
}
/* The form's hidden inputs and its actions row span the grid. */
.ui-dialog .js-media-library-views-form > :not(.js-media-library-item) {
  grid-column: 1 / -1;
}
.ui-dialog .js-media-library-item {
  position: relative;
  padding: 0.5rem;
  border: 1px solid var(--ui-border);
  border-radius: var(--okb-radius);
  background: var(--ui-bg);
  cursor: pointer;
}
.ui-dialog .js-media-library-item:hover {
  border-color: var(--ui-border-accented);
}
.ui-dialog .js-media-library-item:has(:checked) {
  border-color: var(--ui-primary);
  box-shadow: 0 0 0 1px var(--ui-primary);
}
.ui-dialog .js-media-library-item-preview img {
  display: block;
  width: 100%;
  height: 7rem;
  object-fit: contain;
  object-position: center;
  background: var(--ui-bg-muted);
  border-radius: calc(var(--okb-radius) - 4px);
}
.ui-dialog .js-media-library-item .field-content {
  display: block;
  overflow: hidden;
  font-size: 0.8125rem;
  text-overflow: ellipsis;
}
/* The checkbox rides on the thumbnail's top-left corner. */
.ui-dialog .js-click-to-select-checkbox {
  position: absolute;
  z-index: 1;
  top: 0.75rem;
  left: 0.75rem;
}
.ui-dialog .js-click-to-select-checkbox .form-item {
  margin-bottom: 0;
}
.ui-dialog .form-checkbox {
  width: 1.125rem;
  height: 1.125rem;
  accent-color: var(--ui-primary);
  cursor: pointer;
}
/* "Insert selected" — jQuery UI moves it out of the form into its own pane. */
.ui-dialog .ui-dialog-buttonpane {
  display: flex;
  justify-content: flex-end;
  padding: 0.75rem 1rem;
  border-top: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
/* The dialog's own answer, so it reads as the primary action. */
.ui-dialog .button--primary {
  min-height: 2.75rem;
  padding: 0 1rem;
  border-color: var(--ui-primary);
  background: var(--ui-primary);
  color: var(--ui-text-inverted);
  font-size: 0.875rem;
  font-weight: 600;
}
.ui-dialog .button--primary:hover {
  background: var(--okb-primary-hover);
}
</style>
