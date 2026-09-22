/**
 * Shared @tiptap/markdown pieces for comark MDC block components
 * (::callout / ::infobox): fence tokenizer, prop parsing/serialization,
 * and the canonical fence renderer.
 *
 * Grammar (matches comark and the corpus fixtures byte-for-byte):
 *
 * - Open fence: N colons (N >= 2) + name + optional `{key="val" …}` props,
 *   no space before the brace: `::callout{type="info"}`.
 * - Close fence: exactly N colons alone on a line, tight after the last
 *   content block (no blank line).
 * - Nesting: an outer fence has MORE colons than every fence nested inside
 *   it — comark matches the close by the opener's length. On render the
 *   fence length is one more than the deepest nested fence (minimum 2).
 * - Prop values are double-quoted, single-quoted or unquoted (a run up to
 *   the next space or closing brace) — comark accepts all three. The
 *   matching quote inside a value is escaped with a backslash. Output is
 *   always double-quoted: the other two forms converge on save.
 * - A block id renders as the `#id` shorthand, placed last — comark's
 *   canonical position (`{type="info" #b-c9f0}`).
 */
import type {
  JSONContent,
  MarkdownParseHelpers,
  MarkdownRendererHelpers,
  MarkdownToken,
  MarkdownTokenizer,
} from '@tiptap/core'

// Fence-serialized nodes an outer fence must out-length (comark matches a
// close by the opener's colon count). The image fence is always length 2
// (childless — see ./image.ts); callout/infobox/blockWrapper grow past
// their content.
const FENCE_NODES = new Set(['callout', 'infobox', 'image', 'blockWrapper'])

/**
 * Parses MDC props and the `#id` shorthand.
 *
 * Values take any of comark's three forms — `key="val"`, `key='val'`,
 * `key=val` — because an author writing the unquoted form in source must
 * not have the value silently swallowed by the node's schema default.
 * A backslash-escaped quote of the enclosing kind unescapes to itself.
 */
export function parseMdcProps(propString: string): Record<string, string> {
  const props: Record<string, string> = {}
  const propRe = /([a-zA-Z][\w-]*)=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s'"=<>`}]+))|#([\w-]+)/g
  for (const match of propString.matchAll(propRe)) {
    if (match[5] !== undefined) {
      props.id = match[5]
    }
    else if (match[2] !== undefined) {
      props[match[1]!] = match[2].replace(/\\"/g, '"')
    }
    else if (match[3] !== undefined) {
      props[match[1]!] = match[3].replace(/\\'/g, "'")
    }
    else {
      props[match[1]!] = match[4]!
    }
  }
  return props
}

/**
 * Serializes props as `key="val"` pairs; `"` in values escapes to `\"`.
 * `id` renders as the `#id` shorthand, last; an id with characters outside
 * `[\w-]` can't round-trip through the shorthand, so it falls back to an
 * explicit `id="…"` prop (still last).
 */
export function serializeMdcProps(props: Record<string, string>): string {
  const { id, ...rest } = props
  const idPart = id !== undefined && id !== ''
    ? [/^[\w-]+$/.test(id) ? `#${id}` : `id="${id.replace(/"/g, '\\"')}"`]
    : []
  return Object.entries(rest)
    .map(([key, value]) => `${key}="${value.replace(/"/g, '\\"')}"`)
    .concat(idPart)
    .join(' ')
}

/**
 * Block tokenizer for one MDC fence component. The token carries the
 * nested block tokens (recursed via `lexer.blockTokens`), so nested
 * fences of other component types tokenize through their own tokenizers.
 */
export function mdcFenceTokenizer(name: string): MarkdownTokenizer {
  const openRe = new RegExp(`^(:{2,})${name}(?:\\{([^}]*)\\})?[ \\t]*(?:\\n|$)`)
  return {
    name,
    level: 'block',
    start(src: string) {
      const index = src.match(new RegExp(`^:{2,}${name}(?:\\{|[ \\t]*$)`, 'm'))?.index
      return index !== undefined ? index : -1
    },
    tokenize(src, _tokens, lexer) {
      const open = src.match(openRe)
      if (!open) return undefined
      const fence = open[1]!
      const rest = src.slice(open[0].length)
      // The close is the first line holding exactly the opener's colon
      // count — inner fences are strictly shorter, so they never match.
      const close = rest.match(new RegExp(`^:{${fence.length}}(?!:)[ \\t]*$`, 'm'))
      if (close?.index === undefined) return undefined
      const rawContent = rest.slice(0, close.index)
      const contentTokens = lexer.blockTokens(rawContent.replace(/\n$/, ''))
      for (const token of contentTokens) {
        if (token.text && (!token.tokens || token.tokens.length === 0)) {
          token.tokens = lexer.inlineTokens(token.text)
        }
      }
      const closeEnd = close.index + close[0].length
      return {
        type: name,
        raw: open[0] + rest.slice(0, closeEnd),
        attributes: parseMdcProps(open[2] ?? ''),
        tokens: contentTokens,
      }
    },
  }
}

/** Parse handler shared by every fence component. */
export function parseMdcFence(
  name: string,
  defaults: Record<string, string>,
): (token: MarkdownToken, helpers: MarkdownParseHelpers) => JSONContent {
  return (token, helpers) => ({
    type: name,
    attrs: { ...defaults, ...(token as { attributes?: Record<string, string> }).attributes },
    content: helpers.parseChildren(token.tokens ?? []),
  })
}

/**
 * Canonical fence renderer: fence length one more than the deepest nested
 * fence (minimum 2), props tight after the name, close fence tight after
 * the content.
 */
export function renderMdcFence(
  name: string,
  node: JSONContent,
  helpers: MarkdownRendererHelpers,
  props: Record<string, string>,
): string {
  const fence = ':'.repeat(fenceMarkerCount(node))
  const propString = Object.keys(props).length > 0 ? `{${serializeMdcProps(props)}}` : ''
  const content = helpers.renderChildren(node.content ?? [], '\n\n')
  return `${fence}${name}${propString}\n${content.replace(/\n+$/, '')}\n${fence}`
}

function fenceMarkerCount(node: JSONContent): number {
  return maxNestedMarkerCount(node) + 1
}

function maxNestedMarkerCount(node: JSONContent): number {
  let max = 1
  for (const child of node.content ?? []) {
    const contribution = FENCE_NODES.has(child.type ?? '')
      ? fenceMarkerCount(child)
      : maxNestedMarkerCount(child)
    if (contribution > max) max = contribution
  }
  return max
}
