import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { addServerTemplate, addTemplate, addTypeTemplate, defineNuxtModule, useLogger } from '@nuxt/kit'

/**
 * The fence directories under `<root>/fences/`, as `[language, dir]`. The
 * first root wins on a shared name. Skipped, with a warning:
 * - a directory without `fence.ts` or `Fence.vue`;
 * - a name that is not lowercase (info strings are matched lowercased).
 */
export function collectFenceDirs(roots: string[], warn: (message: string) => void): [string, string][] {
  const dirs = new Map<string, string>()
  for (const rootDir of roots) {
    const root = join(rootDir, 'fences')
    if (!existsSync(root)) continue
    for (const language of readdirSync(root).sort()) {
      const dir = join(root, language)
      if (dirs.has(language)) continue
      if (language !== language.toLowerCase()) {
        warn(`Skipping fence ${dir}: the directory name must be lowercase.`)
      }
      else if (!existsSync(join(dir, 'fence.ts')) || !existsSync(join(dir, 'Fence.vue'))) {
        warn(`Skipping fence ${dir}: it needs a fence.ts and a Fence.vue.`)
      }
      else {
        dirs.set(language, dir)
      }
    }
  }
  return [...dirs]
}

/**
 * Collects the fence components (shared/utils/fences.ts) from `fences/<language>/`
 * in every layer. On a shared directory name the app's own wins, then the
 * layers in `extends` order.
 *
 * - `#okb-fences`: every `fence.ts`, for the app and the server.
 * - `#okb-fence-components`: every `Fence.vue`, loaded when first drawn.
 * - `#okb-fence-servers`: every `server.ts`, for Nitro only.
 */
export default defineNuxtModule({
  meta: { name: 'okb-fences' },
  setup(_, nuxt) {
    const logger = useLogger('okb-fences')
    const fences = collectFenceDirs(nuxt.options._layers.map(layer => layer.config.rootDir), message => logger.warn(message))

    const definitions = addTemplate({
      filename: 'okb-fences.mjs',
      write: true,
      getContents: () => [
        ...fences.map(([, dir], i) => `import f${i} from ${JSON.stringify(join(dir, 'fence'))}`),
        `export const fences = [${fences.map(([language], i) => `{ ...f${i}, language: ${JSON.stringify(language)} }`).join(', ')}]`,
      ].join('\n'),
    })
    const components = addTemplate({
      filename: 'okb-fence-components.mjs',
      write: true,
      getContents: () => [
        `import { defineAsyncComponent } from 'vue'`,
        `export const fenceComponents = {`,
        ...fences.map(([language, dir]) =>
          `  ${JSON.stringify(language)}: defineAsyncComponent(() => import(${JSON.stringify(join(dir, 'Fence.vue'))})),`),
        `}`,
      ].join('\n'),
    })
    nuxt.options.alias['#okb-fences'] = definitions.dst
    nuxt.options.alias['#okb-fence-components'] = components.dst

    addServerTemplate({
      filename: '#okb-fence-servers',
      getContents: () => [
        `export const fenceServers = {`,
        ...fences.filter(([, dir]) => existsSync(join(dir, 'server.ts'))).map(([language, dir]) =>
          `  ${JSON.stringify(language)}: () => import(${JSON.stringify(join(dir, 'server'))}),`),
        `}`,
      ].join('\n'),
    })

    const types = 'import(\'~~/shared/utils/fences\')'
    addTypeTemplate({
      filename: 'types/okb-fences.d.ts',
      getContents: () => [
        `declare module '#okb-fences' { export const fences: ${types}.FenceDefinition[] }`,
        `declare module '#okb-fence-components' { export const fenceComponents: Record<string, import('vue').Component> }`,
        `declare module '#okb-fence-servers' { export const fenceServers: Record<string, () => Promise<${types}.FenceServer>> }`,
      ].join('\n'),
    }, { nuxt: true, nitro: true })
  },
})
