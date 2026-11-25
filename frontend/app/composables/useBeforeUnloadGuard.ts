/**
 * Show the browser's standard "unsaved changes" prompt on close / navigation
 * while `isDirty` is true. Auto-registers on mount, unregisters on unmount.
 */
export function useBeforeUnloadGuard(isDirty: MaybeRefOrGetter<boolean>): void {
  /** Asks the browser to confirm the unload while dirty. */
  const handler = (e: BeforeUnloadEvent) => {
    if (toValue(isDirty)) {
      e.preventDefault()
      e.returnValue = ''
    }
  }
  onMounted(() => window.addEventListener('beforeunload', handler))
  onBeforeUnmount(() => window.removeEventListener('beforeunload', handler))
}
