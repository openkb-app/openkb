import { describe, it, expect } from 'vitest'
import { globSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * What the browser pays for diagrams. Pele (~246 KB gz with every type) loads
 * only on a page with a diagram: the mermaid fence's `Fence.vue` reaches it
 * through one dynamic `pele/lazy` import, which loads one chunk per diagram
 * type. Its `server.ts` runs in Nitro only (modules/fences.ts).
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

const PELE_MODULE = /['"]pele(?:\/[^'"]*)?['"]/

function clientSources(): string[] {
  return globSync(['app/**/*.{ts,vue}', 'shared/**/*.ts', 'fences/**/*.{ts,vue}'], { cwd: ROOT })
    .filter(p => !p.endsWith('.test.ts') && !p.endsWith('/server.ts'))
    .sort()
}

function read(file: string): string {
  return readFileSync(`${ROOT}/${file}`, 'utf8')
}

describe('the pele client bundle', () => {
  it('names pele in the mermaid fence component and nowhere else', () => {
    const importers = clientSources().filter(file => PELE_MODULE.test(read(file)))
    expect(importers).toEqual(['fences/mermaid/Fence.vue'])
  })

  it('reaches pele only through a dynamic pele/lazy import, and as types', () => {
    const source = read('fences/mermaid/Fence.vue')
    expect(source).toMatch(/await import\('pele\/lazy'\)/)
    const statics = [...source.matchAll(/^import\s+(type\s+)?[^'"]*from\s+['"]pele(?:\/[^'"]*)?['"]/gm)]
    expect(statics.length).toBeGreaterThan(0)
    expect(statics.every(m => m[1])).toBe(true)
  })
})
