import { describe, expect, it } from 'vitest'
import { pageExportFileName } from './export-name'

describe('pageExportFileName', () => {
  it('names the file after the last path segment', () => {
    expect(pageExportFileName('/general/getting-started', 'md')).toBe('getting-started.md')
    expect(pageExportFileName('/general/getting-started', 'html')).toBe('getting-started.html')
  })

  it('falls back to "page" without a segment', () => {
    expect(pageExportFileName('/', 'md')).toBe('page.md')
  })

  it('replaces characters a file name should not carry', () => {
    expect(pageExportFileName('/general/a b"c', 'html')).toBe('a-b-c.html')
  })
})
