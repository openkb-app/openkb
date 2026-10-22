import { describe, it, expect } from 'vitest'
import { globSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** PhotoSwipe loads on the first interaction with an image, never in a static chunk. */

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

const PHOTOSWIPE = /['"]photoswipe(?:\/[^'"]*)?['"]/g

function clientSources(): string[] {
  return globSync(['app/**/*.{ts,vue}', 'shared/**/*.ts'], { cwd: ROOT })
    .filter(p => !p.endsWith('.test.ts'))
    .sort()
}

function read(file: string): string {
  return readFileSync(`${ROOT}/${file}`, 'utf8')
}

describe('the PhotoSwipe client bundle', () => {
  it('names photoswipe in the lightbox module only, through dynamic imports', () => {
    expect(clientSources().filter(file => read(file).match(PHOTOSWIPE))).toEqual(['app/utils/image-lightbox.ts'])
    const source = read('app/utils/image-lightbox.ts')
    expect(source).not.toMatch(/from 'photoswipe/)
    expect(source).toMatch(/(?:await |\[)import\('photoswipe'\)/)
  })
})
