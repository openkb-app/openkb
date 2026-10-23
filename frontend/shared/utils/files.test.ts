import { describe, it, expect } from 'vitest'
import { embedFrameHeight, fileDownloadUrl, fileIcon, formatFileSize, isFileUuid } from './files'

describe('page file helpers', () => {
  it('asks Drupal for a download with ?download', () => {
    expect(fileDownloadUrl('https://cms.example/system/files/a.html')).toBe('https://cms.example/system/files/a.html?download')
    expect(fileDownloadUrl('https://cms.example/system/files/a.pdf?itok=x')).toBe('https://cms.example/system/files/a.pdf?itok=x&download')
  })

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

  describe('embed frame height', () => {
    const frame = {}
    const height = (data: unknown, source: unknown = frame) => embedFrameHeight({ source, data } as MessageEvent, frame, 900)

    it('takes the height its own frame reports', () => {
      expect(height({ type: 'okb-embed:height', height: 412.4 })).toBe(412)
    })

    it('clamps to 80 px and the viewport', () => {
      expect(height({ type: 'okb-embed:height', height: 3 })).toBe(80)
      expect(height({ type: 'okb-embed:height', height: 5000 })).toBe(900)
    })

    it('ignores another sender', () => {
      expect(height({ type: 'okb-embed:height', height: 300 }, {})).toBeNull()
      expect(height({ type: 'okb-embed:height', height: 300 }, null)).toBeNull()
      expect(embedFrameHeight({ source: null, data: { type: 'okb-embed:height', height: 300 } } as MessageEvent, null, 900)).toBeNull()
    })

    it('ignores any other payload', () => {
      expect(height({ type: 'other', height: 300 })).toBeNull()
      expect(height({ type: 'okb-embed:height', height: '300' })).toBeNull()
      expect(height({ type: 'okb-embed:height', height: Infinity })).toBeNull()
      expect(height({ type: 'okb-embed:height', height: NaN })).toBeNull()
      expect(height(null)).toBeNull()
      expect(height('okb-embed:height')).toBeNull()
    })
  })
})
