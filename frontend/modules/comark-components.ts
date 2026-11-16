import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { addServerTemplate, addTemplate, addTypeTemplate, defineNuxtModule, updateTemplates } from '@nuxt/kit'
import { createCheckerByJson } from 'vue-component-meta'
import type { ComponentMeta, PropertyMeta } from 'vue-component-meta'
import type { ComarkComponentDeclaration, ComarkPropDeclaration } from '../shared/utils/comark-components'

/** One comark component file found in a layer: its tag, file and whether it is a chip. */
export interface ComarkComponentFile {
  tag: string
  file: string
  inline: boolean
  editorFile: string | null
}

/** Turns `CustomDocLink.vue` into the comark tag `doc-link`. */
export function comarkTagOfComponentFile(file: string): string {
  return basename(file, '.vue').replace(/^Custom/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/**
 * The `Custom<Name>.vue` files under `<srcDir>/components/comark/` of every
 * layer, and under its `inline/` folder for chips. The first layer wins on a
 * shared tag.
 */
export function collectComarkComponentFiles(srcDirs: string[]): ComarkComponentFile[] {
  const files = new Map<string, ComarkComponentFile>()
  for (const srcDir of srcDirs) {
    for (const [dir, inline] of [[join(srcDir, 'components/comark'), false], [join(srcDir, 'components/comark/inline'), true]] as const) {
      if (!existsSync(dir)) continue
      for (const name of readdirSync(dir).filter(name => /^Custom[A-Z]\w*\.vue$/.test(name)).sort()) {
        const tag = comarkTagOfComponentFile(name)
        if (files.has(tag)) continue
        const editorFile = join(dir, name.replace(/\.vue$/, '.editor.ts'))
        files.set(tag, { tag, file: join(dir, name), inline, editorFile: existsSync(editorFile) ? editorFile : null })
      }
    }
  }
  return [...files.values()]
}

/** The JSON value of a prop default as vue-component-meta prints it, or undefined for an expression. */
function parsePropDefault(value: string | undefined): string | number | boolean | undefined {
  if (value === undefined) return undefined
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
  if (fallback !== undefined) declaration.default = fallback
  if (options.length > 0 && options.every(option => typeof option === 'string' && /^".*"$/.test(option))) {
    return { ...declaration, kind: 'enum', values: options.map(option => JSON.parse(option as string) as string) }
  }
  if (options.length === 1 && (options[0] === 'string' || options[0] === 'number')) return { ...declaration, kind: options[0] }
  if (options.length === 2 && options.includes('true') && options.includes('false')) return { ...declaration, kind: 'boolean' }
  if (options.length === 1 && options[0] === 'boolean') return { ...declaration, kind: 'boolean' }
  throw new Error(`${component}: prop "${prop.name}" has type ${prop.type}; a stored prop is a string, an enum, a number or a boolean (mark a prop the server fills with @render)`)
}

/** Builds a component's declaration from what vue-component-meta read off its `defineProps` and slots. */
export function declareComarkComponent(entry: ComarkComponentFile, meta: ComponentMeta): ComarkComponentDeclaration {
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
  return entries.map(entry => declareComarkComponent(entry, checker.getComponentMeta(entry.file)))
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

/** The `#okb-comark-vue-components` module: each `Custom<Name>.vue`, by tag. */
export function renderVueComponentsModule(entries: ComarkComponentFile[]): string {
  return [
    ...entries.map((entry, i) => `import c${i} from ${JSON.stringify(entry.file)}`),
    `/** @type {Record<string, import('vue').Component>} */`,
    `export const comarkVueComponents = {`,
    ...entries.map((entry, i) => `  ${JSON.stringify(entry.tag)}: c${i},`),
    `}`,
  ].join('\n')
}

/**
 * Collects the comark components (shared/utils/comark-components.ts) from
 * `app/components/comark/` in every layer. On a shared tag the app's own wins,
 * then the layers in `extends` order.
 *
 * - `#okb-comark-components`: the declarations, for the app and the server.
 * - `#okb-comark-vue-components`: every `Custom<Name>.vue`, for the app.
 * - `#okb-comark-editor-parts`: every `Custom<Name>.editor.ts`, for the app.
 */
export default defineNuxtModule({
  meta: { name: 'okb-comark-components' },
  setup(_, nuxt) {
    const srcDirs = nuxt.options._layers.map(layer => layer.config.srcDir || join(layer.config.rootDir, 'app'))
    const collect = () => {
      const entries = collectComarkComponentFiles(srcDirs)
      return { entries, declarations: readComarkComponentDeclarations(nuxt.options.rootDir, entries) }
    }
    let collected = collect()
    nuxt.hook('builder:watch', async (_event, path) => {
      if (!path.includes('components/comark/')) return
      collected = collect()
      await updateTemplates({ filter: template => template.filename.startsWith('okb-comark-') })
    })

    const declarations = addTemplate({
      filename: 'okb-comark-components.mjs',
      write: true,
      getContents: () => renderDeclarationsModule(collected.declarations),
    })
    const editorParts = addTemplate({
      filename: 'okb-comark-editor-parts.mjs',
      write: true,
      getContents: () => renderEditorPartsModule(collected.entries),
    })
    const vueComponents = addTemplate({
      filename: 'okb-comark-vue-components.mjs',
      write: true,
      getContents: () => renderVueComponentsModule(collected.entries),
    })
    nuxt.options.alias['#okb-comark-components'] = declarations.dst
    nuxt.options.alias['#okb-comark-editor-parts'] = editorParts.dst
    nuxt.options.alias['#okb-comark-vue-components'] = vueComponents.dst

    addServerTemplate({
      filename: '#okb-comark-components',
      getContents: () => renderDeclarationsModule(collected.declarations),
    })

    const types = 'import(\'~~/shared/utils/comark-components\')'
    addTypeTemplate({
      filename: 'types/okb-comark-components.d.ts',
      getContents: () => [
        `declare module '#okb-comark-components' { export const comarkComponentDeclarations: Record<string, ${types}.ComarkComponentDeclaration> }`,
        `declare module '#okb-comark-editor-parts' { export const comarkEditorParts: Record<string, ${types}.ComarkEditorPart> }`,
        `declare module '#okb-comark-vue-components' { export const comarkVueComponents: Record<string, import('vue').Component> }`,
      ].join('\n'),
    }, { nuxt: true, nitro: true, shared: true, node: true })
  },
})
