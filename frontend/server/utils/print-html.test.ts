import { describe, expect, it } from 'vitest'
import { defaultTreeAdapter as tree, parse, type DefaultTreeAdapterTypes } from 'parse5'
import { buildPrintHtml, EXPORT_CSP, type PrintHtmlSources } from './print-html'

/**
 * The print HTML builder on a print render of a read page, in the shapes the
 * server render gives (Vue fragment comments included).
 */

const DRUPAL = 'http://drupal.example'
const PAGE_URL = 'https://kb.example/general/probe'
const IMAGE = `${DRUPAL}/system/files/images/probe.png`
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64')

const PAGE = `<!DOCTYPE html><html lang="de" class="okb-print-render"><head>
<title>Probe · OpenKnowledgebase</title>
<script>window.evil = 1</script>
<link rel="stylesheet" href="/_nuxt/entry.css">
<link rel="stylesheet" href="https://cdn.example/remote.css">
<link rel="modulepreload" href="/_nuxt/entry.js">
<style id="nuxt-ui-colors">:root { --ui-primary: blue; }</style>
<style>@page { @top-center { content: "Probe" } } .x { background: url(/api/kb/general/secret.md) }</style>
</head><body><div id="__nuxt"><nav>Sidebar</nav><main id="main-content"><div class="mx-auto max-w-[1200px]"><article class="min-w-0">
<div data-testid="meta-strip">Last updated</div>
<h1 class="okb-page-title">Probe</h1>
<p class="hidden print:block" data-testid="page-print-meta"><!--[-->General · <!--]-->/general/probe</p>
<div class="page-body"><div class="comark-content okb-prose">
<p id="b-1">Text with <a href="/general/other" ping="https://evil.example/ping">a link in</a>, <a href="#b-2">a block link</a> and <a href="javascript:alert(1)" onclick="alert(1)">a scripted link</a>.<a class="okb-block-link" href="#b-1">¶</a></p>
<div data-test="callout"><!--[-->A callout.<!--]--></div>
<figure id="b-3"><a href="${IMAGE}" data-lightbox><img src="${IMAGE}" alt="Probe image" loading="lazy" srcset="${IMAGE} 2x"></a></figure>
<p id="b-4"><img src="https://remote.example/x.png" alt="Remote"></p>
<p id="b-5"><img src="data:image/png;base64,AAAA" alt="Inline"></p>
<p id="b-6"><img src="data:text/html,<b>x</b>" alt="Smuggled"></p>
<figure data-test="embed-html"><figcaption><span>probe.html</span><a href="${DRUPAL}/system/files/probe.html?download=probe.html" download>icon</a></figcaption><iframe src="${DRUPAL}/system/files/probe.html" title="probe.html"></iframe></figure>
<figure class="okb-fence"><div class="okb-diagram-canvas"><svg><image href="https://remote.example/y.png"></image><use href="#shape"></use><a href="#shape"><animate attributeName="href" to="https://evil.example/anim"></animate><set attributeName="href" to="https://evil.example/set"></set></a><text>Diagram</text></svg></div><button class="okb-fence-toggle">Show source</button></figure>
<details open><summary>More</summary>Hidden text.</details>
<video src="${DRUPAL}/system/files/clip.mp4"></video>
<form action="https://evil.example"><input name="q"></form>
<script>alert(1)</script>
<div style="background: url(https://remote.example/bg.png)">Styled</div>
</div><div class="okb-block-margin">ℹ</div></div>
<section data-test="page-attachments"><div data-test="attachment-card"><a href="${DRUPAL}/system/files/a.txt?download=a.txt">a.txt</a><a data-test="attachment-download" href="${DRUPAL}/system/files/a.txt" download>Download</a></div></section>
<div class="mt-8 lg:hidden">Outline</div>
</article></div></main></div></body></html>`

/** A stylesheet that names a font of the app and a remote image. */
const ENTRY_CSS = '@font-face { font-family: Probe; src: url(/_fonts/probe.woff2) format("woff2"); } body { background: url("https://remote.example/bg.png"); }'

