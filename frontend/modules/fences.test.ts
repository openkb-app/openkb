import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectFenceDirs } from './fences'

const roots: string[] = []

/** A layer root with the given fence directories and their files. */
function layer(fences: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmpdir(), 'okb-fences-'))
  roots.push(root)
  for (const [name, files] of Object.entries(fences)) {
    mkdirSync(join(root, 'fences', name), { recursive: true })
    for (const file of files) writeFileSync(join(root, 'fences', name, file), '')
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('collectFenceDirs', () => {
  it('collects every layer, and the first root wins on a shared name', () => {
    const app = layer({ mermaid: ['fence.ts', 'Fence.vue'] })
    const base = layer({ mermaid: ['fence.ts', 'Fence.vue', 'server.ts'], plantuml: ['fence.ts', 'Fence.vue'] })
    expect(collectFenceDirs([app, base], () => {})).toEqual([
      ['mermaid', join(app, 'fences', 'mermaid')],
      ['plantuml', join(base, 'fences', 'plantuml')],
    ])
  })

  it('skips, with a warning, a directory without fence.ts or Fence.vue', () => {
    const warnings: string[] = []
    const root = layer({ nofence: ['Fence.vue'], novue: ['fence.ts', 'server.ts'] })
    expect(collectFenceDirs([root], w => warnings.push(w))).toEqual([])
    expect(warnings).toEqual([
      `Skipping fence ${join(root, 'fences', 'nofence')}: it needs a fence.ts and a Fence.vue.`,
      `Skipping fence ${join(root, 'fences', 'novue')}: it needs a fence.ts and a Fence.vue.`,
    ])
  })

  it('skips, with a warning, a name that is not lowercase', () => {
    const warnings: string[] = []
    const root = layer({ PlantUML: ['fence.ts', 'Fence.vue'] })
    expect(collectFenceDirs([root], w => warnings.push(w))).toEqual([])
    expect(warnings).toEqual([`Skipping fence ${join(root, 'fences', 'PlantUML')}: the directory name must be lowercase.`])
  })

  it('passes over a root without a fences directory', () => {
    expect(collectFenceDirs([layer({})], () => {})).toEqual([])
  })
})
