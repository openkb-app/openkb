/**
 * Block-ID corpus for OKB-42: `{#b-…}` block attributes survive the
 * editor round-trip — read by comark as the block's id, carried as
 * `attrs.id` (app/comark/pm-mapper.ts) and written back for top-level blocks.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe } from 'vitest'
import { runCorpus } from './corpus'
import { productionImpl } from './harness'

describe('block-id corpus', () => {
  runCorpus(productionImpl, join(dirname(fileURLToPath(import.meta.url)), 'fixtures-block-ids'))
})
