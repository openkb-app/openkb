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
    description:
      "Edit a knowledge-base page's DRAFT block by block. Each op names the block "
      + 'it acts on by its `{#b-…}` id, which every read carries in the markdown: '
      + 'pass `id` to replace that block, or `after`/`before` to insert beside '
      + 'it. Its version is another matter — only getPageForEditing answers those, '
      + 'and `expect` takes one. An op '
      + 'naming no block lands after the one the op before it wrote, so several '
      + 'new blocks in a row need only the first anchor — and on a page that '
      + 'holds no blocks yet, the first op needs none either: it fills the '
      + 'empty page. Blocks you '
      + 'do not name are not touched, which is the point — a whole-document write '
      + 'would re-open every block for review and fight the human editing beside '
      + 'you. The edit lands in the page\'s collaborative session, so a human with '
      + 'it open sees it arrive live. It does not publish — read it back with '
      + 'getPageForEditing.\n\n'
      + 'ALWAYS send `expect` on every op: it is the block version '
      + 'getPageForEditing reported, and it is what stops you overwriting an edit '
      + 'somebody made while you were working. If a block moved, the whole call is refused and '
      + 'the result carries `conflicts` — one entry per refused op, with that '
      + 'block\'s current `markdown` and `version`. Re-apply your change to that '
      + 'markdown and call again with that version as `expect`; no second read is '
      + 'needed, which is what makes writing optimistically the cheap path.\n\n'
      + 'A successful call answers `applied.blocks` as block id → the version '
      + 'that block holds now, for everything it wrote — including the id minted '
      + 'for a block you inserted. So a follow-up edit to a block you just '
      + 'replaced OR just inserted sends that version as its `expect`, without '
      + 'reading the page again.',
    inputSchema: {
      type: 'object',
      properties: {
        ...TARGET_PROPERTIES,
        blocks: {
          type: 'array',
          description: 'The block writes, applied in order.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Replace the block carrying this id.' },
              after: { type: 'string', description: 'Insert after the block carrying this id.' },
              before: { type: 'string', description: 'Insert before the block carrying this id.' },
              // No anchor at all: chains after the previous op. The first op in
              // a list must name a block, unless the page holds none.
              markdown: {
                type: 'string',
                description: 'The comark markdown to write. Write comark markdown only: raw HTML is not part of the format and is not preserved; use `::callout`, `::infobox`, `::image` and `:doc` for anything beyond CommonMark.',
              },
              expect: {
                type: 'string',
                description:
                  "The named block's version from getPageForEditing's `versions` "
                  + 'map. Always send it. The op is refused if the block changed '
                  + 'since — and the refusal carries what it holds now. An op naming no block '
                  + 'has none to expect a version for, so it must be left off there.',
              },
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
