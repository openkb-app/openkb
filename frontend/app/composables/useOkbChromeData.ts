import { ANONYMOUS_USER, userAvatar, type OkbUser } from '#shared/utils/user'
import { renderableAccountItems, type AccountMenuItem } from '#shared/utils/account-menu'
import type { KbSpaceListItem } from '#shared/utils/kb-outline'
import { canCreatePageIn, type KbPageListItem, type KbSpaceDetail } from '#shared/utils/kb-spaces'

/**
 * The keyed reads the app is built from — session user, spaces, pages, and one
 * space in full.
 *
 * Each is fetched under a fixed `useAsyncData` key, so the navbar, the sidebar
 * and whatever page is mounted share one request per payload instead of one
 * per component. The keys are the contract: any component that wants the
 * current user asks here, and the answer is the same object the user menu
 * renders.
 */

/** The signed-in account, plus the bits the avatar needs. */
export function useCurrentUser() {
  const { data: user } = useFetch<OkbUser>('/api/me', {
    key: 'okb-current-user',
    default: () => ANONYMOUS_USER,
  })
  return {
    user,
    name: computed(() => user.value?.name ?? null),
    uid: computed(() => user.value?.uid ?? null),
    /** Picture, initials or icon — whichever the session actually has. */
    avatar: computed(() => userAvatar(user.value)),
    isSignedIn: computed(() => user.value?.uid != null),
    isAdmin: computed(() => user.value?.isAdmin === true),
    canCreateSpace: computed(() => user.value?.canCreateSpace === true),
    canCreatePage: computed(() => user.value?.canCreatePage === true),
  }
}

/**
 * The reader's own agent clients, by the label they act under.
 *
 * A thread can be handed to an agent that is not in the page, so the picker
 * needs the labels the caller's clients hold — the session reports only the
 * agents that are here.
 */
export function useMyAgents(wanted: Ref<boolean>) {
  // The read is the session's own, so it goes out under the caller's cookie on
  // the server pass as well.
  const requestFetch = useRequestFetch()
  const { data } = useAsyncData(
    'okb-my-agents',
    async () => {
      if (!wanted.value) return { agents: [] }
      try {
        // The forwarding route is JSON-only and ofetch sends `Accept` only
        // with a body, so a GET has to name it.
        return await requestFetch<{ agents: Array<{ label: string }> }>(
          '/api/drupal/openkb/me/agents',
          { headers: { Accept: 'application/json' } },
        )
      }
      catch {
        // No clients, or nobody signed in: a picker without its own agents is
        // the page still working.
        return { agents: [] }
      }
    },
    { default: () => ({ agents: [] }), watch: [wanted] },
  )
  return computed(() => data.value?.agents ?? [])
}

/**
 * Whether to draw the "new page" CTA for the space in context.
 *
 * The one place the two halves of Drupal's rule are put together — the site
 * permission from `/api/me`, write access to the space from `/api/spaces` — so
 * every CTA asks the same question. `slug` is `null` where no space is in
 * context; the dialog asks for one there, so any writable space is enough.
 */
export function useCanCreatePage(slug: MaybeRefOrGetter<string | null>) {
  const { spaces } = useSpaces()
  const { canCreatePage } = useCurrentUser()
  return computed(() => canCreatePageIn(spaces.value, toValue(slug), canCreatePage.value))
}

/**
 * Drupal's `account` menu — the items the user menu renders.
 *
 * `fetchMenu` keys its own `useAsyncData` entry (`menu-account`) and serves it
 * from the payload afterwards, so this is one request per page load however
 * many chrome components ask.
 *
 * The response is per-session: the login/logout link switches on who is
 * asking, and the logout URL carries that session's CSRF token. So the fetch
 * has to be made as the session — the connector forwards the cookie on the SSR
 * pass (`fetchProxyHeaders`, see nuxt.config.ts) — and it must not be shared
 * between users. Nothing caches it beyond the payload of the page load that
 * produced it, which is the same page load that produced the token.
 */
export async function useAccountMenu() {
  const menu = await useDrupalCe().fetchMenu('account')
  return {
    accountMenu: computed<AccountMenuItem[]>(() =>
      renderableAccountItems(menu.value as AccountMenuItem[] | null),
    ),
  }
}

/**
 * Every space the session may see, name-sorted (as `/api/spaces` returns).
 *
 * Carries the page tree and `canManage` as well as the summary fields, because
 * this is the only read of `/api/spaces` a render makes — `useKbOutline` builds
 * its trees from this same value rather than asking again.
 */
export function useSpaces() {
  const { data: spaces, refresh: refreshSpaces } = useFetch<KbSpaceListItem[]>('/api/spaces', {
    key: 'okb-spaces',
    default: () => [],
  })
  return { spaces, refreshSpaces }
}

/**
 * One space in full — roster, read access, moderation — keyed per slug, so
 * concurrent readers share one request. An empty slug fetches nothing. Handed
 * back as Nuxt's `AsyncData`, because the space page awaits it to 404 before
 * it renders.
 */
export function useSpaceDetail(slug: MaybeRefOrGetter<string | null | undefined>) {
  return useFetch<KbSpaceDetail>(() => `/api/spaces/${toValue(slug)}`, {
    key: () => `okb-space-${toValue(slug) ?? ''}`,
    enabled: () => !!toValue(slug),
    default: () => null,
  })
}

/** The kb_page listing the sidebar groups by space. */
export function useKbPages() {
  const { data: pages, refresh: refreshPages } = useFetch<KbPageListItem[]>('/api/kb', {
    key: 'okb-pages',
    default: () => [],
  })
  return { pages, refreshPages }
}
