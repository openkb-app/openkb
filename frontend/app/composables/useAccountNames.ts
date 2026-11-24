import { reactive, ref, watch, type InjectionKey, type Ref } from 'vue'
import { ACCOUNT_LOOKUP_LIMIT, isAccountUid } from '#shared/utils/account-lookup'

/**
 * Accounts' current names by uid, shared by every chip on the page.
 *
 * - Asked for in one batch per tick through `/api/users/search?uid=…`, split
 *   into lookups of `ACCOUNT_LOOKUP_LIMIT`.
 * - A uid the search does not answer (deleted, or not visible to the reader)
 *   has no name; `accountUnknown()` tells it apart from one still asked for.
 */
const names = reactive(new Map<number, string>())
/** Uids a lookup answered without them: gone, or not visible to the reader. */
const unknown = reactive(new Set<number>())
const asked = new Set<number>()
let pending: number[] = []
/** Counts the lookups answered, for readers outside Vue's reactivity. */
const answered = ref(0)

/** The reader's uid, for chips that read differently to an agent's owner. */
export const VIEWER_UID: InjectionKey<Readonly<Ref<number | null | undefined>>> = Symbol('okb-viewer-uid')

/** Fetches the names of the uids asked for since the last batch, one lookup per page of them. */
async function fetchPendingAccountNames(): Promise<void> {
  const uids = pending
  pending = []
  for (let start = 0; start < uids.length; start += ACCOUNT_LOOKUP_LIMIT) {
    await fetchAccountNames(uids.slice(start, start + ACCOUNT_LOOKUP_LIMIT))
  }
}

/** One lookup; a uid it could not answer is asked again on the next request. */
async function fetchAccountNames(uids: number[]): Promise<void> {
  try {
    const response = await fetch(`/api/users/search?uid=${uids.join(',')}`, { credentials: 'same-origin' })
    if (!response.ok) {
      for (const uid of uids) asked.delete(uid)
      return
    }
    const { users } = await response.json() as { users?: Array<{ uid: number, name: string }> }
    for (const user of users ?? []) names.set(user.uid, user.name)
    for (const uid of uids) {
      if (!names.has(uid)) unknown.add(uid)
    }
    answered.value++
  }
  catch {
    // Offline: the chips keep their labels until the next request.
    for (const uid of uids) asked.delete(uid)
  }
}

/** Asks for an account's current name once; the answer lands in the shared map. */
export function requestAccountName(uid: number): void {
  if (!isAccountUid(uid) || asked.has(uid)) return
  asked.add(uid)
  pending.push(uid)
  if (pending.length === 1) queueMicrotask(() => { void fetchPendingAccountNames() })
}

/** An account's current name, once known; undefined until then or for an unknown account. */
export function accountName(uid: number | null | undefined): string | undefined {
  return uid == null ? undefined : names.get(uid)
}

/** Calls `callback` whenever a lookup brought names; answers the function that stops it. */
export function onAccountNames(callback: () => void): () => void {
  return watch(answered, callback)
}

/** Whether the uid names no account the reader may see: not a uid, gone, or hidden. */
export function accountUnknown(uid: number): boolean {
  return !isAccountUid(uid) || unknown.has(uid)
}

/** `who` named by the account's current name once that is known. */
export function withCurrentName<T extends { uid?: number | null, name?: string | null }>(who: T): T {
  if (who.uid == null) return who
  requestAccountName(who.uid)
  const name = accountName(who.uid)
  return name === undefined ? who : { ...who, name }
}
