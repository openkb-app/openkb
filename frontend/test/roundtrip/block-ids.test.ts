/**
 * Block-ID corpus for OKB-42: `{#b-…}` block attributes survive the
 * editor round-trip — on native blocks (heading, paragraph, blockquote,
 * list item) as literal trailing text, on component fences via the `#id`
 * prop shorthand (see app/editor/nodes/mdc-markdown.ts).
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe } from 'vitest'
import { runCorpus } from './corpus'
import { productionImpl } from './harness'

describe('block-id corpus', () => {
  runCorpus(productionImpl, join(dirname(fileURLToPath(import.meta.url)), 'fixtures-block-ids'))
})
