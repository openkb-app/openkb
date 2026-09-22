/**
 * The two global shortcuts the chrome advertises with a `UKbd` hint: `⌘K`
 * opens search, `⌘J` toggles the Ask OpenKnowledgebase chat. Mounted once,
 * from the default layout — a hint that is painted but not handled is a lie,
 * and both hints show on every page the layout wraps.
 *
 * `meta_*` covers both platforms: `defineShortcuts` rewrites a meta shortcut to
 * ctrl off macOS, the same way `UKbd value="meta"` renders `Ctrl` there. It
 * also ignores keystrokes typed into an input, a textarea or a contenteditable,
 * so the editor keeps `⌘K` for its own link command — but `⌘J` opts back in,
 * because the chat's composer takes focus the moment it opens and the same
 * keystroke has to close it again.
 */
export function useAppShortcuts() {
  const router = useRouter()
  const route = useRoute()
  const { toggleChat } = useSidePane()

  defineShortcuts({
    meta_k: () => openSearch(),
    meta_j: { usingInput: true, handler: () => toggleChat() },
  })

  /**
   * Search is a route, not a command palette, so the shortcut navigates there
   * and hands the caret to the query field.
   */
  function openSearch() {
    if (route.path === '/search') {
      void focusSearchInput()
      return
    }
    void router.push('/search').then(focusSearchInput)
  }
}

/**
 * The field belongs to the search page, which is not mounted yet when the
 * shortcut fires from another route — `nextTick` lands after the route
 * component has rendered.
 */
async function focusSearchInput() {
  await nextTick()
  const input = document.querySelector<HTMLInputElement>('input[data-testid="search-input"]')
  input?.focus()
  input?.select()
}
