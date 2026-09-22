import type { InjectionKey, Ref } from 'vue'

/**
 * How a menu tells the collapsed sidebar rail to stay expanded. Provided by the
 * rail, so a component outside it holds nothing.
 */
export const railHoldKey = Symbol('rail-hold') as InjectionKey<(held: boolean) => void>

/**
 * Holds the rail expanded while this menu is open. Menu content renders outside
 * the rail, so entering it counts as leaving.
 */
export function useRailHold(open: Ref<boolean>) {
  const hold = inject(railHoldKey, null)
  if (!hold) return
  watch(open, hold)
  onScopeDispose(() => {
    if (open.value) hold(false)
  })
}
