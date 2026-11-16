import { SCOPE_ALL, scopeLabel } from '#shared/utils/chat-scope'

/**
 * Sends a question into the chat panel's conversation, with the caller context
 * every turn carries: the scope, the page the reader has open and its space,
 * plus `extra`. Resolves when the answer has ended.
 */
export function useChatAsk() {
  const { chat, scope, askedScopes } = useChatPanelSession()

  // Only the catch-all page route is a page the tools can address.
  const route = useRoute()
  const pagePath = computed(() => (route.name === 'slug' ? route.path : null))
  const { slug: pageSpace } = useActiveSpace()
  const { spaces } = useSpaces()

  return function ask(text: string, extra: Record<string, unknown> = {}): Promise<void> {
    const context = {
      scope: scope.value,
      ...(pagePath.value ? { path: pagePath.value } : {}),
      ...(pageSpace.value ? { space: pageSpace.value } : {}),
      ...extra,
    }
    askedScopes.value.push(scope.value === SCOPE_ALL ? null : scopeLabel(scope.value, spaces.value))
    return chat.sendMessage({ text }, { body: { context } })
  }
}
