import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { appShortcuts, shortcutKeys } from './help-shortcuts'

/**
 * The help page lists what exists. `useAppShortcuts` is the one place the app's
 * own shortcuts are bound, and it is read here as text: a shortcut added or
 * dropped there fails this until the page's rows say the same.
 */
const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

/** The keys of the layout's `defineShortcuts` call, in the order bound. */
function boundShortcutIds(): string[] {
  const ts = source('../composables/useAppShortcuts.ts')
  const call = ts.match(/defineShortcuts\(\{([\s\S]*?)\n\s*\}[,)]/)
  expect(call, 'useAppShortcuts.ts still calls defineShortcuts with an object literal').not.toBeNull()
  return [...call![1]!.matchAll(/^\s+([A-Za-z0-9_]+):/gm)].map(match => match[1]!)
}

describe('the help page’s app shortcuts', () => {
  it('lists exactly the shortcuts useAppShortcuts binds', () => {
    expect(appShortcuts.map(row => row.id)).toEqual(boundShortcutIds())
  })

  it('says what each one does', () => {
    for (const row of appShortcuts) {
      expect(row.what.length, row.id).toBeGreaterThan(0)
    }
  })
})

describe('shortcutKeys', () => {
  it('renders the modifier by name and the letter as a key cap', () => {
    expect(shortcutKeys('meta_k')).toEqual(['meta', 'K'])
    expect(shortcutKeys('meta_shift_z')).toEqual(['meta', 'shift', 'Z'])
  })
})
