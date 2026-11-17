/**
 * The `via` of every write the AI assistant makes: the label of its OAuth
 * client (`ChatAgentToken::LABEL`).
 */
export const CHAT_AGENT_LABEL = 'AI assistant'

/**
 * How long a chat tab's take on a thread holds. The collab server ends a take
 * when the tab's connection closes; one it could not end (it restarted)
 * lapses.
 */
export const CHAT_HANDLING_TTL_MS = 5 * 60_000

/** Whether a take is still held at `now`. */
export function handlingLive(handling: { at: number } | null | undefined, now: number): boolean {
  return !!handling && now - handling.at < CHAT_HANDLING_TTL_MS
}
