/**
 * Comark components: a `::name{…}` fence or `:name[…]{…}` chip that renders as
 * the Vue component `<Name>.vue` in `app/components/comark/` (chips in its
 * `inline/` folder), on the read page, in chat answers and in the editor.
 *
 * The build (`modules/comark-components/`) reads each component's `defineProps`,
 * slots and `defineComarkComponent()` call into a {@link ComarkComponentDeclaration}
 * (ADR 0025). This file holds the types and the runtime helpers.
 * See docs/comark-components.md.
 */
import type { AnyExtension } from '@tiptap/core'
import type { Component } from 'vue'
import { comarkComponentDeclarations as generatedDeclarations } from '#okb-comark-components'

/** The kinds a stored prop may have. */
export type ComarkPropKind = 'string' | 'enum' | 'number' | 'boolean'

/** The editor-facing metadata of one prop, from `defineComarkComponent()`. */
export interface ComarkPropMeta<T = unknown> {
  /** The settings menu's field label. */
  label?: string
  /** The value the prop starts with when the component is inserted. */
  example?: string | number | boolean
  /** A label per enum value. */
  enumLabels?: Partial<Record<Extract<NonNullable<T>, string>, string>>
  /** An icon per enum value, shown beside its label. */
  enumIcons?: Partial<Record<Extract<NonNullable<T>, string>, string>>
}

/**
 * The argument of `defineComarkComponent()`: a component's editor-facing
 * metadata. `P` is the component's `Props`.
 */
export interface ComarkComponentMeta<P = Record<string, unknown>> {
  /** The slash-menu label; the tag in words without it. */
  label?: string
  description?: string
  icon?: string
  /** The body text a component with a slot is inserted with. */
  placeholder?: string
  props?: { [K in keyof P]?: ComarkPropMeta<P[K]> }
}

/** One stored prop: an attribute of the markdown and of the editor node, with its editor metadata. */
export interface ComarkPropDeclaration extends ComarkPropMeta<string> {
  kind: ComarkPropKind
  /** The enum's values. */
  values?: string[]
  default?: string | number | boolean
  /** The prop carries the JSDoc tag `@notIndexed`: its value stays out of the search index. */
  notIndexed?: true
  enumLabels?: Record<string, string>
  enumIcons?: Record<string, string>
}

/** What the build reads off one `<Name>.vue`. */
export interface ComarkComponentDeclaration extends Omit<ComarkComponentMeta, 'props'> {
  /** The comark tag, e.g. `callout`. */
  tag: string
  /** The stored props, by name. */
  props: Record<string, ComarkPropDeclaration>
  /** Whether the component has a default slot: the body of a block, the label of a chip. */
  slot: boolean
  /** The text props the component renders in a slot of the same name: the editor edits them in place. */
  propsEditedInPlace: string[]
  /** Whether it is a chip in running text (`components/comark/inline/`). */
  inline: boolean
}

/** What a `<Name>.editor.ts` default-exports: the component's editor code. */
export interface ComarkEditorPart {
  /** `false` keeps the component out of the slash menu, for one inserted by another command. */
  menu?: false
  /**
   * The component's own settings menu, rendered in place of the default one.
   * Props: `declaration`, `menuProps` (the stored props less those edited in
   * place), `values`; it emits `change(name, value)`.
   */
  settingsMenu?: Component
  /** The component's own node view, rendered in place of the generic one. */
  nodeView?: Component
  /** Further editor extensions the component needs. */
  extensions?: AnyExtension[]
}

/** The meta of the transaction that inserts a block component from the menu: a one-time hint to its node view. */
export const insertedComponentMeta = 'okbInsertedComponent'

/** Every comark component's declaration, by tag. */
export const comarkComponentDeclarations: Record<string, ComarkComponentDeclaration> = generatedDeclarations

/** Types a `<Name>.editor.ts` default export. */
export function defineComarkEditorPart(part: ComarkEditorPart): ComarkEditorPart {
  return part
}

