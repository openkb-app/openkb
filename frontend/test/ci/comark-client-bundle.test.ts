import { describe, it, expect } from 'vitest'
import { globSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * What the browser pays for comark. The parser (~250 KB) is a chat cost: a read
 * page is handed the tree the server built, so it stays out of every static chunk
 * only while its one import is dynamic. `@comark/vue`'s `Markdown` parses, and so
 * carries the parser; `MarkdownDocument` renders an already-parsed tree.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Every comark package and subpath, so a `comark/parse` import cannot slip by. */
const COMARK_MODULE = /['"](comark(?:\/[^'"]*)?|@comark\/html)['"]/

function clientSources(): string[] {
  return globSync(['app/**/*.{ts,vue}', 'shared/**/*.ts'], { cwd: ROOT })
    .filter(p => !p.endsWith('.test.ts'))
    .sort()
}

function read(file: string): string {
  return readFileSync(`${ROOT}/${file}`, 'utf8')
}

describe('the comark client bundle', () => {
  it('names comark in the one shared tree module and nowhere else', () => {
    const importers = clientSources().filter(file => COMARK_MODULE.test(read(file)))
    expect(importers).toEqual(['shared/utils/comark-tree.ts'])
  })

  it('reaches the parser only through a dynamic import, and pulls no renderer with it', () => {
    const source = read('shared/utils/comark-tree.ts')
    const named = [...source.matchAll(new RegExp(COMARK_MODULE, 'g'))].map(m => m[0])
    expect(named).toEqual(["'comark'"])
    expect(source).toMatch(/await import\('comark'\)/)
    expect(source).not.toMatch(/from 'comark'/)
  })

  it('reaches @comark/vue only as a named MarkdownDocument import', () => {
    const other = clientSources().filter((file) => {
      const source = read(file)
      const mentions = source.split(/['"]@comark\/vue['"]/).length - 1
      const named = [...source.matchAll(/import\s*\{\s*MarkdownDocument\s*\}\s*from\s*['"]@comark\/vue['"]/g)]
      return mentions !== named.length
    })
    expect(other).toEqual([])
  })
})
