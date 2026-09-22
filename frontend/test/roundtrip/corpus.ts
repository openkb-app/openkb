/**
 * Fixture-corpus runner. Layout per fixture (see README.md):
 *
 *   fixtures/<name>/input.md      — required, the authored markdown
 *   fixtures/<name>/expected.md   — optional; present only when an
 *                                   accepted normalization changes bytes
 *   fixtures/<name>/lossy.txt     — optional; one-line reason when the
 *                                   accepted transform loses content the
 *                                   AST normalizer cannot bridge. S3 then
 *                                   compares output vs expected instead
 *                                   of output vs input.
 *
 * Assertions per fixture:
 *   bytes: save(load(input)) === expected ?? input   (S1 when no expected.md)
 *   S2:    a second pass over the output is byte-identical (convergence)
 *   S3:    normalizedAst(output) equals normalizedAst(input)  (or expected
 *          for lossy fixtures)
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { RoundTripImpl } from './harness'
import { roundTrip } from './harness'
import { normalizedAst } from './ast'

export interface CorpusCase {
  name: string
  input: string
  expected?: string
  lossyReason?: string
}

export function loadCorpus(dir: string): CorpusCase[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map((entry) => {
      const base = join(dir, entry.name)
      const expectedPath = join(base, 'expected.md')
      const lossyPath = join(base, 'lossy.txt')
      // Fixture files end with a POSIX trailing newline; the serializer
      // never emits one, so the corpus compares without it.
      const md = (p: string) => readFileSync(p, 'utf8').replace(/\n$/, '')
      return {
        name: entry.name,
        input: md(join(base, 'input.md')),
        expected: existsSync(expectedPath) ? md(expectedPath) : undefined,
        lossyReason: existsSync(lossyPath) ? readFileSync(lossyPath, 'utf8').trim() : undefined,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Registers one `describe` block per corpus over the given implementation.
 * The A/B entry point for OKB-7: run it once with `productionImpl` and
 * once with a candidate implementation.
 */
export function runCorpus(impl: RoundTripImpl, fixturesDir: string): void {
  const cases = loadCorpus(fixturesDir)

  describe(`round-trip corpus [${impl.name}]`, () => {
    for (const c of cases) {
      test(c.name, async () => {
        const target = c.expected ?? c.input
        const output = await roundTrip(impl, c.input)
        expect(output, 'bytes: serialize(load(input))').toBe(target)

        const second = await roundTrip(impl, output)
        expect(second, 'S2: second pass must be byte-identical').toBe(output)

        const reference = c.lossyReason ? target : c.input
        expect(
          await normalizedAst(output),
          `S3: semantic AST${c.lossyReason ? ` (lossy fixture: ${c.lossyReason})` : ''}`,
        ).toEqual(await normalizedAst(reference))
      })
    }
  })
}
