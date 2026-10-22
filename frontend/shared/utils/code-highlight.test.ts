import { describe, it, expect, vi } from 'vitest'
import { highlightToTokens, loadCodeLanguage, plainLines, tokenize } from './code-highlight'
import { codeLanguage } from './code-languages'

describe('codeLanguage', () => {
  it('reads the first word of the info string, aliases included', () => {
    expect(codeLanguage('ts')?.id).toBe('typescript')
    expect(codeLanguage('PHP {1}')?.id).toBe('php')
    expect(codeLanguage('sh')?.id).toBe('bash')
  })

  it('knows no language outside the set', () => {
    expect(codeLanguage('brainfuck')).toBeNull()
    expect(codeLanguage('')).toBeNull()
    expect(codeLanguage(undefined)).toBeNull()
  })
})

describe('highlightToTokens', () => {
  it('colours a known language with both theme variables', async () => {
    const lines = await highlightToTokens('const a = 1', 'ts')
    expect(lines).toHaveLength(1)
    const keyword = lines[0]!.find(token => token.content === 'const')
    expect(keyword?.style).toMatch(/--shiki-light:#[0-9a-f]{6}/i)
    expect(keyword?.style).toMatch(/--shiki-dark:#[0-9a-f]{6}/i)
    expect(lines[0]!.map(token => token.content).join('')).toBe('const a = 1')
  })

  it('leaves text in the themes’ own foreground unstyled', async () => {
    const lines = await highlightToTokens('let b = 2', 'js')
    expect(lines[0]!.some(token => token.style === undefined)).toBe(true)
  })

  it('keeps the light comment colour above 4.5:1 on the code background', async () => {
    const lines = await highlightToTokens('// note', 'ts')
    expect(lines[0]![0]!.style).toContain('--shiki-light:#59636e')
  })

  it('keeps every line, empty ones included', async () => {
    const lines = await highlightToTokens('a()\n\nb()', 'javascript')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toEqual([])
  })

  it('renders an unknown language as one plain token per line', async () => {
    expect(await highlightToTokens('foo bar', 'nope')).toEqual([[{ content: 'foo bar' }]])
    expect(await highlightToTokens('x\ny', '')).toEqual(plainLines('x\ny'))
  })
})

describe('tokenize', () => {
  it('is null until the language is loaded, then matches the async result', async () => {
    expect(tokenize('SELECT 1', 'sql')).toBeNull()
    expect(await loadCodeLanguage('sql')).toBe(true)
    expect(tokenize('SELECT 1', 'sql')).toEqual(await highlightToTokens('SELECT 1', 'sql'))
  })

  it('colours the same on a slow host', async () => {
    const expected = await highlightToTokens('SELECT 1', 'sql')
    let now = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (now += 1000))
    try {
      expect(tokenize('SELECT 1', 'sql')).toEqual(expected)
    }
    finally {
      clock.mockRestore()
    }
  })

  it('answers plain lines for an unknown language right away', () => {
    expect(tokenize('x', 'nope')).toEqual([[{ content: 'x' }]])
  })

  it('leaves a line past the length bound uncoloured, the text intact', async () => {
    const long = `{${'"k":1,'.repeat(300)}"k":1}`
    expect(await highlightToTokens(long, 'json')).toEqual([[{ content: long }]])
  })

  it('leaves a fence past the size bound plain', async () => {
    const big = 'let a = 1\n'.repeat(10_001)
    expect(await highlightToTokens(big, 'ts')).toEqual(plainLines(big))
  })
})
