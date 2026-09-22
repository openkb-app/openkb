import type { CommentAssignee, CommentThread } from '#shared/block-comments'
import type { JsonSchema } from './types'

/**
 * A block's conversation, as both tool surfaces that carry threads serve it —
 * `getPageForEditing` what stands, `waitForChanges` what just changed.
 *
 * The live model (`#shared/block-comments`) minus its internals: a reader
 * needs the standing (`resolved`) and what was said, not the bookkeeping.
 */

/** One message of a thread, as a reader is given it. */
export interface ThreadMessage {
  id: string
  uid: number | null
  name: string | null
  /** Agent client's label — set exactly when an agent said it. */
  via: string | null
  at: number
  text: string
}

/** One conversation about one block. */
export interface ProjectedThread {
  blockId: string
  threadId: string
  anchor: { from: number, to: number, quote: string } | null
  messages: ThreadMessage[]
  resolved: boolean
  /** Whose thread it is, or null for nobody's. */
  assignee: CommentAssignee | null
  openedAt: number
  lastAt: number
}

/** The live thread, projected. */
export function projectThread(thread: CommentThread): ProjectedThread {
  return {
    blockId: thread.blockId,
    threadId: thread.threadId,
    anchor: thread.anchor,
    messages: thread.messages.map(message => ({
      id: message.id,
      uid: message.uid,
      name: message.name ?? null,
      via: message.via ?? null,
      at: message.at,
      text: message.text ?? '',
    })),
    resolved: thread.resolved,
    assignee: thread.assignee,
    openedAt: thread.openedAt,
    lastAt: thread.lastAt,
  }
}

/** Threads a reader asked for: open ones, plus the resolved on request. */
export function projectThreads(threads: CommentThread[], includeResolved: boolean): ProjectedThread[] {
  return threads.filter(thread => includeResolved || !thread.resolved).map(projectThread)
}

/** What a thread looks like wherever one is served. */
export const THREAD_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    blockId: { type: 'string', description: 'The block the conversation is about.' },
    threadId: {
      type: 'string',
      description: 'Pass it to commentOnBlock as `threadId` to answer this thread.',
    },
    anchor: {
      description:
        'The passage the thread was opened on, as it read then — `quote` is what '
        + 'it is about and the offsets are where it was. Null for a thread about '
        + 'the whole block.',
      anyOf: [
        {
          type: 'object',
          properties: {
            from: { type: 'integer' },
            to: { type: 'integer' },
            quote: { type: 'string' },
          },
          required: ['from', 'to', 'quote'],
          additionalProperties: false,
        },
        { type: 'null' },
      ],
    },
    messages: {
      type: 'array',
      description: 'What was said, oldest first.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          uid: { type: ['integer', 'null'], description: 'The account that said it.' },
          name: { type: ['string', 'null'] },
          via: {
            type: ['string', 'null'],
            description:
              'The agent label it was said under — set exactly when an agent said '
              + 'it, so "editor1" with `via` "Claude" is that account\'s agent and '
              + 'not the person.',
          },
          at: { type: 'integer', description: 'Wall-clock ms.' },
          text: { type: 'string' },
        },
        required: ['id', 'uid', 'name', 'via', 'at', 'text'],
        additionalProperties: false,
      },
    },
    resolved: {
      type: 'boolean',
      description:
        'Whether an editor has marked the thread done. Only a human does that — '
        + 'there is no tool for it.',
    },
    assignee: {
      description:
        'Who is expected to act on this thread, or null for nobody in '
        + 'particular. `via` set means the agent of that account — so a thread '
        + 'assigned to YOUR uid with YOUR `via` is yours to answer.',
      anyOf: [
        {
          type: 'object',
          properties: {
            uid: { type: ['integer', 'null'] },
            name: { type: 'string' },
            via: { type: ['string', 'null'] },
          },
          required: ['uid', 'name'],
          additionalProperties: false,
        },
        { type: 'null' },
      ],
    },
    openedAt: { type: 'integer' },
    lastAt: { type: 'integer', description: 'The latest activity of any kind.' },
  },
  required: [
    'blockId', 'threadId', 'anchor', 'messages', 'resolved', 'assignee', 'openedAt', 'lastAt',
  ],
  additionalProperties: false,
}
