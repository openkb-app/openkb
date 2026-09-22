import { describe, it, expect } from 'vitest'
import { blockProvenanceFrom, enrichCePage, type CePage } from './drupal-ce-enrich'
import { serializeBlockMeta, type BlockMetaMap } from '#shared/page-blocks'

const kbResponse = (): CePage => ({
  title: 'Hello',
  content: {
    element: 'node-kb-page',
    props: {
      nid: '42',
      title: 'Hello',
      // Shape produced by custom_elements' `raw` formatter on a text_long field.
      body: {
        value: '# Top heading\n\nIntro text.\n\n::callout{type="info"}\nInside callout.\n::\n',
        format: 'comark',
        processed: '<p>ignored drupal-rendered html</p>',
      },
    },
  },
})

describe('enrichCePage', () => {
  it('parses content.props.body into the comark tree for kb_page responses', async () => {
    const out = await enrichCePage(kbResponse())
    const body = out.content?.props?.bodyTree as Array<[string, Record<string, unknown>, ...unknown[]]>
    expect(body[0]?.[0]).toBe('h1')
    expect(JSON.stringify(body[0])).toContain('Top heading')
    const callout = body.find(node => node[0] === 'callout')
    expect(callout?.[1]).toMatchObject({ type: 'info' })
  })

  it('drops the markdown from props once consumed', async () => {
    const out = await enrichCePage(kbResponse())
    expect(out.content?.props).not.toHaveProperty('body')
    expect(out.content?.props).toMatchObject({ nid: '42', title: 'Hello' })
  })

  it('returns the response unchanged when props.body is missing', async () => {
    const page: CePage = {
      content: { element: 'node-kb-page', props: { nid: '1', title: 't' } },
    }
    expect(await enrichCePage(page)).toEqual(page)
  })

  it('returns the response unchanged for empty markdown', async () => {
    const page: CePage = {
      content: { element: 'node-kb-page', props: { nid: '1', body: { value: '   \n' } } },
    }
    expect(await enrichCePage(page)).toEqual(page)
  })

  it('also accepts a bare-string body (backwards-compat with markdown_raw-style emitters)', async () => {
    const page: CePage = {
      content: { element: 'node-kb-page', props: { body: '# H' } },
    }
    const out = await enrichCePage(page)
    expect(out.content?.props?.bodyTree).toBeDefined()
    expect(out.content?.props).not.toHaveProperty('body')
  })

  it('filters the tree by the allowed list it is handed', async () => {
    const page = kbResponse()
    page.content!.props!.body = { value: '<span style="position:fixed">overlay</span>\n' }
    const out = await enrichCePage(page, {}, { p: {}, span: {} })
    expect(JSON.stringify(out.content?.props?.bodyTree)).not.toContain('position:fixed')
  })

  it('passes through non-kb_page responses untouched', async () => {
    const other: CePage = {
      content: { element: 'node-page', props: { body: { value: 'leave me alone' } }, slots: { body: ['x'] } },
    }
    expect(await enrichCePage(other)).toEqual(other)
  })
})

/** A sidecar as Drupal's presave writes it: one block written, one signed off. */
function sidecar(): BlockMetaMap {
  return {
    'b-1': {
      contributors: [
        { uid: 3, via: null, name: 'fago', lastEdit: 1000 },
        { uid: 3, via: 'Claude', name: 'fago', lastEdit: 2000 },
      ],
      'pending:peer': { by: [3], ok: [] },
    },
    'b-2': {
      contributors: [{ uid: 7, via: null, name: 'reviewer', lastEdit: 500 }],
      'review:peer': { uid: 9, name: 'signer', at: 3000, vid: 12 },
    },
  }
}

describe('blockProvenanceFrom', () => {
  it('orders contributors by last edit, most recent first', () => {
    const out = blockProvenanceFrom(serializeBlockMeta(sidecar()))
    expect(out['b-1']!.contributors.map(c => c.lastEdit)).toEqual([2000, 1000])
  })

  it('keeps a human and the same human via an agent as separate contributors', () => {
    const out = blockProvenanceFrom(serializeBlockMeta(sidecar()))
    expect(out['b-1']!.contributors.map(c => c.via)).toEqual(['Claude', null])
  })

  it('carries the sign-off through verbatim, and names the revision it covers', () => {
    const out = blockProvenanceFrom(serializeBlockMeta(sidecar()))

    expect(out['b-2']!.review.peer).toMatchObject({ uid: 9, name: 'signer', at: 3000, vid: 12 })
    expect(out['b-2']!.pending).toEqual([])
  })

  it('carries the pending flags through as the blocks the page still owes', () => {
    const out = blockProvenanceFrom(serializeBlockMeta(sidecar()))

    expect(out['b-1']!.pending).toEqual(['peer'])
  })

  it('drops an entry that attributes nobody and owes nothing', () => {
    expect(blockProvenanceFrom(serializeBlockMeta({ 'b-1': { contributors: [] } }))).toEqual({})
  })

  it('yields an empty map for an unstored / unparseable sidecar', () => {
    expect(blockProvenanceFrom(null)).toEqual({})
    expect(blockProvenanceFrom('')).toEqual({})
    expect(blockProvenanceFrom('not json')).toEqual({})
  })
})

describe('enrichCePage — block provenance', () => {
  function withSidecar(): CePage {
    const page = kbResponse()
    page.content!.props!.blockMeta = { value: serializeBlockMeta(sidecar()) }
    return page
  }

  it('exposes the derived sidecar on content.props.blockProvenance', async () => {
    const out = await enrichCePage(withSidecar())
    expect(Object.keys(out.content!.props!.blockProvenance!)).toEqual(['b-1', 'b-2'])
    expect(out.content!.props!.blockProvenance!['b-1']!.contributors[0]).toMatchObject({ name: 'fago' })
  })

  it('drops the raw field once consumed', async () => {
    const out = await enrichCePage(withSidecar())
    expect(out.content?.props).not.toHaveProperty('blockMeta')
  })

  it('omits the key entirely when the page has no provenance', async () => {
    const out = await enrichCePage(kbResponse())
    expect(out.content?.props).not.toHaveProperty('blockProvenance')
  })

  it('accepts a bare-string sidecar as well as the raw field-item assoc', async () => {
    const page = kbResponse()
    page.content!.props!.blockMeta = serializeBlockMeta(sidecar())
    const out = await enrichCePage(page)
    expect(out.content!.props!.blockProvenance).toHaveProperty('b-1')
  })

  it('keys the provenance by the same ids the rendered tree carries', async () => {
    const page = kbResponse()
    page.content!.props!.body = { value: '# Top {#b-1}\n\nIntro. {#b-2}\n' }
    page.content!.props!.blockMeta = { value: serializeBlockMeta(sidecar()) }
    const out = await enrichCePage(page)
    const tree = out.content!.props!.bodyTree as Array<[string, Record<string, unknown>]>
    const ids = tree.map(node => node[1]?.id)
    for (const id of Object.keys(out.content!.props!.blockProvenance!)) {
      expect(ids).toContain(id)
    }
  })
})
