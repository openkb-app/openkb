import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BOARD_ACTIVE_CLASS, BOARD_CLASS } from '../../app/utils/block-board'

/**
 * The block board is one rule read by three surfaces — the editor's caret
 * block, the read page's open card, and the block a fragment just addressed
 * (main.css, `.okb-block-board`). Sharing the declaration is the whole point: a
 * second rule that merely matched would let the dash, the offset or the colour
 * drift apart on one surface, and nothing about that is visible from either
 * file on its own.
 *
 * So the sharing is what is pinned here, together with the class names the
 * code actually writes — split the rule in two and this fails, rename a class
 * in `block-board.ts` and the selector stops matching it.
 */

const CSS = fileURLToPath(new URL('../../app/assets/css/main.css', import.meta.url))
const COMPONENT = fileURLToPath(new URL('../../app/components/view/BlockMargin.vue', import.meta.url))

/** Every declaration block in the sheet, as `[selector, body]`. */
function rules(css: string): [string, string][] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => [m[1]!, m[2]!])
}

describe('the block board', () => {
  const css = readFileSync(CSS, 'utf8')
  const all = rules(css)

  it('is drawn by exactly one rule, and that rule serves every surface', () => {
    const drawn = all.filter(([, body]) => /outline:.*var\(--okb-board\)/.test(body))
    expect(drawn).toHaveLength(1)
    const [selector] = drawn[0]!
    expect(selector).toContain(`.${BOARD_CLASS}`)
    expect(selector).toContain('.inplace-editor .ProseMirror')
    expect(selector).toContain(':target')
  })

  /**
   * The editor's blocks carry the same ids, so a `#b-…` URL matches one of them
   * too. The rule that stands the board down there ties with the arrival rule
   * on specificity, which leaves source order deciding it.
   */
  it('is stood down in the editor by a rule that comes after the arrival', () => {
    const arrival = css.indexOf(".page-body [id^='b-']:target")
    const editor = css.indexOf(".inplace-editor [id^='b-']:target")
    expect(arrival).toBeGreaterThan(-1)
    expect(editor).toBeGreaterThan(arrival)
  })

  it('is painted by exactly one rule, and that rule serves both surfaces', () => {
    const painted = all.filter(([selector, body]) =>
      selector.includes(`.${BOARD_ACTIVE_CLASS}`) && body.includes('--okb-board:'))
    expect(painted).toHaveLength(1)
    const [selector] = painted[0]!
    expect(selector).toContain(`.${BOARD_CLASS}.${BOARD_ACTIVE_CLASS}`)
    expect(selector).toContain('.inplace-editor')
  })
})

describe('the read-page byline', () => {
  const css = readFileSync(CSS, 'utf8')

  /**
   * The byline is built as DOM, not as a component (see BlockMargin.vue), so
   * its class is a string literal and nothing connects it to the rule that
   * places it. Read it back out of the component rather than restating it.
   */
  it('has a rule for the class the component gives its trigger', () => {
    const component = readFileSync(COMPONENT, 'utf8')
    const className = /button\.className = '([\w-]+)'/.exec(component)?.[1]
    expect(className, 'BlockMargin.vue no longer assigns a literal className').toBeTruthy()
    expect(css).toContain(`.${className} {`)
  })
})

describe('the block link', () => {
  const css = readFileSync(CSS, 'utf8')

  /**
   * The ¶ is server-rendered (shared/utils/comark-tree.ts), so the class is a
   * literal on both sides. Where it has a margin to sit in it is hidden by
   * opacity, never by `display` or `visibility`: those take it out of the tab
   * order, and the keyboard is the one way to reach it that has no hover. It is
   * dropped outright at exactly one width — below the breakpoint, where it has
   * no margin and there is no hover to reveal it — so every rule that hides it
   * has to be read, not just the first.
   */
  it('is transparent where it is shown, and absent only below the breakpoint', () => {
    const hiding = rules(css)
      .filter(([selector]) => selector.trim().endsWith('.okb-block-link'))
      .filter(([, body]) => /opacity:\s*0|display:\s*none|visibility:\s*hidden/.test(body))
    expect(hiding).toHaveLength(2)
    const [transparent] = hiding
    expect(transparent![1]).toContain('opacity: 0')
    expect(transparent![1]).not.toMatch(/display:\s*none|visibility:\s*hidden/)
    // `rules` drops the at-rule prelude, so the one that removes it is read off
    // the sheet — the width it is confined to is the whole point.
    expect(css.replace(/\/\*[\s\S]*?\*\//g, ''))
      .toMatch(/@media \(max-width: 767px\) \{\s*\.okb-block-link \{[^}]*display:\s*none/)
  })
})
