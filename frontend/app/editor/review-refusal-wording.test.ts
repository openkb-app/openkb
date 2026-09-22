import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

/**
 * The refusal sentence is Drupal's, and the editor keeps its own copy so the
 * control can say no before the reviewer clicks. Both are read as text here,
 * because a test that imported one of them could only ever pin that one. The
 * subject each side puts in front of the sentence is its own.
 */
const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

/** What each side says, minus the subject each puts in front of it. */
const SENTENCES = [
  'needs a second pair of eyes: its only contributor is the account approving it.',
  'needs an identified edit before anybody can sign it off: nothing on record says who wrote it.',
]

describe('the sign-off refusal', () => {
  it('reads the same in the editor as in PageBlocks::refusalReason()', () => {
    const php = source('../../../openkb/openkb_workflow/src/PageBlocks.php')
    const ts = source('./review-marks.ts')
    for (const sentence of SENTENCES) {
      expect(php, sentence).toContain(sentence)
      expect(ts, sentence).toContain(sentence)
    }
  })
})
