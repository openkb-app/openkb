import { defaultTreeAdapter as tree, parse, serialize, serializeOuter, type DefaultTreeAdapterTypes } from 'parse5'
import { createError } from 'h3'
import { CONTROLS, isDataImage } from '#shared/utils/comark-tree'
import { PRINT_RENDER_CLASS } from '#shared/utils/print-render'

/**
 * The print HTML of a page: one self-contained `.html` file, built from the
 * export's print render of the read page (docs/adr/0029-the-print-render.md).
 *
 * - Keeps the page's article and the print render's root class: the
 *   components' print CSS decides what shows.
 * - Inlines the page's stylesheets, their fonts, and the page images as
 *   `data:` URIs.
 * - No script, no frame, no request: the file opens offline, and its CSP
 *   refuses anything else.
 */

type Element = DefaultTreeAdapterTypes.Element
type ParentNode = DefaultTreeAdapterTypes.ParentNode
type ChildNode = DefaultTreeAdapterTypes.ChildNode

/**
 * Image data one export holds at most, counted as the file carries it
 * (`data:` URIs, base64); images past it become links.
 */
export const IMAGE_BUDGET_BYTES = 25 * 1024 * 1024

/** What the file may load: inlined images, fonts and styles. */
export const EXPORT_CSP = 'default-src \'none\'; img-src data:; font-src data:; style-src \'unsafe-inline\''

/**
 * The file is read on screen too:
 * - in the light scheme, like the print;
 * - as a sheet of paper, with the print's margins (print.css `@page`).
 */
const EXPORT_CSS = [
  'html { color-scheme: light; }',
  '@media screen { body { box-sizing: border-box; max-width: 210mm; margin: 0 auto; padding: 18mm clamp(16px, 4vw, 16mm) 20mm; } }',
  '.okb-export-note { margin: 0 0 14pt; font-size: 9pt; color: #4b5563; }',
].join(' ')

/** Elements that run, load or submit something; the export carries none. */
const DROPPED_ELEMENTS = new Set([
  'script', 'noscript', 'template', 'style', 'link', 'meta', 'base',
  'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal',
  'form', 'button', 'dialog', 'source', 'track',
  // SVG animation can set an `href` after the sanitize pass.
  'animate', 'animateMotion', 'animateTransform', 'set',
])

/** Elements whose `src` streams media; the export links to it. */
const MEDIA_ELEMENTS = new Set(['video', 'audio'])

/** SVG elements whose `href` loads a resource. */
const SVG_RESOURCE_ELEMENTS = new Set(['image', 'use', 'feImage'])

/** What {@link buildPrintHtml} reads from: the rendered page and two fetchers. */
export interface PrintHtmlSources {
  /** The read page's server render, a print render. */
  html: string
  /** The page's absolute URL; relative links resolve against it. */
  pageUrl: string
  /** A stylesheet or font of this app, by its root-relative path. */
  fetchAsset: (path: string) => Promise<Response>
  /** A page file as the reader may download it; null for a URL that is not one. */
  fetchFile: (url: string) => Promise<Response | null>
  /** Image data to inline at most, as `data:` URI characters. */
  imageBudget?: number
}

/** A page image that does not fit the budget left. */
const OVER_BUDGET = Symbol('over budget')

/**
 * Builds the self-contained print HTML from the read page's server render.
 */
export async function buildPrintHtml(sources: PrintHtmlSources): Promise<string> {
  const doc = parse(sources.html)
  const html = findElement(doc, node => node.tagName === 'html')
  if (!html || !hasClass(html, PRINT_RENDER_CLASS)) {
    console.error('[page-export] the rendered page is no print render')
    throw createError({ statusCode: 503, statusMessage: 'Page unavailable' })
  }
  const main = findElement(doc, node => attribute(node, 'id') === 'main-content')
  const article = main ? findElement(main, node => node.tagName === 'article') : null
  if (!article) {
    console.error('[page-export] the rendered page holds no article')
    throw createError({ statusCode: 503, statusMessage: 'Page unavailable' })
  }

  removeScriptsFramesAndResourceUrls(article)
  makeLinksAbsolute(article, sources.pageUrl)
  const capped = await inlinePageImages(article, sources)

  const head = findElement(doc, node => node.tagName === 'head')
  const title = head ? findElement(head, node => node.tagName === 'title') : null
  const css = head ? await collectInlinedStyles(head, sources.fetchAsset) : null
  if (!css) {
    throw createError({ statusCode: 503, statusMessage: 'Page styles unavailable' })
  }
  const wrapperClass = attribute(article.parentNode as Element, 'class') ?? ''
  const wrapper = tree.createElement('div', article.namespaceURI, [{ name: 'class', value: wrapperClass }])
  tree.detachNode(article)
  if (capped) {
    tree.appendChild(wrapper, imageCapNote(article.namespaceURI))
  }
  tree.appendChild(wrapper, article)

  return printHtmlDocument({
    lang: attribute(html, 'lang') ?? 'en',
    title: title ? serialize(title) : '',
    css,
    body: serializeOuter(wrapper),
  })
}

