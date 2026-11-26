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
  block: string
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
    block: thread.blockId,
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

/** A mention in comark text: its label and its attributes. */
const MENTION = /:mention\[((?:\\.|[^\]\\])*)\]\{([^}]*)\}/g

/** The account a mention's attributes name; 0 for none. */
function mentionUid(attributes: string): number {
  return Number(/(?:^|\s)uid="(\d+)"/.exec(attributes)?.[1] ?? 0)
}

/** Every account a thread names: its authors, its assignee and its mentions. */
export function threadAccountUids(thread: CommentThread): number[] {
  const uids = [
    ...thread.messages.map(message => message.uid ?? 0),
    thread.assignee?.uid ?? 0,
    ...thread.messages.flatMap(message => [...(message.text ?? '').matchAll(MENTION)].map(match => mentionUid(match[2]!))),
  ]
  return uids.filter(uid => uid > 0)
}

/** The agent label a mention's attributes name; comark quotes a value with the quote it does not hold. */
function mentionVia(attributes: string): string | null {
  const match = /(?:^|\s)via=(?:"([^"]*)"|'([^']*)')/.exec(attributes)
  return match ? (match[1] ?? match[2] ?? null) : null
}

/** The text with each mention of a known account labeled by its current name; an agent's reads `name via label`. */
export function relabelMentions(text: string, names: ReadonlyMap<number, string>): string {
  return text.replace(MENTION, (whole, _label: string, attributes: string) => {
    const name = names.get(mentionUid(attributes))
    if (name === undefined) return whole
    const via = mentionVia(attributes)
    const label = via === null ? name : `${name} via ${via}`
    return `:mention[${label.replace(/([\\[\]])/g, '\\$1')}]{${attributes}}`
  })
}

/** A thread with its authors, assignee and mentions named as they are called now. */
export function nameThreadCurrently(thread: CommentThread, names: ReadonlyMap<number, string>): CommentThread {
  /** `who`'s current name where it is known. */
  const current = <T extends { uid?: number | null, name?: string | null }>(who: T): T =>
    who.uid != null && names.has(who.uid) ? { ...who, name: names.get(who.uid)! } : who
  return {
    ...thread,
    messages: thread.messages.map(message => ({
      ...current(message),
      ...(message.text === undefined ? {} : { text: relabelMentions(message.text, names) }),
    })),
    assignee: thread.assignee ? current(thread.assignee) : null,
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
    block: {
      type: 'string',
      description: 'The block the conversation is about. Pass it to commentOnBlock as `block`.',
    },
    threadId: {
      type: 'string',
      description: 'Pass it to commentOnBlock as `threadId` to answer this thread.',
    },
    anchor: {
      description:
        'The passage the thread was opened on, as it read then — `quote` is what '
        + 'it is about and the offsets are where it was. A thread about the whole '
        + 'block quotes all of its text; null when the block had none.',
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
        'Whether the thread was marked done.',
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
    'block', 'threadId', 'anchor', 'messages', 'resolved', 'assignee', 'openedAt', 'lastAt',
  ],
  additionalProperties: false,
}
