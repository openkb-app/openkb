import type { H3Event } from 'h3'
import { joinWriteSession, resolveWriteSubject } from '../agent-write'
import { humanPeersOf } from '../agent-peer'
import {
  awaitChanges,
  changesSince,
  isAfterCursor,
  isCursorShaped,
  watchSession,
  CHANGE_KINDS,
  type ChangeAnswer,
  type ChangeEvent,
  type ChangeKind,
  type EventPeer,
} from '../session-events'
import { PATH_DESCRIPTION } from './schemas'
import { readThreads, type CommentThread } from '#shared/block-comments'
import { actorLabel } from '#shared/utils/attribution'
import { sessionRefusal, writeRefusal } from './write'
import { projectThread, THREAD_SCHEMA } from './comment-threads'
import { answered, type JsonSchema, type KbTool, type ToolResult } from './types'

/** Longest one call may wait, whatever it asks for. */
const MAX_TIMEOUT_SEC = 120
/** How long it waits when it asks for nothing in particular. */
const DEFAULT_TIMEOUT_SEC = 30

/**
 * The agent's way to work beside a human: wait until something happens.
 *
 * It joins the page's session the way a write does, because the events are
 * derived from the live Y.Doc (server/utils/session-events.ts). One request
 * per event: a loop costs the server one open request while the page is quiet.
 */
