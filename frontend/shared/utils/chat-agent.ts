/**
 * The `via` of every write the AI chat makes: the label of its OAuth client
 * (`ChatAgentToken::LABEL`).
 */
export const CHAT_AGENT_LABEL = 'AI chat'

/**
 * How long a chat tab's take on a thread holds. A tab closed mid-turn never
 * gives the thread back, so the take lapses instead.
 */
export const CHAT_HANDLING_TTL_MS = 5 * 60_000

/** Whether a take is still held at `now`. */
export function handlingLive(handling: { at: number } | null | undefined, now: number): boolean {
  return !!handling && now - handling.at < CHAT_HANDLING_TTL_MS
}
