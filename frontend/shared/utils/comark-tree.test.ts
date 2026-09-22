import { readdirSync, readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { describe, it, expect } from 'vitest'
import { citationsByBlock, markdownToTree, parseComark, referencesByBlock, liftTitleBlockId, COMPONENT_TAGS, HTML_ELEMENTS, type AllowedHtml, type AttrRule, type ComarkNode } from './comark-tree'
import { CITATION_TAG } from './citations'

const RECIPES = new URL('../../../recipes/', import.meta.url)

/**
 * The shipped `allowed_html` setting, read the way `filter_html` reads it: a
 * bare attribute takes any value, a quoted one lists the values it accepts.
 */
function shippedAllowedHtml(): AllowedHtml {
  const yaml = readFileSync(new URL('openkb_recipe_core/config/filter.format.comark.yml', RECIPES), 'utf8')
  const setting = /allowed_html: '(.*)'/.exec(yaml)?.[1] ?? ''
  // Core adds these to every tag, whatever the setting says.
  const listed: AllowedHtml = { '*': { lang: true, dir: { ltr: true, rtl: true } } }
  for (const [, tag, attributes] of setting.matchAll(/<([a-z][a-z0-9]*)((?:[^>"]|"[^"]*")*)>/g)) {
    const rules: Record<string, AttrRule> = {}
    for (const [, name, values] of (attributes ?? '').matchAll(/([a-zA-Z][\w:.*-]*)(?:="([^"]*)")?/g)) {
      rules[name!] = values === undefined
        ? true
        : Object.fromEntries(values.split(/\s+/).filter(Boolean).map(value => [value, true]))
    }
    listed[tag!] = rules
  }
  return listed
}

/** Every page body the demo recipe ships. */
function demoBodies(): string[] {
  const dir = new URL('openkb_recipe_demo_pages/content/kb_page/', RECIPES)
  return readdirSync(dir).flatMap((file) => {
    const doc = parseYaml(readFileSync(new URL(file, dir), 'utf8')) as Record<string, Record<string, unknown>>
    return Object.entries(doc)
      .filter(([key]) => key !== '_meta')
      .flatMap(([, translation]) => (translation.field_kb_body as Array<{ value?: string }> | undefined) ?? [])
      .map(item => item.value)
      .filter((value): value is string => typeof value === 'string')
  })
}

type Element = [string, Record<string, unknown>, ...ComarkNode[]]

/** The node at an index, read as an element. */
function at(nodes: ComarkNode[], index = 0): Element {
  const found = nodes[index]
  if (typeof found !== 'object') throw new Error(`nodes[${index}] is not an element: ${JSON.stringify(found)}`)
  return found as Element
}

function children(of: Element): ComarkNode[] {
  return of.slice(2) as ComarkNode[]
}

function tags(nodes: ComarkNode[]): Array<string | null> {
  return nodes.map(node => (typeof node === 'string' ? null : node[0]))
}

/** Every word in a subtree, elements dissolved. */
function collect(nodes: ComarkNode[]): string {
  return nodes.map(node => (typeof node === 'string' ? node : collect(children(node as Element)))).join('')
}

/** The first element in a subtree with this tag. */
function find(nodes: ComarkNode[], tag: string): Element | undefined {
  for (const node of nodes) {
    if (typeof node === 'string') continue
    if (node[0] === tag) return node as Element
    const inner = find(children(node as Element), tag)
    if (inner) return inner
  }
  return undefined
}

describe('markdownToTree', () => {
  it('keeps plain markdown as the parser’s own elements', async () => {
    const nodes = await markdownToTree('# Hi\n\nHello.')
    expect(tags(nodes)).toEqual(['h1', 'p'])
    expect(children(at(nodes, 1))).toEqual(['Hello.'])
  })

  it('keeps a component fence with its attributes', async () => {
    const md = `# T

intro

::callout{type="warning"}
inside
::

after
`
    const nodes = await markdownToTree(md)
    expect(tags(nodes)).toEqual(['h1', 'p', 'callout', 'p'])
    expect(at(nodes, 2)[1]).toEqual({ type: 'warning' })
    expect(children(at(nodes, 2))).toEqual(['inside'])
  })

  it('returns an empty tree for empty input', async () => {
    expect(await markdownToTree('')).toEqual([])
    expect(await markdownToTree('   \n\n')).toEqual([])
  })
})

describe('task-list checkboxes', () => {
  it('keeps the checkbox state the parser wrote', async () => {
    const nodes = await markdownToTree('- [x] checked\n- [ ] unchecked\n')
    const [checked, unchecked] = children(at(nodes))
    expect(at(children(checked as Element))[1]).toMatchObject({ type: 'checkbox', checked: true, disabled: true })
    expect(at(children(unchecked as Element))[1]).not.toHaveProperty('checked')
  })

  it('names each checkbox by the words of its own item', async () => {
    const nodes = await markdownToTree('- [x] buy **milk**\n')
    const item = children(at(nodes))[0] as Element
    expect(at(children(item))[1]['aria-label']).toBe('buy milk')
  })
})

describe('block attributes', () => {
  // comark parses trailing `{#id}` block attributes and the `#id` fence-prop
  // shorthand into `id` props.
  it('parses {#id} block attributes into the tree', async () => {
    const md = `## Section {#b-3f9a}

A paragraph. {#b-71c2}

::callout{type="info" #b-c9f0}
Body text.
::
`
    const nodes = await markdownToTree(md)
    expect(at(nodes, 0)[1]).toEqual({ id: 'b-3f9a' })
    expect(at(nodes, 1)[1]).toEqual({ id: 'b-71c2' })
    expect(at(nodes, 2)[1]).toEqual({ type: 'info', id: 'b-c9f0' })
    // the marker is consumed, never rendered as text
    expect(JSON.stringify(nodes)).not.toContain('{#')
  })

  it('dissolves a ::block wrapper fence onto the container it carries', async () => {
    const md = `::block{#b-tbl}
| a | b |
| --- | --- |
| 1 | 2 |
::
`
    const nodes = await markdownToTree(md)
    expect(tags(nodes)).toEqual(['table'])
    expect(at(nodes)[1]).toEqual({ id: 'b-tbl' })
  })
})

describe('block links', () => {
  it('gives an id-bearing paragraph a link to itself and a list none', async () => {
    const md = `A paragraph. {#b-71c2}

::block{#b-list1}
- one
- two
::
`
    const nodes = await markdownToTree(md, { blockLinks: true })
    // The label carries the block's own words, so a page of links is navigable.
    expect(children(at(nodes, 0)).at(-1)).toEqual(
      ['a', { 'class': 'okb-block-link', 'href': '#b-71c2', 'aria-label': 'Link to block: A paragraph.' }, '¶'],
    )
    // The list keeps its id — it is addressable — but an anchor is no valid
    // child of a <ul>, so it carries no affordance.
    expect(at(nodes, 1)[1]).toEqual({ id: 'b-list1' })
    expect(JSON.stringify(nodes)).not.toContain('#b-list1')
  })

  it('falls back to a generic name for a block with no words of its own', async () => {
    const nodes = await markdownToTree('![](/a.png) {#b-img1}\n', { blockLinks: true })
    expect(find(nodes, 'a')?.[1]['aria-label']).toBe('Link to this block')
  })

  it('leaves an id-bearing paragraph alone without the option', async () => {
    const nodes = await markdownToTree('A paragraph. {#b-71c2}\n')
    expect(at(nodes)[1]).toEqual({ id: 'b-71c2' })
    expect(JSON.stringify(nodes)).not.toContain('okb-block-link')
  })
})

/** The stub resolver stands in for the per-reader JSON:API read: an unreadable target is absent, exactly as a deleted one is. */
describe('document links', () => {
  const resolving = (map: Record<number, { title: string, path: string }>) => ({
    resolveDocs: async (nids: number[]) =>
      Object.fromEntries(nids.filter(nid => nid in map).map(nid => [nid, map[nid]!])),
  })

  it('renders the target’s live title and alias for a reader who may see it', async () => {
    const nodes = await markdownToTree(
      'See :doc[Old name]{nid="42"} first.',
      resolving({ 42: { title: 'Release process', path: '/handbook/release' } }),
    )
    expect(find(nodes, 'doc')).toEqual(
      ['doc', { href: '/handbook/release', nid: 42, block: undefined, title: undefined }, 'Release process'],
    )
    expect(JSON.stringify(nodes)).not.toContain('Old name')
  })

  it('renders the stored label and /node/<nid> when the target does not resolve', async () => {
    const unreadable = await markdownToTree('See :doc[Old name]{nid="42"} first.', resolving({}))
    const deleted = await markdownToTree('See :doc[Old name]{nid="42"} first.', resolving({ 7: { title: 'Other', path: '/o' } }))
    expect(find(unreadable, 'doc')?.[1]).toMatchObject({ href: '/node/42' })
    expect(children(find(unreadable, 'doc')!)).toEqual(['Old name'])
    // A deleted target and an unreadable one must render as the same node.
    expect(deleted).toEqual(unreadable)
  })

  it('carries a block target into the fragment, resolved or not', async () => {
    const md = 'Read :doc[Rollback]{nid="42" block="b-4f2a"} now.'
    const seen = await markdownToTree(md, resolving({ 42: { title: 'Release process', path: '/handbook/release' } }))
    const unseen = await markdownToTree(md, resolving({}))
    expect(find(seen, 'doc')?.[1].href).toBe('/handbook/release#b-4f2a')
    expect(find(unseen, 'doc')?.[1].href).toBe('/node/42#b-4f2a')
  })

  it('names the passage, not the page, when a block is the target', async () => {
    const nodes = await markdownToTree(
      'Read :doc[Rollback]{nid="42" block="b-4f2a"} now.',
      resolving({ 42: { title: 'Release process', path: '/handbook/release' } }),
    )
    // Only the stored label names the passage a block link points at.
    expect(find(nodes, 'doc')?.[1]).toMatchObject({ block: 'b-4f2a', title: 'Release process' })
    expect(children(find(nodes, 'doc')!)).toEqual(['Rollback'])
  })

  it('asks for every linked nid once, in one batch', async () => {
    const calls: number[][] = []
    await markdownToTree(
      'a :doc[A]{nid="1"} b :doc[B]{nid="2"}\n\nc :doc[A again]{nid="1"}',
      { resolveDocs: async (nids) => { calls.push(nids); return {} } },
    )
    expect(calls).toEqual([[1, 2]])
  })

  it('leaves a component naming no page as the author’s words', async () => {
    const nodes = await markdownToTree('A :doc[Nowhere]{nid="nope"} link.', resolving({}))
    expect(children(at(nodes))).toEqual(['A ', 'Nowhere', ' link.'])
  })
})

describe('inline components', () => {
  const linked = { resolveDocs: async () => ({ 7: { title: 'Rollback', path: '/handbook/rollback' } }) }

  it('leaves a component inside a paragraph where the parser put it', async () => {
    const nodes = await markdownToTree('See :doc[L]{nid="7"} first. {#b-71c2}', linked)
    expect(at(nodes)[0]).toBe('p')
    expect(at(nodes)[1]).toEqual({ id: 'b-71c2' })
    expect(tags(children(at(nodes)))).toEqual([null, 'doc', null])
  })

  it('keeps the text around a component, marks and all', async () => {
    const nodes = await markdownToTree('text **bold :doc[L]{nid="7"} end** tail', linked)
    expect(tags(children(at(nodes)))).toEqual([null, 'strong', null])
    const strong = children(at(nodes))[1] as Element
    expect(tags(children(strong))).toEqual([null, 'doc', null])
  })

  it('renders an inline image through the image component', async () => {
    const nodes = await markdownToTree(
      'An :image{media="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"} here.',
      { resolveMedia: async () => ({ 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee': { url: '/files/pic.png', alt: 'A picture', width: 8, height: 6 } }) },
    )
    expect(find(nodes, 'image')?.[1]).toMatchObject({ src: '/files/pic.png', inline: true })
  })

  it('leaves a block-level component alone', async () => {
    const nodes = await markdownToTree('::callout{type="info"}\ninside\n::\n')
    expect(at(nodes)[1]).not.toHaveProperty('inline')
  })

  it('names the block link by the words the reader sees', async () => {
    const nodes = await markdownToTree('See :doc[Stale label]{nid="7"} first. {#b-71c2}', { ...linked, blockLinks: true })
    const link = children(at(nodes)).at(-1) as Element
    expect(link[1]['aria-label']).toBe('Link to block: See Rollback first.')
  })

  it('keeps the block link a direct child of the block it addresses', async () => {
    const nodes = await markdownToTree('See :doc[L]{nid="7"} first. {#b-71c2}', { ...linked, blockLinks: true })
    const link = children(at(nodes)).at(-1) as Element
    expect(link[0]).toBe('a')
    expect(link[1]).toMatchObject({ class: 'okb-block-link' })
  })

  it('does not let a tag attribute choose the element', async () => {
    const nodes = await markdownToTree('See :doc[L]{nid="7"} first. {#b-1 tag="iframe"}', linked)
    expect(at(nodes)[0]).toBe('p')
  })

  it('does not let an inline attribute decide how a component renders', async () => {
    const nodes = await markdownToTree('::callout{inline="true" type="info"}\ninside\n::\n')
    expect(at(nodes)[1]).toEqual({ type: 'info', inline: 'true' })
  })

  it('leaves a directive that opens right after a quote as the author’s text', async () => {
    const nodes = await markdownToTree('He said ":doc[L]{nid="7"}" loudly.', linked)
    expect(JSON.stringify(nodes)).toContain(':doc')
    expect(find(nodes, 'doc')).toBeUndefined()
  })
})

describe('unbuilt components', () => {
  it('renders a component nobody has built under the fallback tag, named', async () => {
    const nodes = await markdownToTree('::mystery{a="1"}\nwords\n::\n')
    expect(at(nodes)).toEqual(['unknown', { a: '1', name: 'mystery' }, 'words'])
  })

  it('marks one sitting in a paragraph as inline', async () => {
    const nodes = await markdownToTree('An :mystery[x] here.')
    expect(find(nodes, 'unknown')?.[1]).toMatchObject({ name: 'mystery', inline: true })
  })

  it('marks one nested in an inline component as inline too', async () => {
    const nodes = await markdownToTree('a :callout[holds :mystery[y] here] b')
    expect(find(nodes, 'unknown')?.[1]).toMatchObject({ name: 'mystery', inline: true })
  })

  it('leaves one nested in a block component alone', async () => {
    const nodes = await markdownToTree('::callout\nholds :mystery[y] here\n::\n')
    expect(find(nodes, 'unknown')?.[1]).not.toHaveProperty('inline')
  })
})

describe('attribute filter', () => {
  it('drops event handlers and executable URLs', async () => {
    const md = '<img src="x" onerror="alert(1)">\n\n<a href="javascript:alert(1)">click</a>\n'
    const json = JSON.stringify(await markdownToTree(md))
    expect(json).not.toContain('onerror')
    expect(json).not.toContain('javascript:')
    expect(json).toContain('click')
  })

  it('renders an anchor left without a target as a span, not a link', async () => {
    const nodes = await markdownToTree('<a href="javascript:alert(1)">click</a>\n')
    expect(find(nodes, 'a')).toBeUndefined()
    expect(find(nodes, 'span')?.[2]).toBe('click')
  })

  it('keeps an ordinary link and an inline data:image', async () => {
    const md = '<a href="/pages/one">one</a>\n\n<img src="data:image/png;base64,AAAA">\n'
    const json = JSON.stringify(await markdownToTree(md))
    expect(json).toContain('/pages/one')
    expect(json).toContain('data:image/png;base64,AAAA')
  })

  it.each([
    ['raster', 'data:image/png;base64,iVBORw0KGgo='],
    ['base64 svg', 'data:image/svg+xml;base64,PHN2Zy8+'],
    ['encoded svg', 'data:image/svg+xml,%3Csvg%2F%3E'],
    ['unescaped svg, as the write door stores it', 'data:image/svg+xml;utf8,%3Csvg%2F%3E'],
  ])('renders an image written as a %s data URI', async (_form, src) => {
    expect(find(await markdownToTree(`![a](${src})`), 'img')?.[1]).toMatchObject({ src, alt: 'a' })
  })

  // A browser runs no script inside an `<img>`, so the SVG is drawn and never
  // executed. Every other media type stays refused, as an image and as a link.
  it.each([
    'data:text/html;base64,AAA=',
    'data:application/javascript,alert%281%29',
    'data:image%2Fpng;base64,AAA=',
  ])('admits no data URI that is not an image: %s', async (src) => {
    const nodes = await markdownToTree(`![a](${src})\n\n[b](${src})\n`)
    expect(find(nodes, 'img')).toBeUndefined()
    expect(find(nodes, 'a')).toBeUndefined()
  })

  it('admits an image data URI on an image only, not on a link', async () => {
    const nodes = await markdownToTree('[b](data:image/svg+xml,%3Csvg%2F%3E)\n')
    expect(find(nodes, 'a')).toBeUndefined()
  })

  it('drops a URL whose scheme is split by a control character', async () => {
    const nodes = await markdownToTree('<a href="java\nscript:alert(1)">click</a>\n')
    expect(JSON.stringify(nodes)).not.toContain('script:alert')
    expect(JSON.stringify(nodes)).toContain('click')
  })

  it('drops an event handler from a component prop', async () => {
    const nodes = await markdownToTree('::callout{onclick="alert(1)" type="info"}\ninside\n::\n')
    expect(at(nodes)[0]).toBe('callout')
    expect(at(nodes)[1]).toEqual({ type: 'info' })
  })

  // A `:` binding carries an expression the renderer resolves after this
  // filter, so its value cannot be checked here — only comark's own bindings
  // survive.
  it('drops a binding that hides an executable URL behind a JSON literal', async () => {
    const nodes = await markdownToTree('[click](/ok){:href=\'"javascript:alert(1)"\'}\n')
    expect(find(nodes, 'a')?.[1]).toEqual({ href: '/ok' })
  })

  it('drops a binding that reads an executable URL off a component prop', async () => {
    const md = '::callout{x="javascript:alert(1)"}\n[click](/ok){:href="props.x"}\n::\n'
    const nodes = await markdownToTree(md)
    expect(find(nodes, 'a')?.[1]).toEqual({ href: '/ok' })
  })

  it('writes the checkbox bindings comark emits as plain attributes', async () => {
    const nodes = await markdownToTree('- [x] done\n')
    expect(find(nodes, 'input')?.[1]).toMatchObject({ checked: true, disabled: true })
  })

  // `as` names the component a node mounts as, so a document that set it could
  // name any registered app component into the page.
  it('does not let an as attribute choose the component', async () => {
    const nodes = await markdownToTree('[y]{as="callout"} z\n')
    expect(find(nodes, 'span')?.[1]).toEqual({})
  })
})

describe('dropped tags', () => {
  const md = '<style>p{color:red}</style>\n\n<script>alert(1)</script>\n\nVisible.\n'

  it('drops script and style with their content', async () => {
    const nodes = await markdownToTree(md)
    expect(JSON.stringify(nodes)).not.toContain('alert(1)')
    expect(JSON.stringify(nodes)).not.toContain('color:red')
    expect(children(at(nodes))).toEqual(['Visible.'])
  })
})

describe('citation chips', () => {
  const sources = [
    { n: 1, title: 'Deploy on Pantheon', path: '/lupus-decoupled/deployment/pantheon' },
    { n: 2, title: 'Release checklist', path: '/handbook/release' },
    { n: 3, title: 'Spaces', path: '/handbook/spaces' },
    { n: 7, title: 'Seven', path: '/seven' },
  ]

  /** The `n` of every citation node in the tree, in document order. */
  function chipped(nodes: ComarkNode[]): string[] {
    return nodes.flatMap((node) => {
      if (typeof node === 'string') return []
      return node[0] === CITATION_TAG ? [String(node[1].n)] : chipped(children(node as Element))
    })
  }

  it('renders a bare [n] as a citation node carrying the source it names', async () => {
    const nodes = await markdownToTree('answer [1] and [2].', { citationChips: sources })
    const chip = find(nodes, CITATION_TAG)
    expect(chip?.[1]).toEqual({ n: '1', title: 'Deploy on Pantheon', path: '/lupus-decoupled/deployment/pantheon' })
    expect(chipped(nodes)).toEqual(['1', '2'])
  })

  it('chips both markers of an adjacent [1][2] pair', async () => {
    const nodes = await markdownToTree('answer [1][2] more.', { citationChips: sources })
    expect(chipped(nodes)).toEqual(['1', '2'])
    expect(JSON.stringify(nodes)).not.toContain('[1]')
  })

  it('chips every number of a [1, 2] marker', async () => {
    for (const marker of ['[1, 2]', '[1,2]']) {
      const nodes = await markdownToTree(`answer ${marker} more.`, { citationChips: sources })
      expect(chipped(nodes)).toEqual(['1', '2'])
    }
  })

  it('chips a marker written straight after a word', async () => {
    const nodes = await markdownToTree('as documented[1].', { citationChips: sources })
    expect(chipped(nodes)).toEqual(['1'])
  })

  it('writes a [n] with no source back out as text', async () => {
    const nodes = await markdownToTree('answer [1] and [2].', { citationChips: [sources[0]!] })
    expect(children(at(nodes))).toContain('[2]')
    expect(chipped(nodes)).toEqual(['1'])
  })

  it('keeps a marker whose source has no path as text', async () => {
    // A chip is a link; a source with nowhere to lead is no better than an
    // uncited number.
    const nodes = await markdownToTree('answer [1].', { citationChips: [{ n: 1, title: 'Nowhere' }] })
    expect(children(at(nodes))).toContain('[1]')
    expect(chipped(nodes)).toEqual([])
  })

  it('keeps a marker whose numbers are not all cited as text', async () => {
    const nodes = await markdownToTree('answer [1, 2] more.', { citationChips: [sources[0]!] })
    expect(children(at(nodes))).toContain('[1, 2]')
    expect(chipped(nodes)).toEqual([])
  })

  it('leaves [n] alone when not enabled', async () => {
    const nodes = await markdownToTree('answer [1].')
    expect(JSON.stringify(nodes)).not.toContain(CITATION_TAG)
  })

  it('leaves an authored [label]{.cls} span alone', async () => {
    const nodes = await markdownToTree('a [7]{.tag} b', { citationChips: sources })
    expect(JSON.stringify(nodes)).not.toContain(CITATION_TAG)
  })

  it('leaves a marker inside code as code', async () => {
    const nodes = await markdownToTree('a `[1]` b', { citationChips: sources })
    expect(find(nodes, 'code')?.[2]).toBe('[1]')
    expect(JSON.stringify(nodes)).not.toContain(CITATION_TAG)
  })

  it('chips a [n] inside a component slot too', async () => {
    const nodes = await markdownToTree('::callout{type="info"}\nsee [3]\n::\n', { citationChips: sources })
    expect(find(nodes, CITATION_TAG)?.[1].n).toBe('3')
  })
})

describe('streaming a partial answer', () => {
  // What the chat surfaces feed the passes: the accumulated text so far,
  // re-parsed on every delta. comark auto-closes, so an open fence is already
  // the component — the raw `::` must never reach the reader.
  it('emits the component node for a fence that has not closed yet', async () => {
    const nodes = await markdownToTree('Here you go:\n\n::callout{type="warning"}\nmind the gap')
    expect(at(nodes, 1)[0]).toBe('callout')
    expect(children(at(nodes, 1))).toEqual(['mind the gap'])
    expect(JSON.stringify(nodes)).not.toContain('::')
  })

  it('grows the same component across successive chunks', async () => {
    const chunks = ['::callout{type="info"}\n', '::callout{type="info"}\nhalf', '::callout{type="info"}\nhalf a line\n::\n']
    for (const text of chunks) {
      expect(at(await markdownToTree(text))[0]).toBe('callout')
    }
  })

  it('asks the resolver for nothing while a media id is still arriving', async () => {
    const asked: string[][] = []
    const resolveMedia = async (uuids: string[]) => {
      asked.push(uuids)
      return {}
    }
    const prefixes = ['5', '54ffeb17-9d23-4fd', '54ffeb17-9d23-4fdb-882b-81e9be09c']
    for (const prefix of prefixes) {
      await markdownToTree(`::image{media="${prefix}`, { resolveMedia })
    }
    expect(asked).toEqual([])

    await markdownToTree('::image{media="54ffeb17-9d23-4fdb-882b-81e9be09cab5"}\n::\n', { resolveMedia })
    expect(asked).toEqual([['54ffeb17-9d23-4fdb-882b-81e9be09cab5']])
  })
})

describe('image embeds', () => {
  const media = {
    'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee': { url: '/files/pic.png', alt: 'A picture', width: 800, height: 600 },
  }

  it('resolves a block-level ::image onto the node', async () => {
    const nodes = await markdownToTree(
      '::image{media="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}\n::\n',
      { resolveMedia: async () => media },
    )
    expect(at(nodes)[0]).toBe('image')
    expect(at(nodes)[1]).toMatchObject({ src: '/files/pic.png', alt: 'A picture', width: 800, height: 600 })
  })

  it('keeps the node without a src when the UUID does not resolve', async () => {
    const nodes = await markdownToTree(
      '::image{media="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}\n::\n',
      { resolveMedia: async () => ({}) },
    )
    expect(at(nodes)[0]).toBe('image')
    expect(at(nodes)[1].src).toBeUndefined()
  })
})

describe('the text format’s allowed list', () => {
  /** A list shaped like the one `GET /openkb/schema` publishes. */
  const allowedHtml = {
    'p': { id: { 'b-*': true } },
    'span': {},
    'strong': {},
    'table': { id: { 'b-*': true } },
    'thead': {},
    'tbody': {},
    'tr': {},
    'td': { style: { 'text-align:left': true, 'text-align:center': true } },
    'ul': { class: { 'contains-task-list': true } },
    'li': { class: { 'task-list-item': true } },
    'pre': { language: true },
    'code': { class: { 'language-*': true } },
    'input': { type: { checkbox: true }, class: { 'task-list-item-checkbox': true }, checked: true, disabled: true },
    'a': { href: true, 'data-*': true },
    'callout': { type: true },
    '*': { lang: true },
  } as const satisfies AllowedHtml

  it('applies one list to an HTML element and to a component alike', async () => {
    const md = '<span title="t" lang="de">words</span> and :callout[words]{title="t" lang="de"}\n'
    const nodes = await markdownToTree(md, { allowedHtml })
    expect(find(nodes, 'span')?.[1]).toEqual({ lang: 'de' })
    expect(find(nodes, 'callout')?.[1]).toEqual({ lang: 'de', inline: true })
  })

  it('drops the style and class raw HTML would overlay the app with', async () => {
    const md = '<span style="position:fixed;inset:0" class="fixed inset-0 bg-white">gotcha</span>\n'
    const nodes = await markdownToTree(md, { allowedHtml })
    expect(find(nodes, 'span')?.[1]).toEqual({})
    expect(children(find(nodes, 'span')!)).toEqual(['gotcha'])
  })

  it('unwraps a tag the list does not carry, keeping its words', async () => {
    const nodes = await markdownToTree('a <u>plain **loud**</u> tail\n', { allowedHtml })
    expect(tags(children(at(nodes)))).toEqual([null, null, 'strong', null])
    expect(collect(nodes)).toBe('a plain loud tail')
  })

  it('still refuses an executable URL in a listed attribute', async () => {
    const nodes = await markdownToTree('<a href="javascript:alert(1)">click</a>\n', { allowedHtml })
    // The href is refused, and an anchor without one renders as a span.
    expect(find(nodes, 'a')).toBeUndefined()
    expect(find(nodes, 'span')?.[1]).toEqual({})
  })

  it('keeps a listed attribute value and drops one beside it', async () => {
    const nodes = await markdownToTree('<ul class="contains-task-list bg-white"><li>x</li></ul>\n', { allowedHtml })
    expect(find(nodes, 'ul')?.[1]).toEqual({ class: 'contains-task-list' })
  })

  it('drops an attribute none of whose values are listed', async () => {
    const nodes = await markdownToTree('| a |\n|--:|\n| 1 |\n', { allowedHtml })
    expect(find(nodes, 'td')?.[1]).toEqual({})
  })

  it('takes any value where the list restricts none', async () => {
    const nodes = await markdownToTree('```js\nconst a = 1\n```\n', { allowedHtml })
    expect(find(nodes, 'pre')?.[1]).toEqual({ language: 'js' })
  })

  it('globs an attribute value the list ends in a star', async () => {
    const nodes = await markdownToTree('```js\nconst a = 1\n```\n', { allowedHtml })
    expect(find(nodes, 'code')?.[1]).toEqual({ class: 'language-js' })
  })

  it('globs an attribute name the list ends in a star', async () => {
    const md = '<a href="/x" data-n="1" data="/y">click</a>\n'
    const nodes = await markdownToTree(md, { allowedHtml })
    expect(find(nodes, 'a')?.[1]).toEqual({ 'href': '/x', 'data-n': '1' })
  })

  it('keeps what comark’s own parsing sets', async () => {
    const md = '| a |\n|:-:|\n| 1 |\n\n- [x] done\n\nWords. {#b-71c2}\n'
    const nodes = await markdownToTree(md, { allowedHtml })
    expect(find(nodes, 'td')?.[1]).toEqual({ style: 'text-align:center' })
    expect(find(nodes, 'input')?.[1]).toEqual({
      'class': 'task-list-item-checkbox',
      'type': 'checkbox',
      'checked': true,
      'disabled': true,
      'aria-label': 'done',
    })
    expect(find(nodes, 'p')?.[1]).toEqual({ id: 'b-71c2' })
  })

  it('drops an id the list does not carry and the pass did not set', async () => {
    const nodes = await markdownToTree('Words. {#nav}\n', { allowedHtml })
    expect(find(nodes, 'p')?.[1]).toEqual({})
  })

  it('never lets a binding reach the renderer, listed or not', async () => {
    const md = ':callout[x]{:checked="danger" :disabled="x"}\n\n<input type="checkbox" :checked="danger">\n'
    const nodes = await markdownToTree(md, { allowedHtml })
    expect(find(nodes, 'callout')?.[1]).toEqual({})
    expect(find(nodes, 'input')?.[1]).toEqual({ type: 'checkbox' })
  })

  it('drops a style the list carries only for another tag', async () => {
    const nodes = await markdownToTree('<span style="text-align:center">x</span>\n', { allowedHtml })
    expect(find(nodes, 'span')?.[1]).toEqual({})
  })

  it('lands a wrapper fence’s id on the block it wraps', async () => {
    const md = '::block{#b-71c2}\n| a |\n|---|\n| 1 |\n::\n'
    const nodes = await markdownToTree(md, { allowedHtml })
    expect(find(nodes, 'table')?.[1]).toEqual({ id: 'b-71c2' })
  })

  it('drops a wrapper fence’s id the list does not carry', async () => {
    const md = '::block{#nav}\n| a |\n|---|\n| 1 |\n::\n'
    const nodes = await markdownToTree(md, { allowedHtml })
    expect(find(nodes, 'table')?.[1]).toEqual({})
  })

  it('takes any attribute where the list restricts the tag with none', async () => {
    const md = '<span title="t" class="anything">words</span>\n'
    const nodes = await markdownToTree(md, { allowedHtml: { ...allowedHtml, span: true } })
    expect(find(nodes, 'span')?.[1]).toEqual({ title: 't', class: 'anything' })
  })
})

// The passes know the tag vocabulary; the format decides what of it an author
// may write. A tag or attribute this module renders but the shipped format
// omits would silently stop rendering on every site that takes the shipped
// list, so the shipped list is read here and held to both.
describe('the shipped format', () => {
  const listed = shippedAllowedHtml()

  it('lists every tag the passes render', () => {
    for (const tag of [...HTML_ELEMENTS, ...COMPONENT_TAGS]) {
      expect(Object.keys(listed)).toContain(tag)
    }
  })

  it('lists the attributes a document link needs to address a block', () => {
    expect(listed.doc).toEqual({ nid: true, block: true })
  })

  it('lists the attributes a citation needs to name a source and its version', () => {
    expect(listed.citation).toEqual({ nid: true, block: true, v: true, url: true })
  })

  it('renders every demo body exactly as it does without the list', async () => {
    const bodies = demoBodies()
    expect(bodies.length).toBeGreaterThan(0)
    for (const markdown of bodies) {
      const filtered = await markdownToTree(markdown, { allowedHtml: listed })
      const unfiltered = await markdownToTree(markdown)
      expect(filtered).toEqual(unfiltered)
    }
  })
})

// The page's own <h1> is the heading a reader sees, so the body's copy is
// hidden — and the lead section's citation has to land on something visible.
describe('the title heading id', () => {
  it('comes off the leading h1, which keeps everything else', () => {
    const tree: ComarkNode[] = [
      ['h1', { id: 'b-title', class: 'x' }, 'Getting started'],
      ['p', { id: 'b-intro' }, 'Text.'],
    ]
    expect(liftTitleBlockId(tree)).toEqual({
      titleBlockId: 'b-title',
      nodes: [['h1', { class: 'x' }, 'Getting started'], ['p', { id: 'b-intro' }, 'Text.']],
    })
  })

  it('takes the ¶ with it, so the affordance follows the id', () => {
    const tree: ComarkNode[] = [
      ['h1', { id: 'b-title' }, 'Getting started', ['a', { class: 'okb-block-link', href: '#b-title' }, '¶']],
    ]
    expect(liftTitleBlockId(tree)).toEqual({
      titleBlockId: 'b-title',
      nodes: [['h1', {}, 'Getting started']],
    })
  })

  it('leaves the tree it was handed alone, whose ids the editor reads as tokens', () => {
    const tree: ComarkNode[] = [['h1', { id: 'b-title' }, 'Getting started']]
    liftTitleBlockId(tree)
    expect(tree).toEqual([['h1', { id: 'b-title' }, 'Getting started']])
  })

  it('is empty where the body opens on a block of its own', () => {
    const tree: ComarkNode[] = [['p', { id: 'b-intro' }, 'Straight into it.']]
    expect(liftTitleBlockId(tree)).toEqual({ titleBlockId: '', nodes: tree })
    expect(liftTitleBlockId([])).toEqual({ titleBlockId: '', nodes: [] })
  })

  it('is empty where the heading carries no block id, or one that is no block', () => {
    const noId: ComarkNode[] = [['h1', {}, 'T'], ['p', { id: 'b-intro' }, 'Text.']]
    expect(liftTitleBlockId(noId)).toEqual({ titleBlockId: '', nodes: noId })
    const slug: ComarkNode[] = [['h1', { id: 'getting-started' }, 'T']]
    expect(liftTitleBlockId(slug)).toEqual({ titleBlockId: '', nodes: slug })
  })
})

describe('page citations', () => {
  const RELEASE = { title: 'Release process', path: '/handbook/release' }

  /** The cited pages a reader may see, each with its blocks' current versions. */
  const resolving = (map: Record<number, { title: string, path: string, versions: Record<string, string> }>) => ({
    resolveCites: async (nids: number[]) =>
      Object.fromEntries(nids.filter(nid => nid in map).map(nid => [nid, map[nid]!])),
  })

  const cited = { ...RELEASE, versions: { 'b-4f2a': 'aaaaaaaaaaaa' } }

  it('renders a chip that leads to the cited block', async () => {
    const nodes = await markdownToTree(
      'Derived from it. :citation{nid="42" block="b-4f2a" v="aaaaaaaaaaaa"}',
      resolving({ 42: cited }),
    )
    expect(find(nodes, CITATION_TAG)).toEqual(
      [CITATION_TAG, { n: '1', title: 'Release process', path: '/handbook/release#b-4f2a' }],
    )
  })

  it('numbers by distinct target in document order', async () => {
    const nodes = await markdownToTree([
      'One. :citation{nid="42" block="b-4f2a" v="aaaaaaaaaaaa"} {#b-1}',
      '',
      'Two. :citation{nid="7" block="b-x" v="cccccccccccc"} {#b-2}',
      '',
      'One again. :citation{nid="42" block="b-4f2a" v="aaaaaaaaaaaa"} {#b-3}',
    ].join('\n'), resolving({
      42: cited,
      7: { title: 'Other', path: '/o', versions: { 'b-x': 'cccccccccccc' } },
    }))
    expect(nodes.map(node => find([node], CITATION_TAG)?.[1].n)).toEqual(['1', '2', '1'])
  })

  it('marks a citation whose source has moved since', async () => {
    const nodes = await markdownToTree(
      'Derived. :citation{nid="42" block="b-4f2a" v="aaaaaaaaaaaa"}',
      resolving({ 42: { ...RELEASE, versions: { 'b-4f2a': 'bbbbbbbbbbbb' } } }),
    )
    expect(find(nodes, CITATION_TAG)?.[1]).toMatchObject({ state: 'stale' })
  })

  it('marks a citation whose source is gone, and one whose page is', async () => {
    const blockGone = await markdownToTree(
      'Derived. :citation{nid="42" block="b-4f2a" v="aaaaaaaaaaaa"}',
      resolving({ 42: { ...RELEASE, versions: { 'b-other': 'aaaaaaaaaaaa' } } }),
    )
    // The block is gone, the page is not: the chip leads to the page.
    expect(find(blockGone, CITATION_TAG)?.[1]).toEqual({
      n: '1', title: 'Release process', path: '/handbook/release', state: 'dangling',
    })
    const pageGone = await markdownToTree(
      'Derived. :citation{nid="42" block="b-4f2a" v="aaaaaaaaaaaa"}',
      resolving({}),
    )
    // Nothing resolved, so the chip leads nowhere rather than to a 404.
    expect(find(pageGone, CITATION_TAG)?.[1]).toEqual({ n: '1', title: '', state: 'dangling' })
  })

  it('renders an external source as a chip on its own address', async () => {
    const nodes = await markdownToTree(
      'Measured long ago. :citation{url="https://example.org/paper"}',
      resolving({}),
    )
    expect(find(nodes, CITATION_TAG)).toEqual(
      [CITATION_TAG, { n: '1', title: 'example.org', path: 'https://example.org/paper' }],
    )
  })

  it('asks for every cited nid once, in one batch', async () => {
    const calls: number[][] = []
    await markdownToTree(
      'a :citation{nid="1" block="b-a" v="aaaaaaaaaaaa"} b :citation{nid="2" block="b-b" v="bbbbbbbbbbbb"}'
      + '\n\nc :citation{nid="1" block="b-c" v="cccccccccccc"} d :citation{url="https://example.org/"}',
      { resolveCites: async (nids) => { calls.push(nids); return {} } },
    )
    expect(calls).toEqual([[1, 2]])
  })

  it('renders nothing where nothing resolves citations — the index holds words', async () => {
    const nodes = await markdownToTree('Derived. :citation{nid="42" block="b-4f2a" v="aaaaaaaaaaaa"}')
    expect(find(nodes, CITATION_TAG)).toBeUndefined()
    expect(children(at(nodes))).toEqual(['Derived. '])
  })

  it('drops a citation naming no source', async () => {
    const nodes = await markdownToTree('Derived. :citation{nid="nope"}', resolving({}))
    expect(find(nodes, CITATION_TAG)).toBeUndefined()
  })

  it('leaves the HTML cite element as the prose it is', async () => {
    const nodes = await markdownToTree(
      'As <cite>The Blue Book</cite> has it. :citation{nid="42" block="b-4f2a" v="aaaaaaaaaaaa"}',
      { ...resolving({ 42: cited }), allowedHtml: shippedAllowedHtml() },
    )
    expect(collect(nodes)).toContain('As The Blue Book has it.')
    expect(find(nodes, CITATION_TAG)?.[1].n).toEqual('1')
  })

  it('asks only the citations for the bodies a version is hashed from', async () => {
    const calls: { docs?: number[], cites?: number[] }[] = []
    await markdownToTree(
      'See :doc[Other]{nid="7"} and :citation{nid="42" block="b-a" v="aaaaaaaaaaaa"}',
      {
        resolveDocs: async (nids) => { calls.push({ docs: nids }); return {} },
        resolveCites: async (nids) => { calls.push({ cites: nids }); return {} },
      },
    )
    expect(calls).toEqual([{ docs: [7] }, { cites: [42] }])
  })
})

describe('a block’s own sources', () => {
  it('lists them once each, in the order the block cites them', async () => {
    const nodes = await markdownToTree([
      'First. :citation{nid="42" block="b-a" v="aaaaaaaaaaaa"} and again :citation{nid="42" block="b-a" v="aaaaaaaaaaaa"} {#b-1}',
      '',
      'Second. :citation{nid="7" block="b-b" v="bbbbbbbbbbbb"} {#b-2}',
      '',
      'Nothing cited here. {#b-3}',
    ].join('\n'), {
      resolveCites: async () => ({
        42: { title: 'A', path: '/a', versions: { 'b-a': 'aaaaaaaaaaaa' } },
        7: { title: 'B', path: '/b', versions: { 'b-b': 'zzzzzzzzzzzz' } },
      }),
    })
    expect(citationsByBlock(nodes)).toEqual({
      'b-1': [{ n: '1', title: 'A', path: '/a#b-a' }],
      'b-2': [{ n: '2', title: 'B', path: '/b#b-b', state: 'stale' }],
    })
  })

  it('is empty for a page that cites nothing', async () => {
    expect(citationsByBlock(await markdownToTree('Plain words. {#b-1}'))).toEqual({})
  })
})

describe('a block’s references', () => {
  const refsOf = async (markdown: string) => referencesByBlock(await parseComark(markdown))

  it('names the page and the block a reference points at', async () => {
    expect(await refsOf([
      'Derived from it. :citation{nid="42" block="b-4f2a" v="aaaaaaaaaaaa"} {#b-1}',
      '',
      'See :doc[Release process]{nid="7"} and :doc[one step]{nid="7" block="b-x"}. {#b-2}',
    ].join('\n'))).toEqual({
      'b-1': { cites: ['42', '42#b-4f2a'], links: [] },
      'b-2': { cites: [], links: ['7', '7#b-x'] },
    })
  })

  it('makes no edge of a source outside the knowledge base', async () => {
    expect(await refsOf('Measured long ago. :citation{url="https://example.org/paper"} {#b-1}')).toEqual({})
  })

  it('names each edge once, however often a block writes it', async () => {
    const refs = await refsOf(
      'One. :citation{nid="42" block="b-a" v="aaaaaaaaaaaa"} and again :citation{nid="42" block="b-a" v="bbbbbbbbbbbb"} {#b-1}',
    )
    expect(refs['b-1']).toEqual({ cites: ['42', '42#b-a'], links: [] })
  })

  it('is empty for a page that references nothing', async () => {
    expect(await refsOf('Plain words. {#b-1}')).toEqual({})
  })
})
