import { describe, it, expect } from 'vitest'
import { fileIcon, formatFileSize, isFileUuid } from './files'

describe('page file helpers', () => {
  it('formats sizes for people and nothing for a non-size', () => {
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(48_333)).toBe('47.2 KB')
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatFileSize(undefined)).toBe('')
    expect(formatFileSize('x')).toBe('')
  })

  it('picks the card icon by MIME type', () => {
    expect(fileIcon('application/pdf')).toBe('i-lucide-file-text')
    expect(fileIcon('text/csv')).toBe('i-lucide-file-spreadsheet')
    expect(fileIcon('image/png')).toBe('i-lucide-file-image')
    expect(fileIcon('application/zip')).toBe('i-lucide-file-archive')
    expect(fileIcon('application/octet-stream')).toBe('i-lucide-file')
  })

  it('accepts only a whole UUID', () => {
    expect(isFileUuid('11111111-2222-4333-8444-555555555555')).toBe(true)
    expect(isFileUuid('11111111-2222')).toBe(false)
    expect(isFileUuid(7)).toBe(false)
  })
})
