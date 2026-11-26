import { globSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

/**
 * The public repository has only frontend/ of this tree: a relative path that
 * leaves frontend/ — an import, a file read — is green here and red there.
 *
 * Exempt: test/project-tree/, the tests of the internal tree, which the public
 * repository does not carry (scripts/publish/split.sh).
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** A quoted relative path up to its end or to a `${` interpolation. */
const RELATIVE_PATH = /['"`](\.\.\/[^'"`$\n]*)/g

/** Each relative path in a source file that resolves outside frontend/. */
function pathsLeavingFrontend(file: string): string[] {
  const source = readFileSync(join(ROOT, file), 'utf8')
  const directory = dirname(join(ROOT, file))
  return [...source.matchAll(RELATIVE_PATH)]
    .map(match => match[1]!)
    .filter(path => relative(ROOT, resolve(directory, path)).startsWith('..'))
}

describe('paths in frontend/', () => {
  const sources = globSync('**/*.{ts,mts,js,mjs,vue}', {
    cwd: ROOT,
    exclude: ['node_modules/**', '.nuxt/**', '.output/**', 'test/.generated/**', 'test/project-tree/**'],
  })

  it('finds the sources', () => {
    expect(sources.length).toBeGreaterThan(100)
  })

  it('stay inside frontend/', () => {
    const leaving = sources.flatMap(file => pathsLeavingFrontend(file).map(path => `${file}: ${path}`))
    expect(leaving).toEqual([])
  })
})
