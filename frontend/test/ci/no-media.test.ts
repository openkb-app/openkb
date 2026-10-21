import { describe, it, expect } from 'vitest'
import { globSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * OpenKB has no media entities (ADR 0020): an image is a page file. Nothing
 * may still ask for a media resolve or read an image's `media` attribute, so
 * a leftover never silently renders nothing.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

const FORBIDDEN: [string, RegExp][] = [
  ['the media resolve route', /\/api\/media\/resolve/],
  ['an image media attribute', /:image\{[^}\n]*\bmedia=/],
  ['a media node attribute', /\battrs\.media\b|\bmedia:\s*\{\s*default\b/],
  ['a media JSON:API resource', /jsonapi\/media\/|media--/],
]

describe('no media', () => {
  const sources = globSync(['app/**/*.{vue,ts}', 'shared/**/*.ts', 'server/**/*.ts', 'test/roundtrip/**/*.md'], { cwd: ROOT })
    .filter(file => !file.endsWith('no-media.test.ts'))

  it.each(FORBIDDEN)('nothing names %s', (_, pattern) => {
    expect(sources.filter(file => pattern.test(readFileSync(`${ROOT}/${file}`, 'utf8')))).toEqual([])
  })
})