/**
 * The file around the article: a print render, so the root carries its class.
 *
 * `#__nuxt > #main-content`: the print CSS hides every other body child.
 */
function printHtmlDocument(parts: { lang: string, title: string, css: string, body: string }): string {
  return [
    '<!DOCTYPE html>',
    `<html lang="${escapeAttribute(parts.lang)}" class="${PRINT_RENDER_CLASS}">`,
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${parts.title}</title>`,
    `<style>${parts.css.replace(/<\/style/gi, '<\\/style')}</style>`,
    `<style>${EXPORT_CSS}</style>`,
    '</head>',
    `<body><div id="__nuxt"><main id="main-content">${parts.body}</main></div></body>`,
    '</html>',
    '',
  ].join('\n')
}

/**
 * Drops what could run or load: scripts, frames, forms, buttons, comments,
 * event handlers, scripted URLs and resource URLs that are not `data:`.
 * Video and audio become a link to their file.
 */
function removeScriptsFramesAndResourceUrls(root: Element): void {
  for (const media of findElements(root, node => MEDIA_ELEMENTS.has(node.tagName))) {
    const src = attribute(media, 'src')
    if (src) {
      const kind = media.tagName === 'video' ? 'Video' : 'Audio'
      replaceNode(media, linkElement(src, `${kind}: ${src}`))
    }
    else {
      tree.detachNode(media)
    }
  }
  removeElements(root, node => DROPPED_ELEMENTS.has(node.tagName))
  removeComments(root)
  for (const node of findElements(root, () => true)) {
    node.attrs = node.attrs.filter(attr => !isUnsafeAttribute(node, attr.name.toLowerCase(), attr.value))
  }
}

/** Whether an attribute could script the file or make it load something. */
function isUnsafeAttribute(node: Element, name: string, value: string): boolean {
  if (name.startsWith('on') || ['srcset', 'loading', 'formaction', 'ping'].includes(name)) {
    return true
  }
  // The URL parser ignores C0 and space; the scheme checks must too.
  const url = value.replace(CONTROLS, '')
  if ((name === 'href' || name === 'src') && /^(javascript|vbscript):/i.test(url)) {
    return true
  }
  if (name === 'href' && SVG_RESOURCE_ELEMENTS.has(node.tagName)) {
    return !url.startsWith('#') && !isDataImage(url)
  }
  if (name === 'href' && /^data:/i.test(url)) {
    return true
  }
  if (name === 'style') {
    return /url\(/i.test(value) && !/url\(\s*['"]?data:/i.test(value)
  }
  return false
}

/** Makes every link absolute, so a file opened from disk leads back to the KB. */
function makeLinksAbsolute(root: Element, pageUrl: string): void {
  for (const link of findElements(root, node => node.tagName === 'a')) {
    for (const attr of link.attrs) {
      if (attr.name !== 'href' || attr.value.startsWith('#') || !URL.canParse(attr.value, pageUrl)) continue
      attr.value = new URL(attr.value, pageUrl).href
    }
  }
}

/**
 * Puts each page image in the file as a `data:` URI, fetched as the reader.
 * An image that is no page file, that the reader may not see, or that does not
 * fit the budget becomes a link to it. Returns true when the budget ran out.
 *
 * Holds only the data it inlines; once the budget is used, nothing more is fetched.
 */
async function inlinePageImages(root: Element, sources: PrintHtmlSources): Promise<boolean> {
  const budget = sources.imageBudget ?? IMAGE_BUDGET_BYTES
  const dataUris = new Map<string, string | null>()
  let used = 0
  let capped = false
  for (const image of findElements(root, node => node.tagName === 'img')) {
    const src = attribute(image, 'src') ?? ''
    if (isDataImage(src)) continue
    const url = URL.canParse(src, sources.pageUrl) ? new URL(src, sources.pageUrl).href : ''
    if (!url) {
      replaceImageByLink(image, url)
      continue
    }
    if (!dataUris.has(url) && used < budget) {
      const fetched = await fetchImageAsDataUri(sources, url, budget - used)
      if (fetched !== OVER_BUDGET) {
        dataUris.set(url, fetched)
      }
    }
    // Undefined: past the budget, never fetched or read in full.
    const dataUri = dataUris.get(url)
    if (dataUri && used + dataUri.length <= budget) {
      used += dataUri.length
      setAttribute(image, 'src', dataUri)
      continue
    }
    capped ||= dataUri !== null
    replaceImageByLink(image, url)
  }
  return capped
}

/**
 * A page image as a `data:` URI, read up to the `room` left in the budget.
 *
 * Returns null for one the reader may not see, OVER_BUDGET for one past `room`.
 */
async function fetchImageAsDataUri(
  sources: PrintHtmlSources,
  url: string,
  room: number,
): Promise<string | null | typeof OVER_BUDGET> {
  const response = await sources.fetchFile(url).catch(() => null)
  if (!response) {
    return null
  }
  const type = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
  if (!response.ok || !type.startsWith('image/')) {
    await response.body?.cancel().catch(() => {})
    return null
  }
  const prefix = `data:${type};base64,`
  // base64 writes 4 characters per 3 bytes.
  const maxBytes = Math.floor((room - prefix.length) / 4) * 3
  const declaredBytes = Number(response.headers.get('content-length') ?? 0)
  if (maxBytes <= 0 || declaredBytes > maxBytes) {
    await response.body?.cancel().catch(() => {})
    return OVER_BUDGET
  }
  const bytes = await readBodyUpTo(response, maxBytes).catch(() => null)
  if (bytes === OVER_BUDGET || bytes === null) {
    return bytes
  }
  return prefix + bytes.toString('base64')
}

/** A response body of at most `maxBytes`; OVER_BUDGET, and the rest unread, past it. */
async function readBodyUpTo(response: Response, maxBytes: number): Promise<Buffer | typeof OVER_BUDGET> {
  if (!response.body) {
    return Buffer.alloc(0)
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > maxBytes) {
      await reader.cancel().catch(() => {})
      return OVER_BUDGET
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/** An image the file does not carry: its alt text, linked to the image unless it sits in a link already. */
function replaceImageByLink(image: Element, url: string): void {
  const alt = attribute(image, 'alt')
  const label = alt ? `Image: ${alt}` : 'Image'
  const inLink = hasAncestor(image, node => node.tagName === 'a')
  const linkable = url !== '' && !isUnsafeAttribute(image, 'href', url)
  if (inLink || !linkable) {
    const parent = image.parentNode!
    tree.insertTextBefore(parent, label, image)
    tree.detachNode(image)
    return
  }
  replaceNode(image, linkElement(url, label))
}

/** The line above the article that says some images are links. */
function imageCapNote(namespaceURI: Element['namespaceURI']): Element {
  const note = tree.createElement('p', namespaceURI, [{ name: 'class', value: 'okb-export-note' }])
  const megabytes = Math.round(IMAGE_BUDGET_BYTES / 1024 / 1024)
  tree.insertText(note, `Some images are links: an export holds at most ${megabytes} MB of images.`)
  return note
}

/**
 * The page's stylesheets in document order — linked sheets and `<style>`
 * elements — with every `url()` inlined. Null when no linked sheet loaded.
 *
 * Only this app's linked sheets have their `url()`s fetched; a `<style>`
 * element carries page text (the `@page` title), so its `url()`s load nothing.
 */
async function collectInlinedStyles(head: Element, fetchAsset: PrintHtmlSources['fetchAsset']): Promise<string | null> {
  const sheets: string[] = []
  const assets = new Map<string, string>()
  let linkedSheets = 0
  for (const node of head.childNodes) {
    if (!tree.isElementNode(node)) continue
    const rel = (attribute(node, 'rel') ?? '').toLowerCase().split(/\s+/)
    const href = attribute(node, 'href') ?? ''
    if (node.tagName === 'link' && rel.includes('stylesheet') && isRootRelative(href)) {
      const response = await fetchAsset(href).catch(() => null)
      if (response?.ok) {
        linkedSheets++
        sheets.push(await inlineCssUrls(await response.text(), href, fetchAsset, assets))
      }
    }
    if (node.tagName === 'style') {
      sheets.push(await inlineCssUrls(textContent(node), '/', null, assets))
    }
  }
  return linkedSheets ? sheets.join('\n') : null
}

/**
 * Replaces each `url()` of a stylesheet by a `data:` URI of this app's asset
 * (fonts, mostly). A URL off this app, or any without `fetchAsset`, loads nothing.
 */
async function inlineCssUrls(
  css: string,
  sheetPath: string,
  fetchAsset: PrintHtmlSources['fetchAsset'] | null,
  assets: Map<string, string>,
): Promise<string> {
  const pattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/g
  const urls = new Set<string>()
  for (const match of css.matchAll(pattern)) {
    urls.add(match[1] ?? match[2] ?? match[3] ?? '')
  }
  const replacements = new Map<string, string>()
  for (const url of urls) {
    replacements.set(url, await cssAssetAsDataUri(url, sheetPath, fetchAsset, assets))
  }
  return css.replace(pattern, (_match, double?: string, single?: string, bare?: string) => {
    return `url("${replacements.get(double ?? single ?? bare ?? '')}")`
  })
}

/** One stylesheet URL as a `data:` URI; `data:,` for one that is not this app's. */
async function cssAssetAsDataUri(
  url: string,
  sheetPath: string,
  fetchAsset: PrintHtmlSources['fetchAsset'] | null,
  assets: Map<string, string>,
): Promise<string> {
  if (/^data:/i.test(url)) {
    return url.replace(/"/g, '%22')
  }
  const base = 'http://app.invalid'
  const resolved = URL.canParse(url, base + sheetPath) ? new URL(url, base + sheetPath) : null
  if (!fetchAsset || !resolved || resolved.origin !== base) {
    return 'data:,'
  }
  const path = resolved.pathname + resolved.search
  if (!assets.has(path)) {
    assets.set(path, await fetchAssetAsDataUri(fetchAsset, path))
  }
  return assets.get(path)!
}

/** One of this app's assets as a `data:` URI; `data:,` when it does not load. */
async function fetchAssetAsDataUri(fetchAsset: PrintHtmlSources['fetchAsset'], path: string): Promise<string> {
  const response = await fetchAsset(path).catch(() => null)
  if (!response?.ok) {
    return 'data:,'
  }
  const type = response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream'
  const bytes = Buffer.from(await response.arrayBuffer())
  return `data:${type};base64,${bytes.toString('base64')}`
}

/** Whether a URL is a path on this app (`/…`, not `//host/…`). */
function isRootRelative(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//')
}

/** The first element under `root`, depth first, that `test` accepts. */
function findElement(root: ParentNode, test: (node: Element) => boolean): Element | null {
  for (const child of root.childNodes) {
    if (!tree.isElementNode(child)) continue
    if (test(child)) return child
    const found = findElement(child, test)
    if (found) return found
  }
  return null
}

/** Every element under `root` that `test` accepts, in document order. */
function findElements(root: ParentNode, test: (node: Element) => boolean): Element[] {
  const found: Element[] = []
  for (const child of root.childNodes) {
    if (!tree.isElementNode(child)) continue
    if (test(child)) found.push(child)
    found.push(...findElements(child, test))
  }
  return found
}

/** Removes every element under `root` that `test` accepts, with its content. */
function removeElements(root: ParentNode, test: (node: Element) => boolean): void {
  for (const child of [...root.childNodes]) {
    if (!tree.isElementNode(child)) continue
    if (test(child)) {
      tree.detachNode(child)
    }
    else {
      removeElements(child, test)
    }
  }
}

/** Removes every comment under `root`. */
function removeComments(root: ParentNode): void {
  for (const child of [...root.childNodes]) {
    if (tree.isCommentNode(child)) {
      tree.detachNode(child)
    }
    else if (tree.isElementNode(child)) {
      removeComments(child)
    }
  }
}

/** Puts `replacement` where `node` is. */
function replaceNode(node: ChildNode, replacement: Element): void {
  tree.insertBefore(node.parentNode!, replacement, node)
  tree.detachNode(node)
}

/** A link to `href` reading `label`. */
function linkElement(href: string, label: string): Element {
  const attrs = [{ name: 'href', value: href }]
  const link = tree.createElement('a', 'http://www.w3.org/1999/xhtml' as Element['namespaceURI'], attrs)
  tree.insertText(link, label)
  return link
}

/** The text below a node. */
function textContent(node: ParentNode): string {
  return node.childNodes.map((child) => {
    if (tree.isTextNode(child)) return child.value
    return tree.isElementNode(child) ? textContent(child) : ''
  }).join('')
}

/** Whether an ancestor of `node` passes `test`. */
function hasAncestor(node: Element, test: (node: Element) => boolean): boolean {
  let current = node.parentNode
  while (current && tree.isElementNode(current as ChildNode)) {
    if (test(current as Element)) return true
    current = (current as Element).parentNode
  }
  return false
}

/** An attribute's value; undefined when the element has none. */
function attribute(node: Element | null, name: string): string | undefined {
  return node?.attrs.find(attr => attr.name === name)?.value
}

/** Sets an attribute, adding it when missing. */
function setAttribute(node: Element, name: string, value: string): void {
  const existing = node.attrs.find(attr => attr.name === name)
  if (existing) {
    existing.value = value
  }
  else {
    node.attrs.push({ name, value })
  }
}

/** The element's class names. */
function classList(node: Element): string[] {
  return (attribute(node, 'class') ?? '').split(/\s+/).filter(Boolean)
}

/** Whether the element carries a class. */
function hasClass(node: Element, name: string): boolean {
  return classList(node).includes(name)
}

/** A value for a double-quoted attribute. */
function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
