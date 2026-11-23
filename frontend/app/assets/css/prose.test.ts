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
  'okb-prose-box': [
    '../../components/comark/Callout.vue',
    '../../components/comark/Infobox.vue',
    '../../components/comark/Details.vue',
    '../../components/comark/Details.editor.vue',
    '../../components/ComponentNodeView.vue',
  ],
  'okb-prose-compact': [
    '../../components/AnswerMarkdown.vue',
  ],
}

/** The classes an `@utility` block applies, comments dropped. */
function utility(name: string) {
  const body = css.match(new RegExp(`@utility ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1]
  expect(body, `@utility ${name} in main.css`).toBeTruthy()
  return [...body!.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/@apply ([^;]+);/g)]
    .flatMap(match => match[1]!.trim().split(/\s+/))
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

  test('a component body takes the type scale of the content around it', () => {
    const box = utility('okb-prose-box')
    expect(box.filter(cls => /(^|:)(text|leading)-/.test(cls))).toEqual([])
  })

  const FLUSH = ['okb-prose-compact', 'okb-prose-box']

  test.each(FLUSH)('%s stays flush with its edges even when a heading opens it', (name) => {
    // The answer's heading classes are important, so the resets must be too —
    // otherwise importance, not specificity, decides the first block.
    const classes = utility(name)
    for (const cls of ['*:first:mt-0!', '*:last:mb-0!']) expect(classes).toContain(cls)
  })
})
