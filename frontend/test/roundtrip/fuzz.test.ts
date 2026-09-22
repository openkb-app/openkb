/**
 * Fuzz layer: seeded formatting mutations over the corpus, asserting
 *   S2 — serialize∘load is idempotent after one pass, and
 *   S3 — the mutated input and its first-pass output parse to the same
 *        normalized comark AST (no silent content loss).
 *
 * Mutations only touch representation (markers, fence lengths, blank
 * lines, trailing spaces) — never content — and skip lines inside
 * backtick code fences so code blocks stay byte-identical. Lossy
 * fixtures (see corpus.ts) are excluded: their first pass intentionally
 * drops content the AST comparison would flag.
 *
 * The run is deterministic: a fixed seed feeds a mulberry32 PRNG, and
 * every case name carries the fixture + variant so failures reproduce.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { normalizedAst } from './ast'
import { loadCorpus } from './corpus'
import { productionImpl, roundTrip } from './harness'

const SEED = 20260707

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Applies `fn` to every line outside backtick code fences. */
function mapProseLines(md: string, fn: (line: string) => string): string {
  let fence: number | null = null
  return md.split('\n').map((line) => {
    const open = /^\s*(`{3,})/.exec(line)
    if (open) {
      if (fence === null) {
        fence = open[1]!.length
        return line
      }
      if (open[1]!.length >= fence) {
        fence = null
        return line
      }
    }
    return fence === null ? fn(line) : line
  }).join('\n')
}

type Mutation = { name: string, apply: (md: string) => string }

const MUTATIONS: Mutation[] = [
  {
    name: 'strong-underscores',
    apply: md => mapProseLines(md, l => l.replace(/\*\*/g, '__')),
  },
  {
    name: 'bullet-stars',
    apply: md => mapProseLines(md, l => l.replace(/^(\s*)- /, '$1* ')),
  },
  {
    name: 'ordered-paren',
    apply: md => mapProseLines(md, l => l.replace(/^(\s*\d+)\. /, '$1) ')),
  },
  {
    name: 'trailing-space',
    apply: md => mapProseLines(md, l => (l.trim() === '' ? l : l + ' ')),
  },
  {
    name: 'extra-blank-lines',
    // Skipped for docs with code fences — a doubled blank line inside a
    // code block would change its content.
    apply: md => md.includes('```') ? md : md.replace(/\n\n/g, '\n\n\n'),
  },
  {
    name: 'fence-colons-plus-one',
    apply: md => mapProseLines(md, l => l.replace(/^(\s*)(:{2,})/, '$1:$2')),
  },
  {
    name: 'backtick-fence-plus-one',
    apply: (md) => {
      // Lengthen every fence line consistently (opener and closer).
      let fence: number | null = null
      return md.split('\n').map((line) => {
        const open = /^(\s*)(`{3,})(.*)$/.exec(line)
        if (!open) return line
        if (fence === null) fence = open[2]!.length
        else if (open[2]!.length >= fence) fence = null
        else return line
        return open[1]! + '`' + open[2]! + open[3]!
      }).join('\n')
    },
  },
]

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const cases = loadCorpus(fixturesDir).filter(c => !c.lossyReason)

const rng = mulberry32(SEED)
const VARIANTS_PER_FIXTURE = 3

interface FuzzCase { name: string, input: string }
const fuzzCases: FuzzCase[] = []
for (const c of cases) {
  for (let v = 0; v < VARIANTS_PER_FIXTURE; v++) {
    // 1–3 distinct mutations per variant, order fixed by MUTATIONS index.
    const count = 1 + Math.floor(rng() * 3)
    const picks = new Set<number>()
    while (picks.size < count) picks.add(Math.floor(rng() * MUTATIONS.length))
    const chosen = [...picks].sort((a, b) => a - b).map(i => MUTATIONS[i]!)
    let mutated = c.input
    for (const m of chosen) mutated = m.apply(mutated)
    fuzzCases.push({
      name: `${c.name} #${v} [${chosen.map(m => m.name).join('+')}]`,
      input: mutated,
    })
  }
}

describe(`fuzz: S2 + S3 over ${fuzzCases.length} mutated docs (seed ${SEED})`, () => {
  test.each(fuzzCases)('$name', async ({ input }) => {
    const once = await roundTrip(productionImpl, input)
    const twice = await roundTrip(productionImpl, once)
    expect(twice, 'S2: second pass must be byte-identical to the first').toBe(once)
    expect(
      await normalizedAst(once),
      'S3: round-trip output must parse to the same normalized AST as the mutated input',
    ).toEqual(await normalizedAst(input))
  })
})