export function waitForChangesTool(): KbTool {
  return {
    name: 'waitForChanges',
    description:
      'Wait for the page to change under you, and answer as soon as it does — '
      + 'this is how you collaborate with somebody who is editing right now. '
      + 'Call it in a loop: each answer carries a `cursor`, and passing that '
      + 'cursor to the next call picks up exactly where the last one stopped, so '
      + 'nothing that happened while you were thinking is missed. Without a '
      + '`cursor` you start from now, and the first call answers at once with '
      + 'the open threads nobody has answered yet — what was said before you '
      + 'arrived.\n\n'
      + 'Three kinds of event, and they are for different things. `comments` is '
      + 'somebody talking to you: read the thread, do what it asks, then answer '
      + 'it with commentOnBlock. A thread whose `assignee` names your account '
      + 'and your agent label was handed to you in particular; you answer it and '
      + 'leave marking it done to a person. `blocks` is a block a person finished editing '
      + '(you are told when it went quiet, never per keystroke) — act on one only '
      + 'where your instructions say to. `presence` is who is in the page and '
      + 'which block they are in: never write into a block somebody is sitting '
      + 'in, wait for them to move on.\n\n'
      + 'An answer with no events means the wait timed out and nothing happened; '
      + 'call again with the cursor it gave you. `editors` is how many people '
      + 'have the page open, so a quiet page and an empty one are not the same '
      + 'answer. A `session` event is terminal — the editors have left or the '
      + 'session is gone — so stop the loop, and say what you did rather than '
      + 'waiting on an empty room. What you did yourself is never reported back '
      + 'to you. Waiting joins the page\'s editing session, so it needs the same '
      + 'write access as updateBlocks.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: PATH_DESCRIPTION },
        cursor: {
          type: 'string',
          description:
            'Where to resume, from the previous answer. Leave it off on the '
            + 'first call to start from now.',
        },
        kinds: {
          type: 'array',
          description:
            'Which kinds to wait for; all of them by default. A `session` event '
            + 'reaches you whatever you ask for.',
          items: { type: 'string', enum: [...CHANGE_KINDS] },
        },
        timeoutSec: {
          type: 'integer',
          description:
            `How long to wait before answering with no events (default ${DEFAULT_TIMEOUT_SEC}, `
            + `max ${MAX_TIMEOUT_SEC}). Zero answers at once with whatever has `
            + 'happened since the cursor.',
          minimum: 0,
          maximum: MAX_TIMEOUT_SEC,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    outputSchema: EVENTS_OUTPUT_SCHEMA,
    async run(args, { event }) {
      const kinds = readKinds(args.kinds)
      if ('fault' in kinds) return writeRefusal(kinds.fault)
      const cursor = args.cursor
      if (cursor !== undefined && (typeof cursor !== 'string' || !isCursorShaped(cursor))) {
        return writeRefusal('"cursor" must be one a previous answer returned.')
      }
      const seconds = args.timeoutSec === undefined ? DEFAULT_TIMEOUT_SEC : Number(args.timeoutSec)
      if (!Number.isFinite(seconds) || seconds < 0) {
        return writeRefusal('"timeoutSec" must be a number of seconds, zero to answer at once.')
      }
      // The seat this call holds on the session, given back however it ends.
      let release = () => {}

      try {
        const subject = await resolveWriteSubject(event, { path: args.path as string | undefined })
        const { session, keepAlive, remainingMs } = await joinWriteSession(event, subject)
        // A wait says nothing for minutes by design, and the idle window is
        // about a caller that has stopped talking — without this the agent
        // drops out of the presence strip while it is still watching.
        release = keepAlive()
        const watch = watchSession({
          documentName: session.documentName,
          doc: session.doc,
          // Counted off the document, not off this session: a watch outlives
          // the session that started it, and one that has left reports nobody.
          humanPeers: () => humanPeersOf(session.doc),
        })
        const reader = { clientId: session.clientId, uid: session.actor.uid, via: session.actor.via }
        // The conversation lives in the document; the log only says when
        // something happened. So every call asks the document what it still
        // owes an answer, and a first call (no cursor) is owed everything open.
        const owedNow = kinds.kinds.includes('comments')
          ? owed(readThreads(session.doc), reader, at => isAfterCursor(watch, cursor, at))
          : []
        if (owedNow.length > 0) {
          const standing = changesSince(watch, cursor, kinds.kinds, reader)
          return reportEvents(subject.name, withThreads(standing, owedNow))
        }
        const answer = await awaitChanges(
          watch,
          cursor,
          kinds.kinds,
          // Never past the session's own age cap: the seat goes with it, and
          // answering is what gets it back — the next call rejoins.
          Math.min(seconds * 1_000, MAX_TIMEOUT_SEC * 1_000, remainingMs),
          reader,
          { signal: abortOnDisconnect(event) },
        )
        // The wait is over. Whatever the log witnessed, the document is asked
        // again: a thread it carries and the answer does not is one the log
        // missed, and the caller is told about it rather than never.
        return reportEvents(subject.name, kinds.kinds.includes('comments')
          ? withThreads(answer, owed(readThreads(session.doc), reader, at => isAfterCursor(watch, cursor, at)))
          : answer)
      }
      catch (err) {
        return sessionRefusal(err)
      }
      finally {
        release()
      }
    },
  }
}

/**
 * The open threads whose last word is somebody else's, said since the caller's
 * cursor — what the caller still owes an answer. Everything open, for a caller
 * with no cursor and therefore joining.
 */
function owed(
  threads: CommentThread[],
  reader: { uid?: number | null, via?: string | null },
  isNew: (at: number) => boolean,
): CommentThread[] {
  return threads.filter((thread) => {
    if (thread.resolved) return false
    if (!isNew(thread.lastAt)) return false
    const last = thread.messages.at(-1)
    return !last || last.uid !== reader.uid || (last.via ?? null) !== (reader.via ?? null)
  })
}

/** The answer with threads the log did not carry folded in, oldest first. */
function withThreads(answer: ChangeAnswer, threads: CommentThread[]): ChangeAnswer {
  const carried = new Set(answer.events
    .filter((event): event is ChangeEvent & { kind: 'comments' } => event.kind === 'comments')
    .map(event => event.thread.threadId))
  const missing = threads
    .filter(thread => !carried.has(thread.threadId))
    .sort((a, b) => a.lastAt - b.lastAt)
    .map(thread => ({
      kind: 'comments' as const,
      thread,
      by: lastWriter(thread),
      at: thread.lastAt,
      cursor: answer.cursor,
    }))
  return missing.length === 0 ? answer : { ...answer, events: [...missing, ...answer.events] }
}

/** Who said the last word on a thread. */
function lastWriter(thread: CommentThread): EventPeer | null {
  const last = thread.messages.at(-1)
  return last ? { uid: last.uid, name: last.name ?? null, via: last.via ?? null } : null
}

/**
 * Aborts when the client goes away, so a dropped request does not leave its
 * waiter and its timer standing for the rest of the timeout.
 */
function abortOnDisconnect(event: H3Event): AbortSignal {
  const controller = new AbortController()
  event.node.res.on('close', () => controller.abort())
  return controller.signal
}

/** The kinds asked for, or the fault disqualifying the list. */
function readKinds(value: unknown): { kinds: ChangeKind[] } | { fault: string } {
  if (value === undefined) return { kinds: [...CHANGE_KINDS] }
  if (!Array.isArray(value)) return { fault: '"kinds" must be a list.' }
  const unknown = value.filter(kind => !CHANGE_KINDS.includes(kind as ChangeKind))
  if (unknown.length > 0) {
    return { fault: `"kinds" takes ${CHANGE_KINDS.join(', ')} — not ${unknown.join(', ')}.` }
  }
  return { kinds: value as ChangeKind[] }
}

/** Who an event is attributed to, where it is attributed at all. */
function byLine(by: EventPeer | null): string {
  return by?.name ? `, by ${actorLabel(by.name, by.via)}` : ''
}

/** One event as a line a model reads without parsing the structure. */
function eventLine(event: ChangeEvent): string {
  switch (event.kind) {
    case 'comments': {
      const to = event.thread.assignee
      // A resolve carries no message, so its line states the state instead of
      // reading the thread's last text — which would be the agent's own answer.
      return (event.thread.resolved
        ? `thread ${event.thread.threadId} on ${event.thread.blockId} resolved`
        : `comment on ${event.thread.blockId} (thread ${event.thread.threadId}): `
          + `${event.thread.messages.at(-1)?.text ?? ''}`)
        + byLine(event.by)
        + (to ? ` — assigned to ${actorLabel(to.name, to.via)}` : '')
    }
    case 'blocks':
      return event.event === 'removed'
        ? `${event.blockId} is gone from the page`
        : `${event.blockId} settled at ${event.version}${byLine(event.by)}`
    case 'presence':
      return `${event.who.name ?? 'someone'} ${event.event}`
        + `${event.blockId ? ` in ${event.blockId}` : ''}`
    case 'session':
      return `the session closed (${event.reason}) — stop waiting`
  }
}

/** The wait's answer: the events, projected, plus where to resume. */
function reportEvents(name: string, answer: ChangeAnswer): ToolResult {
  const { events, cursor, restarted, dropped, editors } = answer
  const projected = events.map((event) => {
    if (event.kind === 'comments') return { ...event, thread: projectThread(event.thread) }
    // A settled block's content is read by a model, so it is decoded like any
    // other read (ADR 0014).
    if (event.kind === 'blocks' && event.markdown !== null) {
      return { ...event, markdown: decodePageEntities(event.markdown) }
    }
    return event
  })
  const lines = events.map(eventLine)
  if (events.length === 0) {
    lines.push(`Nothing has happened on ${name}. Ask again with the cursor.`)
  }
  if (restarted) lines.unshift('The session restarted; re-read the page before acting on it.')
  if (dropped) lines.unshift('More happened than the log holds; re-read the page.')
  return answered(lines.join('\n'), { events: projected, cursor, restarted, dropped, editors })
}

/** Who an event is about. */
const PEER_SCHEMA: JsonSchema = {
  type: ['object', 'null'],
  properties: {
    uid: { type: ['integer', 'null'] },
    name: { type: ['string', 'null'] },
    via: {
      type: ['string', 'null'],
      description: 'The agent label — set exactly when the peer is an agent.',
    },
  },
  required: ['uid', 'name', 'via'],
  additionalProperties: false,
}

/** What a wait answers: one ordered story of what happened, however mixed. */
const EVENTS_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      description: 'What happened, oldest first. Empty means nothing happened in the time waited.',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['comments', 'blocks', 'presence', 'session'] },
          at: { type: 'integer', description: 'Wall-clock ms.' },
          cursor: { type: 'string', description: 'This event\'s own place in the log.' },
          thread: THREAD_SCHEMA,
          blockId: { type: ['string', 'null'] },
          version: {
            type: ['string', 'null'],
            description:
              'The settled block\'s version — send it as an updateBlocks `expect`. '
              + 'Null on a removed block.',
          },
          markdown: {
            type: ['string', 'null'],
            description: 'What the settled block now holds; null on a removed one.',
          },
          by: {
            ...PEER_SCHEMA,
            description:
              'Who changed the block or the thread, where this server saw it. '
              + 'Null on a block more than one person wrote in the same quiet '
              + 'window.',
          },
          event: {
            type: 'string',
            enum: ['settled', 'removed', 'joined', 'left', 'moved', 'closed'],
            description: 'What the block, presence or session event was.',
          },
          who: { ...PEER_SCHEMA, description: 'The peer a presence event is about.' },
          clientId: { type: 'integer' },
          reason: {
            type: 'string',
            enum: ['no-editors', 'unloaded'],
            description: 'Why the session ended: the last editor left, or it was closed.',
          },
        },
        required: ['kind', 'at', 'cursor'],
        additionalProperties: false,
      },
    },
    cursor: {
      type: 'string',
      description: 'Pass this to the next call to resume exactly here.',
    },
    restarted: {
      type: 'boolean',
      description:
        'The session was reloaded and your cursor named a log that is gone: '
        + 'what happened before this answer is lost, so re-read the page.',
    },
    dropped: {
      type: 'boolean',
      description:
        'More happened than the log holds and the oldest fell off it. Re-read '
        + 'the page rather than trusting the events you were handed.',
    },
    editors: {
      type: 'integer',
      description: 'People with the page open right now — 0 means nobody is there.',
    },
    ok: { type: 'boolean' },
    message: { type: 'string', description: 'Why the wait was refused.' },
  },
  additionalProperties: false,
}
