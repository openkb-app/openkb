import { describe, it, expect } from 'vitest'
import { fenceErrors } from '~~/server/utils/fences'
import { check, render } from './server'
import { PELE_OPTIONS } from './pele-options'

describe('render', () => {
  it('renders an SVG with its ids under the given prefix', () => {
    const { html: svg, error } = render('flowchart LR\n  A[Start] --> B[End]', { idPrefix: 'd-b-1-' })
    expect(error).toBeUndefined()
    expect(svg).toMatch(/^<svg [^>]*class="pele pele-flowchart"/)
    expect(svg).toContain('Start')
    expect(svg).not.toMatch(/ id="(?!d-b-1-)/)
  })

  it('escapes label markup and drops links outside http and https', () => {
    const { html: svg } = render([
      'flowchart LR',
      '  A["<img src=x onerror=alert(1)>"] --> B[Docs] --> C[Mail]',
      '  click A "javascript:alert(1)"',
      '  click B "https://example.com/docs"',
      '  click C "mailto:a@example.com"',
    ].join('\n'), { idPrefix: 'd-' })
    expect(svg).not.toMatch(/<img|onerror=|javascript:|mailto:/i)
    expect(svg).toContain('href="https://example.com/docs"')
  })

  it('answers the error with its place for a source that does not parse', () => {
    const { html: svg, error } = render('flowchart LR\n  A --> \n  B -->> [x', { idPrefix: 'd-' })
    expect(svg).toBeUndefined()
    expect(error).toMatchObject({ line: 3, column: 8 })
    expect(error!.message).toMatch(/Parse error/)
  })
})

describe('check', () => {
  it('passes a diagram that parses', () => {
    expect(check('flowchart LR\n  A --> B')).toBeNull()
  })

  it('names the line and column of one that does not', () => {
    expect(check('flowchart LR\n  A --> \n  B -->> [x')).toMatchObject({ line: 3, column: 8, message: expect.stringMatching(/Parse error/) })
  })

  it('refuses a source naming no diagram type', () => {
    expect(check('hello')!.message).toBe('No diagram type detected for the given text.')
  })

  it('refuses a source over the size cap', () => {
    expect(check(`flowchart LR\n${'  A --> B\n'.repeat(PELE_OPTIONS.limit / 10)}`)).not.toBeNull()
  })
})

describe('the write check', () => {
  it("refuses a diagram with Pele's line, column and message", async () => {
    const errors = await fenceErrors('```mermaid\nflowchart LR\n  A --> \n  B -->> [x\n```')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/^Diagram \(Mermaid\): Line 3, column 8: Parse error/)
  })

  it('names a source without a diagram type', async () => {
    expect(await fenceErrors('```mermaid\nhello\n```')).toEqual(['Diagram (Mermaid): No diagram type detected for the given text.'])
  })

  it('passes a diagram that parses', async () => {
    expect(await fenceErrors('::block{#b-1}\n```mermaid\npie\n  "A" : 1\n```\n::')).toEqual([])
  })
})
