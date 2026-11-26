import { readBlockOpList } from '../agent-peer'
import { TARGET_PROPERTIES, WRITE_OUTPUT_SCHEMA } from './schemas'
import { runWrite, writeRefusal } from './write'
import type { KbTool } from './types'

/**
 * Writes prose block by block, into the page's live editing session.
 *
 * Each op names its block by the `{#b-…}` id every read carries and its
 * version by `expect`, so a write refused for staleness comes back with what
 * the retry needs (`server/utils/agent-peer.ts`).
 */
export function updateBlocksTool(): KbTool {
  return {
    name: 'updateBlocks',
    manifestName: 'update_blocks',
    inputSchema: {
      type: 'object',
      properties: {
        ...TARGET_PROPERTIES,
        blocks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              after: { type: 'string' },
              before: { type: 'string' },
              // No anchor at all: chains after the previous op. The first op in
              // a list must name a block, unless the page holds none.
              markdown: { type: 'string' },
              expect: { type: 'string' },
            },
            required: ['markdown'],
            additionalProperties: false,
          },
        },
      },
      required: ['blocks'],
      additionalProperties: false,
    },
    outputSchema: WRITE_OUTPUT_SCHEMA,
    async run(args, { event }) {
      const read = readBlockOpList(args.blocks)
      if ('fault' in read) return writeRefusal(read.fault)
      return runWrite(event, args, { blocks: read.ops })
    },
  }
}
