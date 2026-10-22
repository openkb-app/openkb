import { describe, expect, it } from 'vitest'
import { parseMarkdownToJson, serializeDocToMarkdown } from '../../comark/markdown-engine'
import { parseImageWidth } from '#shared/utils/image-width'

const FILE = '11111111-2222-4333-8444-555555555555'

describe('parseImageWidth', () => {
  it('reads a percent', () => {
    expect(parseImageWidth('70%')).toBe(70)
    expect(parseImageWidth('100%')).toBe(100)
    expect(parseImageWidth('10%')).toBe(10)
  })

  it('drops pixels, out-of-range and junk values', () => {
    for (const value of ['640', '640px', '0%', '5%', '101%', '70.5%', '', undefined, null]) {
      expect(parseImageWidth(value)).toBeNull()
    }
  })
})

describe('image width in the fence', () => {
  it('loads the width as a percent number', () => {
    expect(parseMarkdownToJson(`::image{file="${FILE}" width="70%"}\n::`).content?.[0])
      .toMatchObject({ type: 'image', attrs: { file: FILE, width: 70 } })
  })

  it('serializes the width after alt and before the id', () => {
    const doc = { type: 'doc', content: [{ type: 'image', attrs: { file: FILE, alt: 'Plan', width: 40, id: 'b-1' } }] }
    expect(serializeDocToMarkdown(doc)).toBe(`::image{file="${FILE}" alt="Plan" width="40%" #b-1}\n::`)
  })

  it('leaves out an unset width', () => {
    const doc = { type: 'doc', content: [{ type: 'image', attrs: { file: FILE, alt: 'Plan' } }] }
    expect(serializeDocToMarkdown(doc)).toBe(`::image{file="${FILE}" alt="Plan"}\n::`)
  })

  it('drops a width that is not a percent', () => {
    const doc = parseMarkdownToJson(`::image{file="${FILE}" width="640"}\n::`)
    expect(serializeDocToMarkdown(doc)).toBe(`::image{file="${FILE}"}\n::`)
  })
})
