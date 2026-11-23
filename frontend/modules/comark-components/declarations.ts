/**
 * The comark component declarations: the component files of every layer, their
 * props and slots read with vue-component-meta, the macro's argument merged in,
 * and the generated `#okb-comark-*` modules.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createCheckerByJson } from 'vue-component-meta'
import type { ComponentMeta, PropertyMeta } from 'vue-component-meta'
import type { ComarkComponentDeclaration, ComarkComponentMeta, ComarkPropDeclaration, ComarkPropMeta } from '../../shared/utils/comark-components.ts'
import { COMARK_COMPONENT_MACRO, readComarkComponentMacro } from './macro.ts'

/** One comark component file found in a layer: its tag, file and whether it is a chip. */
export interface ComarkComponentFile {
  tag: string
  file: string
  inline: boolean
  editorFile: string | null
}

/** Turns `DocLink.vue` into the comark tag `doc-link`. */
export function comarkTagOfComponentFile(file: string): string {
  return basename(file, '.vue').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/**
 * The `<Name>.vue` files under `<srcDir>/components/comark/` of every layer,
 * and under its `inline/` folder for chips; a file with a second dot
 * (`.editor.vue`) is not one. The first layer wins on a shared tag;
 * a block and a chip of the same name in one layer fail.
 */
export function collectComarkComponentFiles(srcDirs: string[]): ComarkComponentFile[] {
  const files = new Map<string, ComarkComponentFile>()
  for (const srcDir of srcDirs) {
    const layer = new Map<string, ComarkComponentFile>()
    for (const [dir, inline] of [[join(srcDir, 'components/comark'), false], [join(srcDir, 'components/comark/inline'), true]] as const) {
      if (!existsSync(dir)) {
        continue
      }
      for (const name of readdirSync(dir).filter(name => /^[A-Z]\w*\.vue$/.test(name)).sort()) {
        const tag = comarkTagOfComponentFile(name)
        const clash = layer.get(tag)
        if (clash) {
          throw new Error(`${join(dir, name)}: the tag "${tag}" is taken by ${clash.file}; a component's name is unique across components/comark/ and its inline/ folder`)
        }
        const editorFile = join(dir, name.replace(/\.vue$/, '.editor.ts'))
        layer.set(tag, { tag, file: join(dir, name), inline, editorFile: existsSync(editorFile) ? editorFile : null })
      }
    }
    for (const [tag, entry] of layer) {
      if (!files.has(tag)) {
        files.set(tag, entry)
      }
    }
  }
  return [...files.values()]
}

/** The JSON value of a prop default as vue-component-meta prints it, or undefined for an expression. */
function parsePropDefault(value: string | undefined): string | number | boolean | undefined {
  if (value === undefined) {
    return undefined
  }
  try {
    const parsed = JSON.parse(value.replace(/^'(.*)'$/, '"$1"'))
    return ['string', 'number', 'boolean'].includes(typeof parsed) ? parsed : undefined
  }
  catch {
    return undefined
  }
}

/** Maps one stored prop's type onto a supported kind; throws, naming component and prop, on any other type. */
export function declarePropOfComponent(component: string, prop: PropertyMeta): ComarkPropDeclaration {
  const schema = prop.schema
  const options = (typeof schema === 'string' ? [schema] : schema.kind === 'enum' ? schema.schema ?? [] : [schema])
    .filter(option => option !== 'undefined')
  const declaration: ComarkPropDeclaration = { kind: 'string' }
  const fallback = parsePropDefault(prop.default)
  if (fallback !== undefined) {
    declaration.default = fallback
  }
  if (prop.tags.some(tag => tag.name === 'notIndexed')) {
    declaration.notIndexed = true
  }
  if (options.length > 0 && options.every(option => typeof option === 'string' && /^".*"$/.test(option))) {
    return { ...declaration, kind: 'enum', values: options.map(option => JSON.parse(option as string) as string) }
  }
  if (options.length === 1 && (options[0] === 'string' || options[0] === 'number')) {
    return { ...declaration, kind: options[0] }
  }
  if (options.length === 2 && options.includes('true') && options.includes('false')) {
    return { ...declaration, kind: 'boolean' }
  }
  if (options.length === 1 && options[0] === 'boolean') {
    return { ...declaration, kind: 'boolean' }
  }
  throw new Error(`${component}: prop "${prop.name}" has type ${prop.type}; a stored prop is a string, an enum, a number or a boolean (mark a prop the server fills with @render)`)
}

/** The keys the macro's argument takes. */
const COMPONENT_META_KEYS: string[] = ['label', 'description', 'icon', 'placeholder', 'props'] satisfies (keyof ComarkComponentMeta)[]

/** The keys each prop's metadata takes. */
const PROP_META_KEYS: string[] = ['label', 'example', 'enumLabels', 'enumIcons'] satisfies (keyof ComarkPropMeta)[]

/**
 * Throws, naming the component, on a key the macro does not take: on the
 * argument, a prop that is not stored, or on a prop's metadata.
 * No type check runs over the SFCs, so this is what catches a misspelt key.
 */
function assertKnownMacroKeys(component: string, macro: ComarkComponentMeta, props: Record<string, ComarkPropDeclaration>): void {
  const unknownKeys = Object.keys(macro).filter(key => !COMPONENT_META_KEYS.includes(key))
  for (const [name, meta] of Object.entries(macro.props ?? {})) {
    if (!props[name]) {
      unknownKeys.push(`props.${name}`)
      continue
    }
    const unknownPropKeys = Object.keys(meta).filter(key => !PROP_META_KEYS.includes(key))
    unknownKeys.push(...unknownPropKeys.map(key => `props.${name}.${key}`))
  }
  if (unknownKeys.length > 0) {
    throw new Error(`${component}: ${COMARK_COMPONENT_MACRO}() has the unknown key "${unknownKeys[0]}"; it takes ${COMPONENT_META_KEYS.join(', ')}, and ${PROP_META_KEYS.join(', ')} per stored prop`)
  }
}

/**
 * Builds a component's declaration from what vue-component-meta read off its
 * `defineProps` and slots, and from its `defineComarkComponent()` argument.
 */
export function declareComarkComponent(entry: ComarkComponentFile, meta: ComponentMeta, macro: ComarkComponentMeta | null = null): ComarkComponentDeclaration {
  const component = basename(entry.file, '.vue')
  const declaration: ComarkComponentDeclaration = {
    tag: entry.tag,
    props: {},
    slot: meta.slots.some(slot => slot.name === 'default'),
    propsEditedInPlace: [],
    inline: entry.inline,
  }
  for (const prop of meta.props.filter(prop => !prop.global && !prop.tags.some(tag => tag.name === 'render'))) {
    declaration.props[prop.name] = declarePropOfComponent(component, prop)
  }
  declaration.propsEditedInPlace = meta.slots
    .map(slot => slot.name)
    .filter(name => declaration.props[name]?.kind === 'string')
  if (!macro) {
    return declaration
  }

  assertKnownMacroKeys(component, macro, declaration.props)
  const { props: propsMeta, ...componentMeta } = macro
  Object.assign(declaration, componentMeta)
  for (const [name, propMeta] of Object.entries(propsMeta ?? {})) {
    declaration.props[name] = { ...declaration.props[name]!, ...propMeta } as ComarkPropDeclaration
  }
  return declaration
}

/**
 * Reads the declarations of the given component files with vue-component-meta.
 * `rootDir` is the app root: its `node_modules` and `shared/` resolve the
 * props' types.
 */
export function readComarkComponentDeclarations(rootDir: string, entries: ComarkComponentFile[]): ComarkComponentDeclaration[] {
  const checker = createCheckerByJson(rootDir, {
    include: entries.map(entry => entry.file),
    compilerOptions: {
      strict: true,
      module: 'ESNext',
      moduleResolution: 'Bundler',
      target: 'ESNext',
      jsx: 'preserve',
      skipLibCheck: true,
      paths: {
        '#shared': ['./shared'],
        '#shared/*': ['./shared/*'],
        '~/*': ['./app/*'],
        '~~/*': ['./*'],
      },
    },
  }, { schema: true, noDeclarations: true })
  return entries.map((entry) => {
    const macro = readComarkComponentMacro(readFileSync(entry.file, 'utf8'), entry.file)
    return declareComarkComponent(entry, checker.getComponentMeta(entry.file), macro)
  })
}

/** The `#okb-comark-components` module: the declarations, as plain data. */
export function renderDeclarationsModule(declarations: ComarkComponentDeclaration[]): string {
  const byTag = Object.fromEntries(declarations.map(declaration => [declaration.tag, declaration]))
  return [
    `/** @type {Record<string, import('#shared/utils/comark-components').ComarkComponentDeclaration>} */`,
    `export const comarkComponentDeclarations = ${JSON.stringify(byTag, null, 2)}`,
    '',
  ].join('\n')
}

/** The `#okb-comark-editor-parts` module: each component's `.editor.ts`, by tag. */
export function renderEditorPartsModule(entries: ComarkComponentFile[]): string {
  const withEditor = entries.filter(entry => entry.editorFile)
  return [
    ...withEditor.map((entry, i) => `import e${i} from ${JSON.stringify(entry.editorFile!.replace(/\.ts$/, ''))}`),
    `/** @type {Record<string, import('#shared/utils/comark-components').ComarkEditorPart | undefined>} */`,
    `export const comarkEditorParts = {`,
    ...withEditor.map((entry, i) => `  ${JSON.stringify(entry.tag)}: e${i},`),
    `}`,
  ].join('\n')
}

/** The `#okb-comark-vue-components` module: each `<Name>.vue`, by tag. */
export function renderVueComponentsModule(entries: ComarkComponentFile[]): string {
  return [
    ...entries.map((entry, i) => `import c${i} from ${JSON.stringify(entry.file)}`),
    `/** @type {Record<string, import('vue').Component>} */`,
    `export const comarkVueComponents = {`,
    ...entries.map((entry, i) => `  ${JSON.stringify(entry.tag)}: c${i},`),
    `}`,
  ].join('\n')
}
