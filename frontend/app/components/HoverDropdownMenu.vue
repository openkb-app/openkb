<script setup lang="ts">
/**
 * A `UDropdownMenu` a mouse can also open by resting on the trigger. Nuxt UI
 * has no hover trigger, so this component owns `open` while the pointer owns
 * the menu; press, keyboard and touch stay the dropdown's own.
 */
import type { DropdownMenuProps } from '@nuxt/ui'
import { defaultDocument, useEventListener, useMediaQuery, useTimeoutFn } from '@vueuse/core'
import { Primitive } from 'reka-ui'
// Explicit, not auto-imported: the component is rendered by its own vitest
// suite outside a Nuxt app.
import { computed, ref, useSlots, watch } from 'vue'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  /** How long a mouse rests on the trigger before the menu opens. */
  openDelay?: number
  /** How long the menu survives the pointer leaving it. */
  closeDelay?: number
  /** The dropdown's content props; the focus handling here is merged in. */
  content?: DropdownMenuProps['content']
}>(), { openDelay: 150, closeDelay: 300, content: undefined })

/** This component's own, unless the parent binds `v-model:open`. */
const open = defineModel<boolean>('open', { default: false })

/** Reka's cancelable "this layer is about to take focus" event. Nuxt UI's
 *  content wrapper is a fragment, so `onOpenAutoFocus` in `:content` never
 *  arrives and the event has to be caught ahead of reka's own listener. */
const AUTOFOCUS_ON_MOUNT = 'focusScope.autoFocusOnMount'

const slots = useSlots()
const triggerHost = ref<{ $el: HTMLElement } | null>(null)
/**
 * Who owns the open menu. Hover claims it for the pointer; the click that
 * commits to a hover-opened menu takes it for the click, which reka read as a
 * press outside the open layer and so will not focus the trigger back.
 */
const owner = ref<'pointer' | 'click' | null>(null)
/** Hover behaviour at all: a device without a fine pointer gets none of it. */
const hoverCapable = useMediaQuery('(hover: hover) and (pointer: fine)')

/** Every slot but the trigger goes on to the dropdown. Recomputed per render,
 *  the way Nuxt UI's own wrappers pass slots through. */
function menuSlots(): string[] {
  return Object.keys(slots).filter(name => name !== 'default')
}

/** A menu under the pointer must leave pointer events on the rest of the page,
 *  or the pointer leaving it is never seen. */
const modal = computed(() => (hoverCapable.value ? false : undefined))

const contentProps = computed(() => ({
  ...props.content,
  onCloseAutoFocus: (event: Event) => {
    settleFocusOnClose(event)
    props.content?.onCloseAutoFocus?.(event)
  },
  onInteractOutside: (event: Event) => {
    // The click that closes the menu also chose where focus belongs; dropping
    // ownership leaves it there, as reka does. The trigger is outside the
    // content too, but a click on it commits to the menu rather than leaving.
    if (!overTrigger(event.target)) owner.value = null
    props.content?.onInteractOutside?.(event)
  },
}))

const { start: startOpen, stop: stopOpen } = useTimeoutFn(() => {
  owner.value = 'pointer'
  open.value = true
}, () => props.openDelay, { immediate: false })

const { start: startClose, stop: stopClose, isPending: closing } = useTimeoutFn(() => {
  open.value = false
}, () => props.closeDelay, { immediate: false })

function trigger(): HTMLElement | null {
  return triggerHost.value?.$el ?? null
}

/** This instance's open menu: reka names it on its own trigger. */
function menuElement(): HTMLElement | null {
  const id = trigger()?.getAttribute('aria-controls')
  return id ? document.getElementById(id) : null
}

function hoverFrom(event: PointerEvent): boolean {
  return hoverCapable.value && event.pointerType === 'mouse'
}

function overTrigger(target: EventTarget | null): boolean {
  return target instanceof Node && !!trigger()?.contains(target)
}

function onPointerEnter(event: PointerEvent): void {
  if (!hoverFrom(event)) return
  stopClose()
  if (!open.value) startOpen()
}

function onPointerLeave(event: PointerEvent): void {
  if (!hoverFrom(event)) return
  stopOpen()
  if (owner.value === 'pointer') startClose()
}

/** Closes once the pointer is on neither the trigger nor the menu. */
function trackPointer(event: PointerEvent): void {
  if (owner.value !== 'pointer' || !hoverFrom(event)) return
  const target = event.target
  if (overTrigger(target) || (target instanceof Node && !!menuElement()?.contains(target))) stopClose()
  else if (!closing.value) startClose()
}

/** Keeps the menu open under the click that commits to a hover-opened one. */
function keepOpenOnClick(event: Event): void {
  if (!overTrigger(event.target)) return
  owner.value = 'click'
  stopClose()
  event.stopPropagation()
  // The declined autofocus left the keyboard outside the menu; committing to it
  // takes the keyboard, onto the content a click-opened menu focuses.
  menuElement()?.focus({ preventScroll: true })
}

/**
 * Where focus goes when this component's menu closes. Only the click that took
 * the keyboard into the menu wants reka's default of the trigger: the
 * pointer's menu never took it, and an outside interaction dropped ownership
 * so its own target keeps it.
 */
function settleFocusOnClose(event: Event): void {
  const closedBy = owner.value
  owner.value = null
  if (closedBy === null) return
  event.preventDefault()
  if (closedBy === 'click') trigger()?.focus({ preventScroll: true })
}

useEventListener(defaultDocument, AUTOFOCUS_ON_MOUNT, (event: Event) => {
  if (owner.value !== 'pointer') return
  // Every reka layer's focus scope raises this on the document. Only this
  // menu's declines it — the scope wraps the content the trigger names.
  const menu = menuElement()
  const scope = event.target
  if (menu && scope instanceof Element && scope.contains(menu)) event.preventDefault()
}, true)

// Only while the menu is the pointer's: a pressed or keyboard-opened one is the
// dropdown's own to close.
const pointerOwned = computed(() => (open.value && owner.value === 'pointer' ? defaultDocument : null))
useEventListener(pointerOwned, 'pointerover', trackPointer)
useEventListener(pointerOwned, 'click', keepOpenOnClick, true)

watch(open, (value) => {
  if (value) return
  stopOpen()
  stopClose()
})
</script>

<template>
  <UDropdownMenu
    v-bind="$attrs"
    v-model:open="open"
    :content="contentProps"
    :modal="modal"
  >
    <!-- Reka's `as-child` chain keeps the consumer's own element as the
         trigger, so the menu's aria and the focus ring stay on it. -->
    <Primitive
      ref="triggerHost"
      as-child
      @pointerenter="onPointerEnter"
      @pointerleave="onPointerLeave"
      @pointerdown="stopOpen"
    >
      <slot />
    </Primitive>

    <template v-for="name in menuSlots()" #[name]="slotProps">
      <slot :name="name" v-bind="slotProps ?? {}" />
    </template>
  </UDropdownMenu>
</template>
