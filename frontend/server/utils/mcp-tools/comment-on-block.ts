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
    manifestName: 'comment_on_block',
    inputSchema: {
      type: 'object',
      properties: {
        ...TARGET_PROPERTIES,
        block: { type: 'string' },
        threadId: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['block', 'text'],
      additionalProperties: false,
    },
    outputSchema: WRITE_OUTPUT_SCHEMA,
    async run(args, { event }) {
      const { block, text, threadId } = args
      if (typeof block !== 'string' || block === '') {
        return writeRefusal('commentOnBlock requires a "block" string.')
      }
      if (typeof text !== 'string' || text.trim() === '') {
        return writeRefusal('commentOnBlock requires a non-empty "text" string.')
      }
      if (threadId !== undefined && typeof threadId !== 'string') {
        return writeRefusal('"threadId" must be the id of a thread on this block.')
      }
      return runWrite(event, args, {
        comment: { blockId: block, text: text.trim(), ...(threadId ? { threadId } : {}) },
      })
    },
  }
}
