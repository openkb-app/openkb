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

  /**
   * Sends `text` as the reader's turn.
   *
   * @param text
   *   The turn's text.
   * @param extra
   *   More caller context; `commentThread` marks a comment turn.
   */
  return function ask(text: string, extra: Record<string, unknown> = {}): Promise<void> {
    const context = {
      scope: scope.value,
      ...(pagePath.value ? { path: pagePath.value } : {}),
      ...(pageSpace.value ? { space: pageSpace.value } : {}),
      ...extra,
    }
    askedScopes.value.push(scope.value === SCOPE_ALL ? null : scopeLabel(scope.value, spaces.value))
    // Kept on the message for the panel: whether it is a comment turn.
    const metadata = turnMetadata(Boolean(extra.commentThread))
    return chat.sendMessage({ text, metadata }, { body: { context } })
  }
}
