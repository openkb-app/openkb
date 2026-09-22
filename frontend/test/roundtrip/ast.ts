/**
 * S3 support: comark AST normalization.
 *
 * `normalizedAst(md)` parses markdown with comark and reduces the tree to
 * a canonical semantic form. Two documents whose normalized ASTs are
 * deep-equal carry the same content modulo the accepted transforms in
 * NORMALIZATIONS.md. The normalizer encodes exactly those transforms —
 * anything else (a dropped paragraph, lost checkbox state, a destroyed
 * table) still diverges and fails the comparison.
 */
import { parseMarkdown } from 'comark'
import { dataImages } from '#shared/utils/comark-tree'

type ComarkProps = Record<string, unknown>
type ComarkNode = string | [tag: string, props: ComarkProps, ...children: ComarkNode[]]

/**
 * Presentation-only props (see NORMALIZATIONS.md): comark metadata, auto
 * slugs, styling classes, table-alignment styles.
 */
const DROP_PROPS = new Set(['$', 'class', 'id', 'disabled', 'style'])

/**
 * Inline raw-HTML tags outside the editor schema. The editor keeps their
 * text but drops the tag (accepted normalization), so the normalizer
 * unwraps them on both sides.
 */
const INLINE_HTML_UNWRAP = new Set(['kbd', 'abbr', 'ins', 'sub', 'sup', 'mark', 'span'])

export async function normalizedAst(markdown: string): Promise<unknown[]> {
  const tree = await parseMarkdown(markdown, { plugins: [dataImages] })
  return normalizeChildren(tree.nodes as ComarkNode[], false)
}

function normalizeChildren(nodes: ComarkNode[], pre: boolean): unknown[] {
  const out: unknown[] = []
  for (const node of nodes) {
    for (const normalized of normalizeNode(node, pre)) {
      // Merge adjacent text runs (tag unwrapping splits them).
      if (typeof normalized === 'string' && typeof out[out.length - 1] === 'string') {
        out[out.length - 1] = (out[out.length - 1] as string) + normalized
      }
      else {
        out.push(normalized)
      }
    }
  }
  // Collapse + trim text at element edges; drop what becomes empty.
  return out
    .map((n, i) => {
      if (typeof n !== 'string' || pre) return n
      let s = n.replace(/\s+/g, ' ')
      if (i === 0) s = s.replace(/^ /, '')
      if (i === out.length - 1) s = s.replace(/ $/, '')
      return s
    })
    .filter(n => n !== '')
}

function normalizeNode(node: ComarkNode, pre: boolean): unknown[] {
  if (typeof node === 'string') return [node]

  const [tag, props, ...children] = node
  const meta = props?.['$'] as { block?: number } | undefined

  // Raw block-level HTML: the editor drops the node (no schema node for
  // it) — accepted as lossy, so the normalizer drops it on the comark
  // side too and it is invisible to S3.
  if (meta?.block === 1) return []

  if (INLINE_HTML_UNWRAP.has(tag)) {
    return normalizeChildren(children, pre)
  }

  // Task-list checkbox: only the checked state is semantic.
  if (tag === 'input') {
    const checked = props?.[':checked'] === 'true' || props?.checked === true
    return [['input', { checked }]]
  }

  const keptProps: Record<string, string> = {}
  for (const [k, v] of Object.entries(props ?? {})) {
    if (DROP_PROPS.has(k) || v === undefined || v === null || v === false) continue
    keptProps[k.startsWith(':') ? k.slice(1) : k] = String(v)
  }

  const inPre = pre || tag === 'pre' || tag === 'code'
  return [[tag, keptProps, ...normalizeChildren(children, inPre)]]
}
