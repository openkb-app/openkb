import Image from '@tiptap/extension-image'
import { Extension } from '@tiptap/core'
import type { JSONContent } from '@tiptap/core'
import { MDC_PROPS_SOURCE, parseMdcProps, serializeMdcProps } from './mdc-markdown'

const BLOCK_FENCE = new RegExp(String.raw`^(:{2,})image\{(${MDC_PROPS_SOURCE})\}[ \t]*(?:\n\1(?!:)[ \t]*(?:\n|$)|\n|$)`)
const INLINE_FENCE = new RegExp(String.raw`^:image\{(${MDC_PROPS_SOURCE})\}`)

/** Attrs the image node carries; only `file`/`alt` (or `src`/`alt`/`title`) reach markdown. */
export interface ImageAttrs {
  /** UUID of a page file in `field_kb_images` (ADR 0020). */
  file?: string | null
  src?: string | null
  alt?: string | null
  title?: string | null
  /** Stable block id: the fence `#id` shorthand, or trailing `{#id}` when plain (OKB-137). */
  id?: string | null
}

/**
 * The inline markdown form an image takes inside a table cell — the one
 * place the block fence can't go: `:image{…}` (single-colon inline
 * component, parsed by comark) for page files, `![alt](src)` otherwise.
 */
export function imageInlineMarkdown(attrs: ImageAttrs): string {
  if (attrs.file) {
    const props: Record<string, string> = { file: attrs.file }
    if (attrs.alt) props.alt = attrs.alt
    return `:image{${serializeMdcProps(props)}}`
  }
  const title = attrs.title ? ` "${attrs.title}"` : ''
  return `![${attrs.alt ?? ''}](${attrs.src ?? ''}${title})`
}

/**
 * The editor's Image node — UEditor's @tiptap/extension-image (block-level)
 * extended with a `file` attribute carrying a page file UUID, and a
 * markdown grammar that serializes one node two ways:
 *
 * - `file` set   → `::image{file="<uuid>" alt="…"}` + close fence on the
 *   next line — a childless MDC fence naming a file in `field_kb_images`
 *   (ADR 0020). The close is mandatory in the canonical form: comark treats
 *   an unclosed fence as an open container and swallows every following
 *   block into it. The render URL is resolved at render time and never
 *   enters the stored markdown; `src` is a display value only.
 * - `file` unset → stock `![alt](src "title")` for plain/external URLs.
 *
 * Both directions of the fence grammar are registered here so the marked
 * lexer, the live editor, the headless commit schema and the round-trip
 * corpus share one definition. Native `![…](…)` tokens (marked's inline
 * rule) and `::image` fence tokens both arrive as type `image`; the parse
 * handler branches on the token shape.
 *
 * Vue-free — the live preview NodeView is layered on in
 * app/editor/extensions.ts, exactly like Callout / Infobox.
 */
export const OkbImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      file: { default: null },
      // Block id carried through the fence round-trip (OKB-137), as callout
      // and infobox carry theirs — the review gate needs every producible
      // block identified.
      id: { default: null },
    }
  },

  parseHTML() {
    return [
      { tag: 'img[src]:not([src^="data:"])' },
      {
        tag: 'custom-image',
        getAttrs: (element: HTMLElement) => ({
          file: element.getAttribute('file'),
          alt: element.getAttribute('alt'),
          src: element.getAttribute('src'),
        }),
      },
    ]
  },

  markdownTokenizer: {
    name: 'image',
    level: 'block',
    start(src: string) {
      const index = src.match(/^:{2,}image\{/m)?.index
      return index !== undefined ? index : -1
    },
    tokenize(src) {
      // Childless fence: props on the open line, close fence (the opener's
      // colon count alone) on the next. A missing close (hand-written,
      // end-of-document) still tokenizes — comark would swallow following
      // blocks into an unclosed fence, but re-serializing immediately
      // restores the canonical closed form.
      const match = src.match(BLOCK_FENCE)
      if (!match) return undefined
      return {
        type: 'image',
        raw: match[0],
        attributes: parseMdcProps(match[2] ?? ''),
      }
    },
  },

  parseMarkdown(token, helpers) {
    const attributes = (token as { attributes?: Record<string, string> }).attributes
    if (attributes) {
      return helpers.createNode('image', {
        file: attributes.file ?? null,
        alt: attributes.alt ?? '',
        src: null,
        title: null,
        id: attributes.id ?? null,
      })
    }
    // marked's native inline `![alt](src "title")` token.
    const inline = token as { href?: string, title?: string | null, text?: string }
    return helpers.createNode('image', {
      src: inline.href ?? '',
      title: inline.title ?? null,
      alt: inline.text ?? '',
      file: null,
    })
  },

  renderMarkdown(node: JSONContent) {
    const attrs = (node.attrs ?? {}) as ImageAttrs
    if (attrs.file) {
      const props: Record<string, string> = { file: attrs.file }
      if (attrs.alt) props.alt = attrs.alt
      if (attrs.id) props.id = attrs.id
      return `::image{${serializeMdcProps(props)}}\n::`
    }
    const alt = attrs.alt ?? ''
    const src = attrs.src ?? ''
    // No fence to hang props on: the id trails the line, as prose ids do.
    const id = attrs.id ? ` {#${attrs.id}}` : ''
    return (attrs.title ? `![${alt}](${src} "${attrs.title}")` : `![${alt}](${src})`) + id
  },
})

/**
 * Inline `:image{file="…" alt="…"}` tokenizer (comark's inline component
 * form — what {@link imageInlineMarkdown} emits inside table cells). No
 * schema contribution; the token parses into the same block-level image
 * node, which the engine's paragraph-splitting normalization hoists out
 * of running text (accepted transform, like inline `![…]`) and the table
 * cell serializer renders back inline.
 */
export const OkbImageInline = Extension.create({
  name: 'imageInline',
  markdownTokenName: 'imageInline',
  markdownTokenizer: {
    name: 'imageInline',
    level: 'inline',
    start(src: string) {
      return src.indexOf(':image{')
    },
    tokenize(src: string) {
      // A block fence's `::image` must not match — require a non-colon
      // before nothing (start of inline run handles it: marked only hands
      // over at the reported start index, which sits ON the first colon).
      const match = src.match(INLINE_FENCE)
      if (!match) return undefined
      return {
        type: 'imageInline',
        raw: match[0],
        attributes: parseMdcProps(match[1] ?? ''),
      }
    },
  },
  parseMarkdown(token, helpers) {
    const attributes = (token as { attributes?: Record<string, string> }).attributes ?? {}
    return helpers.createNode('image', {
      file: attributes.file ?? null,
      alt: attributes.alt ?? '',
      src: null,
      title: null,
    })
  },
})
