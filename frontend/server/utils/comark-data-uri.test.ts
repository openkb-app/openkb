import { describe, it, expect } from 'vitest'
import { encodeDataImageUris } from './comark-data-uri'
import { encodePageEntities } from './comark-entities'
import { markdownToTree, type ComarkNode } from '#shared/utils/comark-tree'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><circle r="2" fill="#f0f"/></svg>'

/** The first image's source, as the read page would mount it. */
async function renderedSrc(markdown: string): Promise<string | undefined> {
  const find = (nodes: ComarkNode[]): string | undefined => {
    for (const node of nodes) {
      if (typeof node === 'string') continue
      if (node[0] === 'img') return String(node[1].src)
      const inner = find(node.slice(2) as ComarkNode[])
      if (inner !== undefined) return inner
    }
    return undefined
  }
  return find(await markdownToTree(markdown))
}

describe('the data-URI write door', () => {
  it('keeps an SVG written as characters, as a destination that parses', async () => {
    const src = await renderedSrc(encodeDataImageUris(`![Splash](data:image/svg+xml;utf8,${SVG})`))
    expect(src).toBeDefined()
    expect(decodeURIComponent(src!.replace('data:image/svg+xml;utf8,', ''))).toBe(SVG)
  })

  it.each([
    ['base64', '![a](data:image/svg+xml;base64,PHN2Zy8+)'],
    ['percent-encoded', '![a](data:image/svg+xml,%3Csvg%2F%3E)'],
    ['raster', '![a](data:image/png;base64,iVBORw0KGgo=)'],
    ['a path', '![a](/files/img.png)'],
  ])('leaves a %s destination alone', (_form, markdown) => {
    expect(encodeDataImageUris(markdown)).toBe(markdown)
  })

  it('escapes the characters a destination and a URL cannot carry', () => {
    const written = '![a](data:image/svg+xml;utf8,<svg style="fill:url(#g)">50% ü</svg>)'
    expect(encodeDataImageUris(written))
      .toBe('![a](data:image/svg+xml;utf8,%3Csvg%20style=%22fill:url%28%23g%29%22%3E50%25%20%C3%BC%3C/svg%3E)')
  })

  it('ends the destination at the parenthesis that closes it', () => {
    expect(encodeDataImageUris('see ![a](data:image/svg+xml;utf8,<svg/>) (and more)'))
      .toBe('see ![a](data:image/svg+xml;utf8,%3Csvg/%3E) (and more)')
  })

  it('leaves a URI a code block is showing rather than using', () => {
    const fenced = '```\n![a](data:image/svg+xml;utf8,<svg/>)\n```'
    expect(encodeDataImageUris(fenced)).toBe(fenced)
  })

  it('goes before the entity boundary, so a `<svg` is encoded as part of the URI', () => {
    expect(encodePageEntities(encodeDataImageUris('![a](data:image/svg+xml;utf8,<svg/>)')))
      .toBe('![a](data:image/svg+xml;utf8,%3Csvg/%3E)')
  })

  it.each([
    ['a closing parenthesis', '<svg><text>Hi :)</text></svg>'],
    ['an opening parenthesis', '<svg><text>:(</text></svg>'],
    ['a parenthesis right after a tag', '<svg><text>) done</text></svg>'],
  ])('keeps a payload whose own markup contains %s', async (_shape, markup) => {
    const stored = encodeDataImageUris(`![a](data:image/svg+xml;utf8,${markup})`)
    const src = await renderedSrc(stored)
    expect(decodeURIComponent(src!.replace('data:image/svg+xml;utf8,', ''))).toBe(markup)
  })

  it('ends a payload before a caption that carries markup of its own', () => {
    const captioned = '![chart](data:image/svg+xml;utf8,<svg/>) (see <b>bold</b>)'
    expect(encodeDataImageUris(captioned))
      .toBe('![chart](data:image/svg+xml;utf8,%3Csvg/%3E) (see <b>bold</b>)')
  })

  it('refuses a payload whose root element does not close the destination', () => {
    expect(() => encodeDataImageUris('![a](data:image/svg+xml;utf8,<svg/> trailing)'))
      .toThrowError(/Percent-encode or base64 the payload/)
  })

  it('ends a payload at the image that follows it on the line', () => {
    const two = '![a](data:image/svg+xml;utf8,<svg/>) ![b](data:image/svg+xml;utf8,<svg/>)'
    expect(encodeDataImageUris(two))
      .toBe('![a](data:image/svg+xml;utf8,%3Csvg/%3E) ![b](data:image/svg+xml;utf8,%3Csvg/%3E)')
  })

  it('refuses a destination that never closes on its line', () => {
    expect(() => encodeDataImageUris('![a](data:image/svg+xml;utf8,<svg/>\nnext line'))
      .toThrowError(/Percent-encode or base64 the payload/)
  })
})