/** The two fetchers, answering from fixtures; every call is recorded. */
function sources(overrides: Partial<PrintHtmlSources> = {}): PrintHtmlSources & { fetched: string[] } {
  const fetched: string[] = []
  return {
    html: PAGE,
    pageUrl: PAGE_URL,
    fetched,
    fetchAsset: async (path) => {
      fetched.push(path)
      if (path === '/_nuxt/entry.css') return new Response(ENTRY_CSS, { headers: { 'content-type': 'text/css' } })
      if (path === '/_fonts/probe.woff2') return new Response('FONT', { headers: { 'content-type': 'font/woff2' } })
      return new Response('', { status: 404 })
    },
    fetchFile: async (url) => {
      fetched.push(url)
      if (!url.startsWith(`${DRUPAL}/system/files/`)) return null
      return url === IMAGE ? new Response(PNG, { headers: { 'content-type': 'image/png' } }) : new Response('', { status: 403 })
    },
    ...overrides,
  }
}

type Element = DefaultTreeAdapterTypes.Element

/** Every element of a document, depth first. */
function elementsOf(html: string): Element[] {
  const found: Element[] = []
  const walk = (node: DefaultTreeAdapterTypes.ParentNode): void => {
    for (const child of node.childNodes) {
      if (!tree.isElementNode(child)) continue
      found.push(child)
      walk(child)
    }
  }
  walk(parse(html))
  return found
}

/** An element's attribute value. */
function attributeOf(node: Element, name: string): string | undefined {
  return node.attrs.find(attr => attr.name === name)?.value
}

