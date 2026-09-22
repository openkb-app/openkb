/**
 * Show the browser's standard "unsaved changes" prompt on close / navigation
 * while `isDirty` is true. Auto-registers on mount, unregisters on unmount.
 */
export function useBeforeUnloadGuard(isDirty: Ref<boolean>): void {
  const handler = (e: BeforeUnloadEvent) => {
    if (isDirty.value) {
      e.preventDefault()
      e.returnValue = ''
    }
  }
  onMounted(() => window.addEventListener('beforeunload', handler))
  onBeforeUnmount(() => window.removeEventListener('beforeunload', handler))
}
