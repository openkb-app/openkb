import { TARGET_PROPERTIES, WRITE_OUTPUT_SCHEMA } from './schemas'
import { runWrite, writeRefusal } from './write'
import type { KbTool } from './types'

/**
 * Says something about a block, as the agent — a reply, or a new thread.
 *
 * Written through the session router like every other write, so it lands in
 * the document the human has open and is filed beside the page with the
 * next checkpoint (ADR 0006). Resolving is not offered: an agent that could
 * close the threads about its own work would be reviewing itself.
 */
export function commentOnBlockTool(): KbTool {
  return {
    name: 'commentOnBlock',
    description:
      'Say something about one block of a knowledge-base page — a reply to an '
      + 'open thread (pass its `threadId`), or a new thread on the block (leave '
      + '`threadId` off). Threads and their ids come from getPageForEditing\'s '
      + '`comments` and from waitForChanges. The message is written as YOU — the '
      + 'account behind your token, carrying your agent label, the way your '
      + 'edits are — into the page\'s collaborative session, so a human with the '
      + 'page open sees it appear in their review drawer at once.\n\n'
      + 'Answer the thread you were asked about rather than opening a second one '
      + 'beside it; a new thread is for something nobody has raised yet. You '
      + 'cannot mark a thread resolved and there is no tool that can: the editor '
      + 'who asked decides when their point is settled. Say what you changed and '
      + 'leave the thread open.',
    inputSchema: {
      type: 'object',
      properties: {
        ...TARGET_PROPERTIES,
        blockId: {
          type: 'string',
          description:
            'The block to comment on, by the `{#b-…}` id every read of the page '
            + 'carries. It must be a block the page still holds.',
        },
        threadId: {
          type: 'string',
          description:
            'The thread to answer, from `comments`. Leave it off to open a new '
            + 'thread on the block.',
        },
        text: { type: 'string', description: 'What to say.' },
      },
      required: ['blockId', 'text'],
      additionalProperties: false,
    },
    outputSchema: WRITE_OUTPUT_SCHEMA,
    async run(args, { event }) {
      const { blockId, text, threadId } = args
      if (typeof blockId !== 'string' || blockId === '') {
        return writeRefusal('commentOnBlock requires a "blockId" string.')
      }
      if (typeof text !== 'string' || text.trim() === '') {
        return writeRefusal('commentOnBlock requires a non-empty "text" string.')
      }
      if (threadId !== undefined && typeof threadId !== 'string') {
        return writeRefusal('"threadId" must be the id of a thread on this block.')
      }
      return runWrite(event, args, {
        comment: { blockId, text: text.trim(), ...(threadId ? { threadId } : {}) },
      })
    },
  }
}
