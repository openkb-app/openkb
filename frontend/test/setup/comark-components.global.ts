import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  collectComarkComponentFiles,
  readComarkComponentDeclarations,
  renderDeclarationsModule,
  renderEditorPartsModule,
  renderVueComponentsModule,
} from '../../modules/comark-components'

/** Where the generated `#okb-comark-*` modules land for the suites (gitignored). */
export const GENERATED_DIR = fileURLToPath(new URL('../.generated/', import.meta.url))

/** Writes the `#okb-comark-*` modules once per run, with the Nuxt module's own collector. */
export default function writeComarkComponentModules(): void {
  const rootDir = fileURLToPath(new URL('../../', import.meta.url))
  const entries = collectComarkComponentFiles([fileURLToPath(new URL('../../app', import.meta.url))])
  mkdirSync(GENERATED_DIR, { recursive: true })
  writeFileSync(`${GENERATED_DIR}okb-comark-components.mjs`, renderDeclarationsModule(readComarkComponentDeclarations(rootDir, entries)))
  writeFileSync(`${GENERATED_DIR}okb-comark-editor-parts.mjs`, renderEditorPartsModule(entries))
  writeFileSync(`${GENERATED_DIR}okb-comark-vue-components.mjs`, renderVueComponentsModule(entries))
}