describe('buildPrintHtml', () => {
  it('carries no script, frame, form, button or event handler', async () => {
    const html = await buildPrintHtml(sources())
    const elements = elementsOf(html)
    const tags = new Set(elements.map(node => node.tagName))
    for (const tag of ['script', 'iframe', 'form', 'button', 'video', 'link']) {
      expect(tags.has(tag), tag).toBe(false)
    }
    for (const node of elements) {
      expect(node.attrs.filter(attr => attr.name.startsWith('on')), node.tagName).toEqual([])
    }
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('Sidebar')
    expect(html).not.toContain('ping=')
    expect(html).not.toContain('evil.example')
  })

  it('loads nothing from outside the file', async () => {
    const html = await buildPrintHtml(sources())
    for (const node of elementsOf(html)) {
      for (const attr of node.attrs) {
        const loads = attr.name === 'src' || (attr.name === 'href' && node.tagName !== 'a')
        if (!loads) continue
        expect(attr.value, `${node.tagName}[${attr.name}]`).toMatch(/^(data:|#)/)
      }
    }
    expect(html).not.toMatch(/url\(\s*(?!["']?data:)/)
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">`)
  })

  it('inlines page images, and links the others', async () => {
    const html = await buildPrintHtml(sources())
    const images = elementsOf(html).filter(node => node.tagName === 'img')
    expect(images.map(node => attributeOf(node, 'alt'))).toEqual(['Probe image', 'Inline'])
    expect(attributeOf(images[0]!, 'src')).toBe(`data:image/png;base64,${PNG.toString('base64')}`)
    expect(html).toContain('<a href="https://remote.example/x.png">Image: Remote</a>')
    // Only an http(s) image becomes a link.
    expect(html).toContain('<p id="b-6">Image: Smuggled</p>')
    expect(html).not.toContain('data:text/html')
  })

  it('makes images past the budget links, and says so', async () => {
    const html = await buildPrintHtml(sources({ imageBudget: PNG.length - 1 }))
    expect(elementsOf(html).filter(node => node.tagName === 'img')).toHaveLength(1)
    // The image sits in its lightbox link, which leads to the file.
    expect(html).toContain(`<a href="${IMAGE}" data-lightbox="">Image: Probe image</a>`)
    expect(html).toMatch(/<p class="okb-export-note">Some images are links: an export holds at most 25 MB of images\.<\/p>/)
  })

  it('fetches nothing more once the budget is used', async () => {
    const dataUriLength = `data:image/png;base64,${PNG.toString('base64')}`.length
    const images = ['a', 'b', 'c'].map(name => `<img src="${DRUPAL}/system/files/${name}.png" alt="${name}">`).join('')
    const source = sources({
      html: PAGE.replace('<details open>', `<p id="b-many">${images}</p><details open>`),
      imageBudget: dataUriLength * 2,
      fetchFile: async (url) => {
        source.fetched.push(url)
        if (!url.startsWith(`${DRUPAL}/system/files/`)) return null
        return new Response(PNG, { headers: { 'content-type': 'image/png' } })
      },
    })
    const html = await buildPrintHtml(source)
    expect(source.fetched.filter(url => url.startsWith(`${DRUPAL}/`))).toEqual([IMAGE, `${DRUPAL}/system/files/a.png`])
    expect(html).toContain(`<a href="${DRUPAL}/system/files/b.png">Image: b</a>`)
    expect(html).toContain(`<a href="${DRUPAL}/system/files/c.png">Image: c</a>`)
    expect(html).toContain('class="okb-export-note"')
  })

  it('reads no image past the budget left', async () => {
    const pulled: string[] = []
    /** A body of eight 1 kB chunks, recording each one read. */
    const body = () => new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled.push('chunk')
        controller.enqueue(new Uint8Array(1024))
        if (pulled.length >= 8) controller.close()
      },
    })
    const declaresItsSize = sources({
      imageBudget: 2048,
      fetchFile: async url => url === IMAGE
        ? new Response(body(), { headers: { 'content-type': 'image/png', 'content-length': '8192' } })
        : null,
    })
    expect(await buildPrintHtml(declaresItsSize)).toContain('Image: Probe image')
    expect(pulled.length).toBeLessThanOrEqual(1)

    pulled.length = 0
    const streams = sources({
      imageBudget: 2048,
      fetchFile: async url => url === IMAGE ? new Response(body(), { headers: { 'content-type': 'image/png' } }) : null,
    })
    expect(await buildPrintHtml(streams)).toContain('Image: Probe image')
    // The stream reads one chunk ahead.
    expect(pulled.length).toBeLessThanOrEqual(3)
  })

  it('answers 503 when no stylesheet loads', async () => {
    const source = sources({ fetchAsset: async () => new Response('', { status: 404 }) })
    await expect(buildPrintHtml(source)).rejects.toMatchObject({ statusCode: 503 })
  })

  it('drops frames and makes media a link to the file', async () => {
    const html = await buildPrintHtml(sources())
    expect(html).toContain('<figcaption><span>probe.html</span>')
    expect(html).not.toContain('<iframe')
    expect(html).toContain(`<a href="${DRUPAL}/system/files/clip.mp4">Video: ${DRUPAL}/system/files/clip.mp4</a>`)
  })

  it('keeps the article as the print render gives it, with the root class', async () => {
    const html = await buildPrintHtml(sources())
    expect(html).toContain('<html lang="de" class="okb-print-render">')
    expect(html).toContain('<title>Probe · OpenKnowledgebase</title>')
    expect(html).toContain('<main id="main-content"><div class="mx-auto max-w-[1200px]"><article class="min-w-0">')
    // The print CSS in the file decides what shows; the source keeps it all.
    expect(html).toContain('Last updated')
    expect(html).toContain('<details open=""><summary>More</summary>Hidden text.</details>')
    expect(html).toContain('<text>Diagram</text>')
    expect(html).not.toContain('Sidebar')
  })

  it('refuses a render that is no print render', async () => {
    const source = sources({ html: PAGE.replace(' class="okb-print-render"', '') })
    await expect(buildPrintHtml(source)).rejects.toMatchObject({ statusCode: 503 })
  })

  it('makes links absolute, block links stay in the file', async () => {
    const html = await buildPrintHtml(sources())
    expect(html).toContain('<a href="https://kb.example/general/other">a link in</a>')
    expect(html).toContain('<a href="#b-2">a block link</a>')
  })

  it('inlines the page stylesheets and their fonts', async () => {
    const source = sources()
    const html = await buildPrintHtml(source)
    expect(html).toContain(`url("data:font/woff2;base64,${Buffer.from('FONT').toString('base64')}")`)
    expect(html).toContain('background: url("data:,")')
    expect(html).toContain(':root { --ui-primary: blue; }')
    expect(source.fetched).not.toContain('https://cdn.example/remote.css')
    expect(source.fetched).not.toContain('https://remote.example/bg.png')
    // A <style> element carries page text: its url()s load nothing.
    expect(source.fetched).not.toContain('/api/kb/general/secret.md')
    expect(html).toContain('.x { background: url("data:,") }')
  })
})