/** The block components, chips left out. */
export function listBlockComponentDeclarations(): ComarkComponentDeclaration[] {
  return Object.values(comarkComponentDeclarations).filter(declaration => !declaration.inline)
}

/** The chips. */
export function listChipComponentDeclarations(): ComarkComponentDeclaration[] {
  return Object.values(comarkComponentDeclarations).filter(declaration => declaration.inline)
}

/** A tag or enum value in the editor's words: `callout` → `Callout`, `doc-link` → `Doc link`. */
export function labelOfComarkName(tag: string): string {
  return `${tag.charAt(0).toUpperCase()}${tag.slice(1).replace(/-/g, ' ')}`
}

/** A component's label: its declared one, or its tag in words. */
export function labelOfComarkComponent(declaration: ComarkComponentDeclaration): string {
  return declaration.label ?? labelOfComarkName(declaration.tag)
}

/** A prop's label: its declared one, or its name in words. */
export function labelOfComarkProp(name: string, prop: ComarkPropDeclaration): string {
  return prop.label ?? labelOfComarkName(name)
}

/** The select items of an enum prop: each value with its label and icon. */
export function listEnumItemsOfComarkProp(prop: ComarkPropDeclaration): { label: string, value: string, icon?: string }[] {
  return (prop.values ?? []).map(value => ({
    label: prop.enumLabels?.[value] ?? labelOfComarkName(value),
    value,
    ...(prop.enumIcons?.[value] ? { icon: prop.enumIcons[value] } : {}),
  }))
}

/** A stored prop's default as a node attribute: the declared default, or null. */
export function defaultAttributeOfProp(prop: ComarkPropDeclaration): string | number | boolean | null {
  return prop.default ?? null
}

/** Reads one stored prop off a markdown or HTML attribute value; a value outside an enum is its default. */
export function readStoredPropValue(prop: ComarkPropDeclaration, value: unknown): string | number | boolean | null {
  if (value === undefined || value === null) return defaultAttributeOfProp(prop)
  switch (prop.kind) {
    case 'enum':
      return prop.values?.includes(String(value)) ? String(value) : defaultAttributeOfProp(prop)
    case 'number': {
      const number = Number(value)
      return Number.isFinite(number) && String(value) !== '' ? number : defaultAttributeOfProp(prop)
    }
    case 'boolean':
      return value === true || value === 'true' || value === ''
    default:
      return typeof value === 'string' ? value : String(value)
  }
}

/**
 * A component's props with its boolean props read off comark's form: comark
 * parses a bare `open` as the binding `:open="true"` and writes it back so.
 */
export function readBooleanPropBindings<T extends Record<string, unknown>>(declaration: ComarkComponentDeclaration, props: T): T {
  const read: Record<string, unknown> = { ...props }
  for (const [name, prop] of Object.entries(declaration.props)) {
    if (prop.kind !== 'boolean' || !Object.hasOwn(read, `:${name}`)) continue
    read[name] = read[`:${name}`] === 'true'
    delete read[`:${name}`]
  }
  return read as T
}

/** The node attributes of a component's stored props, read off its markdown props. */
export function readNodeAttributesFromProps(declaration: ComarkComponentDeclaration, props: Record<string, unknown>): Record<string, unknown> {
  const read = readBooleanPropBindings(declaration, props)
  return Object.fromEntries(Object.entries(declaration.props).map(([name, prop]) => [name, readStoredPropValue(prop, read[name])]))
}

/**
 * The markdown props of a component's node attributes, as comark writes them:
 * unset, empty and false values are not written, a true boolean is the
 * binding `:name="true"` comark writes as a bare `name`.
 */
export function writePropsFromNodeAttributes(declaration: ComarkComponentDeclaration, attrs: Record<string, unknown>): Record<string, string | number> {
  return Object.fromEntries(Object.keys(declaration.props)
    .map(name => [name, attrs[name]] as const)
    .filter((entry): entry is readonly [string, string | number | true] => entry[1] !== null && entry[1] !== undefined && entry[1] !== '' && entry[1] !== false)
    .map(([name, value]) => value === true ? [`:${name}`, 'true'] : [name, value]))
}
