/**
 * Reactive "5s ago" / "2m ago" / "just now" label that auto-refreshes
 * every 5 seconds. Pass a Ref<number | null> of epoch milliseconds.
 * Returns a Ref<string | null> for the human label.
 */
export function useRelativeTime(timestamp: Ref<number | null>): Ref<string | null> {
  const label = ref<string | null>(null)

  const compute = () => {
    const ts = timestamp.value
    if (!ts) { label.value = null; return }
    const sec = Math.floor((Date.now() - ts) / 1000)
    if (sec < 5) label.value = 'just now'
    else if (sec < 60) label.value = `${sec}s ago`
    else if (sec < 3600) label.value = `${Math.floor(sec / 60)}m ago`
    else label.value = `${Math.floor(sec / 3600)}h ago`
  }

  compute()
  watch(timestamp, compute)

  let timer: ReturnType<typeof setInterval> | null = null
  onMounted(() => { timer = setInterval(compute, 5000) })
  onBeforeUnmount(() => { if (timer) clearInterval(timer) })

  return label
}
