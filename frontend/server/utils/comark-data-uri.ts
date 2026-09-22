/**
 * Percent-encodes a `data:` image payload a write was handed as characters. A
 * CommonMark destination carries no space, `<` or unbalanced `)`, so an
 * unescaped payload would not parse and its bytes would be dropped. A payload
 * that is already base64 or encoded passes through byte-for-byte.
 */
import { createError } from 'h3'
import { mapOutsideCode } from './comark-entities'

/** `](` opening a `data:image/` destination, through the media type's comma. */
const DATA_IMAGE_DEST = /\]\(data:image\/[^\s(),]*,/gi

/** One tag of a markup payload; `>` inside a quoted attribute is not its end. */
const TAG = /<(\/?)[A-Za-z][^\s/>]*((?:"[^"]*"|'[^']*'|[^>"'])*)>/g

/**
 * What a link destination and the URL parser both carry unescaped. `%` is kept
 * only where it already opens an escape, so an encoded payload is left alone.
 */
const NEEDS_ESCAPE = /%(?![0-9A-Fa-f]{2})|[^A-Za-z0-9\-._~!$&'*+,;=:@/%]/gu

/** Percent-encodes `data:` image payloads outside code. */
export function encodeDataImageUris(markdown: string): string {
  return mapOutsideCode(markdown, encodePayloads)
}

function encodePayloads(text: string): string {
  let out = ''
  let at = 0
  for (const match of text.matchAll(DATA_IMAGE_DEST)) {
    if (match.index < at) continue
    const from = match.index + match[0].length
    const end = destinationEnd(text, from)
    if (end === undefined) throw unclosedDestination()
    out += text.slice(at, from) + escapePayload(text.slice(from, end))
    at = end
  }
  return out + text.slice(at)
}

/**
 * Where the destination opened at `from - 1` closes. A markup payload carries
 * parentheses of its own, so there the end is the `)` right after the payload's
 * own root element; elsewhere it is the `)` that balances the opener. Undefined
 * if none closes it on its line.
 */
function destinationEnd(text: string, from: number): number | undefined {
  const breaks = text.indexOf('\n', from)
  const line = text.slice(from, breaks === -1 ? text.length : breaks)
  return line.startsWith('<') ? markupEnd(line, from) : balancedEnd(line, from)
}

function markupEnd(line: string, from: number): number | undefined {
  const root = rootElementEnd(line)
  return root !== undefined && line[root] === ')' ? from + root : undefined
}

/** Past the payload's root element: its `/>`, or the tag closing it. */
function rootElementEnd(line: string): number | undefined {
  let depth = 0
  for (const tag of line.matchAll(TAG)) {
    if (tag[1]) depth--
    else if (!tag[2].endsWith('/')) depth++
    if (depth <= 0) return tag.index + tag[0].length
  }
  return undefined
}

function balancedEnd(line: string, from: number): number | undefined {
  let depth = 1
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '(') depth++
    else if (line[i] === ')' && --depth === 0) return from + i
  }
  return undefined
}

function unclosedDestination() {
  return createError({
    statusCode: 422,
    statusMessage:
      'A data: image destination does not close after its payload. '
      + 'Percent-encode or base64 the payload.',
  })
}

function escapePayload(payload: string): string {
  return payload.replace(NEEDS_ESCAPE, utf8Escapes)
}

function utf8Escapes(char: string): string {
  return [...new TextEncoder().encode(char)]
    .map(byte => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
    .join('')
}
