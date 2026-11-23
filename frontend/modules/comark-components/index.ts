import { join } from 'node:path'
import { addServerTemplate, addTemplate, addTypeTemplate, addVitePlugin, defineNuxtModule, updateTemplates } from '@nuxt/kit'
import { collectComarkComponentFiles, readComarkComponentDeclarations, renderDeclarationsModule, renderEditorPartsModule, renderVueComponentsModule } from './declarations.ts'
import { comarkComponentMacroVitePlugin } from './macro.ts'

/**
 * Collects the comark components (shared/utils/comark-components.ts) from
 * `app/components/comark/` in every layer. On a shared tag the app's own wins,
 * then the layers in `extends` order.
 *
 * - `#okb-comark-components`: the declarations, for the app and the server.
 * - `#okb-comark-vue-components`: every `<Name>.vue`, for the app.
 * - `#okb-comark-editor-parts`: every `<Name>.editor.ts`, for the app.
 * - `defineComarkComponent()`: a type-only global; the Vite plugin removes its calls.
 */
export default defineNuxtModule({
  meta: { name: 'okb-comark-components' },
  setup(_, nuxt) {
    addVitePlugin(comarkComponentMacroVitePlugin())
    const srcDirs = nuxt.options._layers.map(layer => layer.config.srcDir || join(layer.config.rootDir, 'app'))
    const collect = () => {
      const entries = collectComarkComponentFiles(srcDirs)
      return { entries, declarations: readComarkComponentDeclarations(nuxt.options.rootDir, entries) }
    }
    let collected = collect()
    nuxt.hook('builder:watch', async (_event, path) => {
      if (!path.includes('components/comark/')) {
        return
      }
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
        `declare function defineComarkComponent<P = Record<string, unknown>>(meta: ${types}.ComarkComponentMeta<P>): void`,
      ].join('\n'),
    }, { nuxt: true, nitro: true, shared: true, node: true })
  },
})
