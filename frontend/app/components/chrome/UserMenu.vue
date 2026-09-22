<script setup lang="ts">
/**
 * The session user in the app chrome: avatar, and the account menu behind it.
 * Rendered twice — compact in the navbar, with the account name beside it in
 * the sidebar footer — off one shared `/api/me` fetch and one shared menu.
 *
 * The menu items are Drupal's `account` menu, fetched with the connector's
 * menu support exactly as the Lupus Decoupled starter's account navigation
 * does. Nothing about signing out is reimplemented here: "Log out" is the link
 * Drupal delivers, carrying the CSRF token `user.logout` requires, and
 * following it is an ordinary page load. That request reaches Drupal through
 * the same CE proxy every page uses, so Drupal ends the session, expires its
 * own session cookie through the proxy's passed-through `Set-Cookie`, and
 * answers with a redirect the connector follows. Presentation — the avatar
 * chip, the name, the dropdown — is this app's; every href in it is Drupal's.
 *
 * One entry is this app's own page rather than Drupal's: the help page at
 * `/help/shortcuts`, which the account menu is the visible way into.
 *
 * Two entries address the Drupal backend directly, because Drupal owns those
 * screens and this frontend has no rendering for them: the account form (where
 * the user picture is set) and, for an admin session only, the backend itself.
 * Both are full navigations to the backend origin — one URL the platform
 * already knows, `public.drupalBaseUrl`.
 *
 * An anonymous session gets the menu's sign-in link instead of the dropdown:
 * there is no identity to show and nothing to sign out of. That is a real
 * state — the auth middleware normally keeps anonymous sessions off these
 * pages, but a session can expire between SSR and this fetch.
 *
 * Opening on hover is `HoverDropdownMenu`'s, not this component's.
 */
import type { DropdownMenuItem } from '@nuxt/ui'
import { ConfigProvider } from 'reka-ui'
import { accountItemIcon, signInItem, type AccountMenuItem } from '#shared/utils/account-menu'
import { backendUrl } from '#shared/utils/user'

withDefaults(defineProps<{
  /** Show the account name next to the avatar (the sidebar footer variant). */
  withName?: boolean
  /** Drop the sign-in label — for the collapsed sidebar rail, which has no
   *  room for it. The avatar and the icon still carry the state. */
  compact?: boolean
}>(), { withName: false, compact: false })

// Reka mints the trigger and content ids through its ConfigProvider's `useId`,
// which Nuxt UI wires to Vue's — and the two renders fork that counter's id
// namespace differently, so they disagree on the trigger's id. A sequence of
// this menu's own reads the same in both, and keeps the content's
// aria-labelledby on the button that opens it. The prefix comes from this
// instance, because the phone chrome mounts a second copy in the slideover and
// two menus sharing an id would leave that labelling ambiguous.
const menuIdPrefix = useId()
let rekaIds = 0
const nextRekaId = () => `${menuIdPrefix}-${rekaIds++}`

const { name, uid, avatar, isSignedIn, isAdmin } = useCurrentUser()
const { accountMenu } = await useAccountMenu()

const backendBase = useRuntimeConfig().public.drupalBaseUrl as string | undefined

const backendItems = computed<DropdownMenuItem[]>(() => {
  const items: DropdownMenuItem[] = []
  if (uid.value != null) {
    items.push({
      label: 'Edit profile',
      icon: 'i-lucide-user-pen',
      to: backendUrl(backendBase, `/user/${uid.value}/edit`),
      external: true,
    })
  }
  if (isAdmin.value) {
    items.push({
      label: 'Admin backend',
      icon: 'i-lucide-shield',
      to: backendUrl(backendBase, '/admin'),
      external: true,
    })
  }
  return items
})

// The in-app help page. A router link, not a backend one: it is this app's own
// page, and it says what this app's editor and chrome answer to.
const helpItems: DropdownMenuItem[] = [{
  label: 'Shortcuts',
  icon: 'i-lucide-keyboard',
  to: '/help/shortcuts',
}]

const items = computed<DropdownMenuItem[][]>(() => [
  [{ label: name.value ?? 'Account', type: 'label' }],
  helpItems,
  backendItems.value,
  accountMenu.value.map(item => ({
    label: item.title,
    icon: accountItemIcon(item),
    // A full page load, not a router navigation: the SSR pass is what carries
    // the session cookie to Drupal, and only a real request re-runs it. A
    // client-side route change would neither reach Drupal nor clear the
    // killed session's payload off the screen.
    to: item.relative,
    external: true,
  })),
].filter(group => group.length > 0))

const signIn = computed<AccountMenuItem | undefined>(() => signInItem(accountMenu.value))

// In the collapsed sidebar rail the menu drops out of the rail's box, so the
// rail holds itself open while it is on screen.
const menuOpen = ref(false)
useRailHold(menuOpen)
</script>

<template>
  <UButton
    v-if="!isSignedIn"
    :to="signIn?.relative ?? '/user/login'"
    external
    data-testid="user-sign-in"
    color="neutral"
    variant="ghost"
    size="sm"
    icon="i-lucide-log-in"
    aria-label="Sign in"
    class="min-h-11 min-w-11 justify-center"
  >
    <span v-if="!compact">{{ signIn?.title ?? 'Sign in' }}</span>
  </UButton>

  <!-- Both variants are pointer targets in the phone chrome — the navbar one
       avatar-only — so each keeps a 44px box regardless of how small the
       avatar inside it is, and shows where focus is without relying on the
       hover tint. -->
  <ConfigProvider v-else :use-id="nextRekaId">
    <HoverDropdownMenu
      v-model:open="menuOpen"
      :items="items"
      :content="{ align: 'end', side: 'bottom' }"
    >
      <button
        type="button"
        data-testid="user-menu"
        :aria-label="name ? `Account: ${name}` : 'Account'"
        class="flex min-h-11 items-center gap-2 rounded-md px-1 py-0.5 hover:bg-elevated focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ui-primary)"
        :class="withName ? 'min-w-0' : 'min-w-11 justify-center'"
      >
        <!-- The button carries the name; the picture is decorative inside it. -->
        <UAvatar v-bind="avatar" alt="" size="sm" />
        <span
          v-if="withName"
          class="min-w-0 flex-1 truncate text-left text-[12.5px] font-semibold leading-tight text-highlighted"
        >{{ name }}</span>
      </button>
    </HoverDropdownMenu>
  </ConfigProvider>
</template>
