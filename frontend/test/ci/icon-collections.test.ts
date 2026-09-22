import { describe, it, expect } from 'vitest'
import { globSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Icons come out of @nuxt/icon's server bundle, which holds exactly the
 * `@iconify-json/*` collections package.json installs (`fallbackToApi: false`
 * in nuxt.config.ts). A name from any other collection renders nothing and
 * logs — so the names the app writes and the collections it installs are one
 * fact, pinned here.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, 'utf8')) as Record<string, Record<string, string>>

const installed = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
  .filter(name => name.startsWith('@iconify-json/'))
  .map(name => name.slice('@iconify-json/'.length))

/** Both spellings: Nuxt UI's `i-<collection>-<icon>` and Iconify's `<collection>:<icon>`. */
function iconNames(source: string): string[] {
  return [
    ...[...source.matchAll(/['"`]i-([a-z0-9][a-z0-9-]*)['"`]/g)].map(m => m[1]!),
    ...[...source.matchAll(/\b(?:name|icon)\s*[:=]\s*['"`]([a-z0-9-]+:[a-z0-9-]+)['"`]/g)].map(m => m[1]!),
  ]
}

/** The collection an icon name belongs to, `undefined` if none installed does. */
function collectionOf(name: string): string | undefined {
  const [prefix] = name.split(':')
  if (prefix !== name) return installed.find(collection => collection === prefix)
  return installed.find(collection => name.startsWith(`${collection}-`))
}

describe('icon collections', () => {
  const sources = globSync(['app/**/*.{vue,ts}', 'shared/**/*.ts', 'server/**/*.ts'], { cwd: ROOT })
    .filter(file => !file.endsWith('.test.ts'))

  it('installs a collection for every icon name the app writes', () => {
    const unresolved = new Set<string>()
    for (const file of sources) {
      for (const name of iconNames(readFileSync(`${ROOT}/${file}`, 'utf8'))) {
        if (!collectionOf(name)) unresolved.add(name)
      }
    }
    expect([...unresolved].sort(), `install @iconify-json/<collection> for these`).toEqual([])
  })

  it('names icons from the collections it installs', () => {
    const used = new Set(sources.flatMap(file => iconNames(readFileSync(`${ROOT}/${file}`, 'utf8'))).map(collectionOf))
    expect(installed.filter(collection => !used.has(collection)), 'installed but unused').toEqual([])
  })
})
