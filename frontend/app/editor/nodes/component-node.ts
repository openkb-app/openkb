import { Node, mergeAttributes } from '@tiptap/core'
import type { Attributes } from '@tiptap/core'
import { defaultAttributeOfProp, readStoredPropValue } from '#shared/utils/comark-components'
import type { ComarkComponentDeclaration } from '#shared/utils/comark-components'

/**
 * The node of a block component (ADR 0025): its stored props are the
 * attributes, its default slot the content; without a slot it is an atom.
 *
 * The clipboard shape is `<custom-<tag> prop="…">`, so a block survives a
 * copy-paste inside the editor; the read page renders the component's own
 * markup, and a paste from there keeps the words only. The block id is not
 * copied: a pasted block gets a new one.
 *
 * Vue-free: `server/utils/editor-schema.ts` builds the commit schema from the
 * same call. The node view is added in `app/editor/extensions.ts`.
 */
export function createComponentNode(declaration: ComarkComponentDeclaration) {
  const clipboardTag = `custom-${declaration.tag}`
  return Node.create({
    name: declaration.tag,
    group: 'block',
    ...(declaration.slot ? { content: 'block+', defining: true } : { atom: true, draggable: true }),

    /** The stored props, read and written as attributes of the clipboard element, and the block id. */
    addAttributes() {
      const attributes: Attributes = {}
      for (const [name, prop] of Object.entries(declaration.props)) {
        attributes[name] = {
          default: defaultAttributeOfProp(prop),
          parseHTML: (element: HTMLElement) => readStoredPropValue(prop, element.getAttribute(name) ?? undefined),
          renderHTML: (attrs: Record<string, unknown>) => attrs[name] === null || attrs[name] === '' ? {} : { [name]: String(attrs[name]) },
        }
      }
      attributes.id = { default: null, parseHTML: () => null, renderHTML: () => ({}) }
      return attributes
    },

    /** Reads the editor's own clipboard element. */
    parseHTML() {
      return [{ tag: clipboardTag }]
    },

    /** Writes the clipboard element, the body inside it. */
    renderHTML({ HTMLAttributes }) {
      return declaration.slot ? [clipboardTag, HTMLAttributes, 0] : [clipboardTag, HTMLAttributes]
    },
  })
}

/** How a chip sits in the editor's DOM and document. */
export interface ChipForm {
  /** The ProseMirror node name. */
  node: string
  /** The element's `data-type`. */
  dataType: string
  /** The class the read component's root carries too. */
  className: string
}

/**
 * The chips with node names and DOM of their own, which stored documents and
 * the specs read. A new chip takes {@link chipFormOf}'s defaults.
 */
const STORED_CHIP_FORMS: Record<string, ChipForm> = {
  doc: { node: 'docLink', dataType: 'doc-link', className: 'okb-doc-link' },
  citation: { node: 'citation', dataType: 'citation', className: 'okb-cite' },
}

/** The DOM and node name of a chip. */
export function chipFormOf(tag: string): ChipForm {
  return STORED_CHIP_FORMS[tag] ?? { node: tag, dataType: tag, className: `okb-${tag}` }
}

/** The chip's element: its class, `data-type`, one `data-<prop>` per set stored prop, and its label. */
export function renderChipElement(declaration: ComarkComponentDeclaration, attrs: Record<string, unknown>): [string, Record<string, string>, ...string[]] {
  const form = chipFormOf(declaration.tag)
  const data = Object.fromEntries(Object.keys(declaration.props)
    .filter(name => attrs[name] !== null && attrs[name] !== undefined && attrs[name] !== '')
    .map(name => [`data-${name}`, String(attrs[name])]))
  const element: [string, Record<string, string>, ...string[]] = ['span', mergeAttributes({ 'data-type': form.dataType }, data, { class: form.className })]
  if (declaration.slot) element.push(String(attrs.label ?? ''))
  return element
}

/**
 * The node of a chip (ADR 0026): an inline atom drawn as native DOM, its
 * stored props as attributes and, with a slot, its words as `label`. The same
 * element is the clipboard shape; a read component's root that carries the
 * stored props matches it, so a paste from the read page keeps the chip.
 */
export function createChipNode(declaration: ComarkComponentDeclaration) {
  const form = chipFormOf(declaration.tag)
  return Node.create({
    name: form.node,
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,
    draggable: false,

    /** The stored props and the label. */
    addAttributes() {
      const attributes: Attributes = {}
      for (const [name, prop] of Object.entries(declaration.props)) {
        attributes[name] = { default: defaultAttributeOfProp(prop) }
      }
      if (declaration.slot) attributes.label = { default: '' }
      return attributes
    },

    /**
     * Reads the chip element by its type or its class; it outranks the link
     * mark's `a[href]`. An element with no stored prop is no chip: the read
     * page's citation carries none, so its link mark takes it.
     */
    parseHTML() {
      const getAttrs = (element: HTMLElement) => Object.keys(declaration.props).some(name => element.hasAttribute(`data-${name}`)) && ({
        ...Object.fromEntries(Object.entries(declaration.props).map(([name, prop]) =>
          [name, readStoredPropValue(prop, element.getAttribute(`data-${name}`) ?? undefined)])),
        ...(declaration.slot ? { label: element.textContent ?? '' } : {}),
      })
      return [
        { tag: `[data-type="${form.dataType}"]`, priority: 100, getAttrs },
        { tag: `.${form.className}`, priority: 100, getAttrs },
      ]
    },

    /** Draws the chip element. */
    renderHTML({ node }) {
      return renderChipElement(declaration, node.attrs)
    },

    /** The chip's words as plain text. */
    renderText({ node }) {
      return declaration.slot ? String(node.attrs.label ?? '') : ''
    },
  })
}
