/**
 * The instant a relative "last updated" label is measured against.
 *
 * - Shared with the server render through the payload, so the hydrating client
 *   lands in the same bucket and hydrates without a mismatch.
 * - Re-read on mount, then ticked once a minute, so an open page stops saying
 *   "just now".
 */
export function useKbNow(): Ref<number> {
  const now = useState('kb-updated-now', () => Date.now())
  let timer: ReturnType<typeof setInterval> | null = null
  onMounted(() => {
    now.value = Date.now()
    timer = setInterval(() => (now.value = Date.now()), 60_000)
  })
  onBeforeUnmount(() => { if (timer) clearInterval(timer) })
  return now
}
