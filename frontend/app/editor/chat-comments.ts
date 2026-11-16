import type { CommentAssignee, CommentThread } from '#shared/block-comments'
import { CHAT_AGENT_LABEL, handlingLive } from '#shared/utils/chat-agent'

/**
 * Comment threads the reader's AI chat works: which ones are its to take, and
 * what it is asked to do with one.
 *
 * Pure over its inputs, so the pick and the wording are pinned without a
 * browser.
 */

/** The reader's AI chat as an assignee. */
export function chatAssignee(me: { uid: number, name: string }): CommentAssignee {
  return { uid: me.uid, name: me.name, via: CHAT_AGENT_LABEL }
}

/** Whether `who` is the AI chat of account `uid`. */
function isChatOf(who: CommentAssignee | null | undefined, uid: number | null | undefined): boolean {
  return !!who && uid != null && who.uid === uid && who.via === CHAT_AGENT_LABEL
}

/**
 * Whether the thread waits on the chat of account `uid`: open, assigned to it
 * by `uid` itself, and its latest message written by `uid` in person. So:
 * - another account never starts this account's chat;
 * - the chat's reply (any agent write of `uid`) ends the turn, whatever the
 *   chat client is labelled;
 * - the account's next message hands the thread back.
 */
export function awaitsChat(thread: CommentThread, uid: number | null | undefined): boolean {
  if (thread.resolved || !isChatOf(thread.assignee, uid) || thread.assignedBy?.uid !== uid) return false
  const last = thread.messages.at(-1)
  return !!last && last.uid === uid && !last.via
}

/** The key of one thread's latest message — a turn is asked once per message. */
export function turnKey(thread: CommentThread): string {
  return `${thread.blockId}\0${thread.threadId}:${thread.messages.at(-1)?.id ?? ''}`
}

/**
 * The next thread for the chat to take, or null: waiting on it, held by no
 * live tab, and not asked already for its latest message.
 */
export function nextForChat(
  threads: readonly CommentThread[],
  uid: number | null | undefined,
  now: number,
  asked: ReadonlySet<string>,
): CommentThread | null {
  return threads.find(thread =>
    awaitsChat(thread, uid) && !handlingLive(thread.handling, now) && !asked.has(turnKey(thread))) ?? null
}

/**
 * The turn a thread is sent as: the reader's request and nothing more. How to
 * work it is the comment tool's description to say, keyed by
 * {@link chatTurnContext}.
 */
export function chatTurnText(thread: CommentThread): string {
  const lines = [`Review comment thread ${thread.threadId} on block ${thread.blockId}:`]
  if (thread.anchor?.quote) lines.push(`About the passage: "${thread.anchor.quote}"`)
  for (const message of thread.messages) {
    lines.push(`${message.via ? `${message.name} via ${message.via}` : message.name}: ${message.text}`)
  }
  return lines.join('\n')
}

/** The caller context a thread's turn carries: the thread the chat works. */
export function chatTurnContext(thread: CommentThread): { commentThread: { blockId: string, threadId: string } } {
  return { commentThread: { blockId: thread.blockId, threadId: thread.threadId } }
}

/** Whether the chat of `uid` replied in the thread since the messages in `before`. */
export function chatReplied(thread: CommentThread, uid: number | null | undefined, before: ReadonlySet<string>): boolean {
  return uid != null && thread.messages.some(m => !before.has(m.id) && m.uid === uid && !!m.via)
}

/**
 * Whether a thread the chat's turn has ended on goes back to the reader. Only
 * when it is:
 * - still open and with the chat of `uid`;
 * - still taken by `tab` — after a lapse another tab may be working it;
 * - without a new message of `uid` since `before`: neither the chat's reply nor
 *   the reader's own, which goes to the chat next.
 */
export function needsHandBack(
  thread: CommentThread | undefined,
  uid: number | null | undefined,
  before: ReadonlySet<string>,
  tab: string,
): boolean {
  return !!thread && !thread.resolved && isChatOf(thread.assignee, uid) && thread.handling?.tab === tab
    && !thread.messages.some(m => !before.has(m.id) && m.uid === uid)
}

/** What the thread is told when the chat's turn ends without a reply in it. */
export const HAND_BACK_TEXT = `${CHAT_AGENT_LABEL} did not reply here, so the thread is back with you. See the chat for what happened.`
