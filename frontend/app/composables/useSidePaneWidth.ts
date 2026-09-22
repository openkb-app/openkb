import { useResizable } from '@nuxt/ui/composables'

/** A year: the width is a working preference, not a session detail. */
const REMEMBER_FOR = 60 * 60 * 24 * 365

/** Where the share is kept, in the shape Nuxt UI's resizing stores. */
const STORE = 'okb-side-pane-size'

/** Share of the row the pane may take, and the share it starts at. */
export const SIDE_PANE_MIN = 18
export const SIDE_PANE_MAX = 44
export const SIDE_PANE_DEFAULT = 31

/** One arrow key press, in the same share. */
const STEP = 2

const clamp = (share: number) => Math.min(SIDE_PANE_MAX, Math.max(SIDE_PANE_MIN, share))

/**
 * How wide the right pane is, as a share of the row it sits in, remembered per
 * browser. Nuxt UI's panel resizing does the work — `side: 'right'` reads the
 * drag from the pane's inner edge, clamps it and stores it. A share, so
 * collapsing the left rail widens both columns. The keys are ours.
 */
export function useSidePaneWidth() {
  const { el, size, isDragging, onMouseDown, onTouchStart, onDoubleClick } = useResizable(STORE, {
    side: 'right',
    minSize: SIDE_PANE_MIN,
    maxSize: SIDE_PANE_MAX,
    defaultSize: SIDE_PANE_DEFAULT,
    storageOptions: { sameSite: 'lax', maxAge: REMEMBER_FOR },
  })

  // The resizing's own `size` is read-only, so a key writes the store it reads
  // and `refreshCookie` hands it over. Counted off the store rather than off
  // `size`, so held keys compound instead of racing that hand-over.
  const stored = useCookie<{ size?: number, collapsed?: boolean }>(STORE, {
    sameSite: 'lax',
    maxAge: REMEMBER_FOR,
  })
  function nudge(by: number) {
    stored.value = { ...stored.value, size: clamp((stored.value?.size ?? SIDE_PANE_DEFAULT) + by) }
    refreshCookie(STORE)
  }

  function onKeydown(event: KeyboardEvent) {
    // Home and End name the ends of the value the separator carries — the
    // pane's share — so Home is the narrowest pane, not the leftmost handle.
    const step = { ArrowLeft: STEP, ArrowRight: -STEP, Home: -SIDE_PANE_MAX, End: SIDE_PANE_MAX }[event.key]
    if (!step) return
    event.preventDefault()
    nudge(step)
  }

  return {
    el,
    width: size,
    dragging: isDragging,
    onKeydown,
    onPointerDown: onMouseDown,
    onTouchStart,
    reset: onDoubleClick,
  }
}
