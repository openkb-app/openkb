import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test, vi } from 'vitest'

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const css = source('./main.css')

/** Every root a utility is meant to reach, so a host cannot lose it silently. */
const HOSTS: Record<string, string[]> = {
  'okb-prose': [
    '../../components/global/NodeKbPage.vue',
    '../../components/chat/ChatPanel.vue',
    '../../pages/search.vue',
  ],
  'okb-prose-compact': [
    '../../components/global/CustomCallout.vue',
    '../../components/global/CustomInfobox.vue',
    '../../components/CalloutNodeView.vue',
    '../../components/InfoboxNodeView.vue',
    '../../components/ComarkAnswer.vue',
  ],
}

/** The classes an `@utility` block applies, comments dropped. */
function utility(name: string) {
  const body = css.match(new RegExp(`@utility ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1]
  expect(body, `@utility ${name} in main.css`).toBeTruthy()
  return [...body!.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/@apply ([^;]+);/g)]
    .flatMap(match => match[1]!.trim().split(/\s+/))
}

/**
 * The element names a `[&_…]` class selects on — pseudo-classes and `:is()`
 * dropped, so only tags are left. A `*:` variant names none and returns `[]`:
 * it selects direct children, and no element is a direct child of both roots.
 */
function elementsOf(cls: string) {
  const selector = cls.match(/^\[&_(.+?)\]:/)?.[1]
  if (!selector) return []
  return selector.replace(/:is\(|\)/g, '').replace(/:[a-z-]+/g, '').split(/[\s>,+~_]+/).filter(Boolean)
}

/** Nuxt UI's own element list for an editable root, as generated for this app. */
function editorThemeBase() {
  const base = source('../../../.nuxt/ui/editor.ts').match(/"base": \[([\s\S]*?)\n {4}\]/)?.[1]
  expect(base, 'slots.base in .nuxt/ui/editor.ts').toBeTruthy()
  return [...base!.matchAll(/"([^"]+)"/g)].flatMap(match => match[1]!.trim().split(/\s+/))
}

/**
 * A class split into everything it selects on and the utility it applies —
 * `[&_ul]:marker:text-…` selects on `[&_ul]:marker:` and applies `text-…`.
 */
function variantAndBase(cls: string): [string, string] {
  const end = cls.lastIndexOf(']:')
  const head = end < 0 ? 0 : end + 2
  const variant = cls.slice(0, head) + (cls.slice(head).match(/^(?:[\w*-]+:)+/)?.[0] ?? '')
  return [variant, cls.slice(variant.length)]
}

/** Values that name a property their prefix alone leaves open. */
const FONT_SIZE = /^(xs|sm|base|lg|xl|\d+xl|\[.+\])(\/.+)?$/
const TEXT_ALIGN = /^(left|center|right|justify|start|end)$/
const FONT_FAMILY = /^(sans|serif|mono|inherit|\[.+\])$/
const BORDER_STYLE = /^(solid|dashed|dotted|double|hidden|none)$/
const DISPLAY = /^(block|inline|inline-block|flex|inline-flex|grid|inline-grid|table|table-cell|table-row|contents|flow-root|hidden)$/

/** `border-` writes a width per side, a style, a colour or the table model. */
function borderProperty(arg: string) {
  if (BORDER_STYLE.test(arg)) return 'border-style'
  if (arg === 'separate' || arg === 'collapse') return 'border-collapse'
  if (arg.startsWith('spacing')) return 'border-spacing'
  const [, side, value] = arg.match(/^([xytrbles])(?:-(.+))?$/) ?? []
  if (side) return value && !/^\d/.test(value) ? `border-color-${side}` : `border-width-${side}`
  return arg === '' || /^\d/.test(arg) ? 'border-width' : 'border-color'
}

/**
 * The property a utility writes, so two classes that set the same one on the
 * same elements share a bucket and can be compared. The prefix alone does not
 * name it: `text-` writes a size, an alignment or a colour.
 */
function propertyOf(base: string) {
  const value = base.replace(/!$/, '')
  const [prefix, ...rest] = value.split('-')
  const arg = rest.join('-')
  if (DISPLAY.test(value)) return 'display'
  if (prefix === 'text') return FONT_SIZE.test(arg) ? 'font-size' : TEXT_ALIGN.test(arg) ? 'text-align' : 'color'
  if (prefix === 'font') return FONT_FAMILY.test(arg) ? 'font-family' : 'font-weight'
  if (prefix === 'border') return borderProperty(arg)
  return prefix!
}

/** `app.config.ts` calls Nuxt's auto-imported `defineAppConfig`. */
async function appConfig() {
  vi.stubGlobal('defineAppConfig', (config: unknown) => config)
  return (await import('../../app.config')).default as {
    ui: { editor: { slots: { base: string } } }
  }
}

describe('page typography', () => {
  test('the editor and the read view take it from the same utility', async () => {
    const { ui } = await appConfig()
    expect(ui.editor.slots.base.split(' ')).toContain('okb-prose')
  })

  test('every surface the utilities theme still carries one', () => {
    for (const [name, files] of Object.entries(HOSTS)) {
      const binding = new RegExp(`class="[^"]*\\b${name}(?![-\\w])[^"]*"`)
      for (const file of files) expect(source(file), `${name} on ${file}`).toMatch(binding)
    }
  })

  test('a box out-ranks the column on every element they both name', () => {
    const column = new Set(utility('okb-prose').flatMap(elementsOf))
    for (const cls of utility('okb-prose-compact')) {
      if (!elementsOf(cls).some(el => column.has(el))) continue
      expect(cls, `${cls} names an element okb-prose also names`).toMatch(/!$/)
    }
  })

  test('the column wins every element the editor theme states differently', () => {
    // Nuxt UI's list reaches the editor root as its own classes, at equal
    // specificity and later source order, so where the two disagree on an
    // element ours has to be important. A value of theirs that is not ours
    // wins even when another of their values matches, so every one counts.
    const theirs = new Map<string, Set<string>>()
    for (const cls of editorThemeBase()) {
      const [variant, base] = variantAndBase(cls)
      const key = `${variant}|${propertyOf(base)}`
      theirs.set(key, (theirs.get(key) ?? new Set()).add(base))
    }
    const conflicts: Array<{ ours: string, theirs: string[] }> = []
    for (const cls of utility('okb-prose')) {
      const [variant, base] = variantAndBase(cls)
      const stated = theirs.get(`${variant}|${propertyOf(base)}`) ?? new Set()
      const differing = [...stated].filter(one => one !== base.replace(/!$/, ''))
      if (differing.length) conflicts.push({ ours: cls, theirs: differing.map(one => variant + one) })
    }
    // Exact, so a comparison that stopped matching cannot pass empty and a
    // disagreement that arrives has to be read before it is accepted.
    expect(conflicts.map(c => c.ours).sort()).toEqual([
      '[&_img]:rounded-(--okb-radius)!',
      '[&_p]:leading-[inherit]!',
    ])
    for (const { ours, theirs: stated } of conflicts) {
      expect(ours, `${ours} restates ${stated.join(' ')}`).toMatch(/!$/)
    }
  })

  test('a box stays flush with its edges even when a heading opens it', () => {
    // The heading classes above are important, so the resets must be too —
    // otherwise importance, not specificity, decides the box's first block.
    const box = utility('okb-prose-compact')
    for (const cls of ['*:first:mt-0!', '*:last:mb-0!']) expect(box).toContain(cls)
  })
})
