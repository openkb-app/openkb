import type { CommentOp } from '../agent-peer'
import { TARGET_PROPERTIES, WRITE_OUTPUT_SCHEMA } from './schemas'
import { runWrite, writeRefusal } from './write'
import type { KbTool } from './types'

/**
 * Says something about a block, as the agent — a reply, or a new thread on the
 * block or on a passage of it — and resolves a thread the agent opened.
 *
 * Written through the session router like every other write, so it lands in
 * the document the human has open and is filed beside the page with the
 * next checkpoint (ADR 0006). Who may resolve which thread is the session's
 * rule (`applyComment`).
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
        quote: { type: 'string' },
        occurrence: { type: 'integer', minimum: 1 },
        resolve: { type: 'boolean' },
      },
      required: ['block'],
      additionalProperties: false,
    },
    outputSchema: WRITE_OUTPUT_SCHEMA,
    async run(args, { event }) {
      const { block, text, threadId, quote, occurrence, resolve } = args
      if (typeof block !== 'string' || block === '') {
        return writeRefusal('commentOnBlock requires a "block" string.')
      }
      if (text !== undefined && typeof text !== 'string') {
        return writeRefusal('"text" must be a string.')
      }
      if (resolve !== undefined && typeof resolve !== 'boolean') {
        return writeRefusal('"resolve" must be true or false.')
      }
      const said = typeof text === 'string' ? text.trim() : ''
      if (said === '' && resolve !== true) {
        return writeRefusal('commentOnBlock requires a non-empty "text" string.')
      }
      if (threadId !== undefined && typeof threadId !== 'string') {
        return writeRefusal('"threadId" must be the id of a thread on this block.')
      }
      if (resolve === true && threadId === undefined) {
        return writeRefusal('"resolve" needs the "threadId" of the thread to resolve.')
      }
      if (quote !== undefined && (typeof quote !== 'string' || quote.trim() === '')) {
        return writeRefusal('"quote" must be a non-empty string.')
      }
      if (occurrence !== undefined && (!Number.isInteger(occurrence) || (occurrence as number) < 1)) {
        return writeRefusal('"occurrence" must be an integer from 1.')
      }
      if (occurrence !== undefined && quote === undefined) {
        return writeRefusal('"occurrence" counts occurrences of "quote"; pass the quote too.')
      }
      const comment: CommentOp = { blockId: block }
      if (said) {
        comment.text = said
      }
      if (threadId) {
        comment.threadId = threadId
      }
      if (quote !== undefined) {
        comment.quote = quote
      }
      if (occurrence !== undefined) {
        comment.occurrence = occurrence as number
      }
      if (resolve === true) {
        comment.resolve = true
      }
      return runWrite(event, args, { comment })
    },
  }
}
