import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { collectComarkComponentFiles, comarkTagOfComponentFile, readComarkComponentDeclarations } from './declarations'

const appRoot = fileURLToPath(new URL('../..', import.meta.url))
const dirs: string[] = []

/** A component file in a temporary `components/comark/` folder inside the app root, so `vue` resolves. */
function componentFile(name: string, source: string) {
  const srcDir = mkdtempSync(join(appRoot, 'test/.generated/layer-'))
  dirs.push(srcDir)
  mkdirSync(join(srcDir, 'components/comark'), { recursive: true })
  writeFileSync(join(srcDir, 'components/comark', name), source)
  return collectComarkComponentFiles([srcDir])
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('the comark component declarations', () => {
  const app = collectComarkComponentFiles([join(appRoot, 'app')])
  const declarations = Object.fromEntries(readComarkComponentDeclarations(appRoot, app).map(d => [d.tag, d]))

  it('reads the callout: an enum with its default, a body, and its defineComarkComponent() metadata', () => {
    expect(declarations.callout).toEqual({
      tag: 'callout',
      label: 'Callout',
      icon: 'i-lucide-info',
      description: 'Info box — switch the type inside',
      placeholder: 'New callout — type here.',
      props: {
        type: {
          kind: 'enum',
          values: ['info', 'warning', 'success', 'danger'],
          default: 'info',
          notIndexed: true,
          enumIcons: { info: 'i-lucide-info', warning: 'i-lucide-alert-triangle', success: 'i-lucide-check-circle', danger: 'i-lucide-octagon-alert' },
        },
      },
      slot: true,
      propsEditedInPlace: [],
      inline: false,
    })
  })

  it('reads the infobox: a string title edited in place by its slot, with its example, and a body', () => {
    expect(declarations.infobox).toMatchObject({ props: { title: { kind: 'string', example: 'Info' } }, slot: true, propsEditedInPlace: ['title'], inline: false })
  })

  it('stores no @render prop of the image', () => {
    expect(declarations.image).toMatchObject({
      props: { file: { kind: 'string' }, alt: { kind: 'string' }, width: { kind: 'string' } },
      slot: false,
    })
    expect(Object.keys(declarations.image!.props)).toEqual(['file', 'alt', 'width'])
  })

  it('marks a prop tagged @notIndexed', () => {
    expect(declarations.image!.props).toMatchObject({ file: { notIndexed: true }, width: { notIndexed: true } })
    expect(declarations.image!.props.alt!.notIndexed).toBeUndefined()
  })

  it('reads the chips from the inline folder', () => {
    expect(declarations.mention).toMatchObject({ inline: true, props: { uid: { kind: 'string' } }, slot: true })
    expect(declarations.doc).toMatchObject({ inline: true, props: { nid: { kind: 'number' }, block: { kind: 'string' } } })
    expect(Object.keys(declarations.citation!.props)).toEqual(['nid', 'block', 'v', 'url'])
  })

  it('names the tag after the file', () => {
    expect(comarkTagOfComponentFile('DocLink.vue')).toBe('doc-link')
  })

  it('takes no file with a second dot', () => {
    expect(app.map(entry => entry.tag)).not.toContain('callout.settings')
    expect(app.find(entry => entry.tag === 'image')?.editorFile).toMatch(/Image\.editor\.ts$/)
  })

  it('fails on a block and a chip of the same name in one layer', () => {
    const [entry] = componentFile('Note.vue', '<template><div /></template>\n')
    const srcDir = entry!.file.replace(/\/components\/comark\/Note\.vue$/, '')
    mkdirSync(join(srcDir, 'components/comark/inline'))
    writeFileSync(join(srcDir, 'components/comark/inline/Note.vue'), '<template><span /></template>\n')
    expect(() => collectComarkComponentFiles([srcDir])).toThrow(/inline\/Note\.vue: the tag "note" is taken by .*comark\/Note\.vue/)
  })

  it('fails on a stored prop of another type, naming component and prop', () => {
    const files = componentFile('Poll.vue', '<script setup lang="ts">\ndefineProps<{ options?: string[] }>()\n</script>\n<template><div /></template>\n')
    expect(() => readComarkComponentDeclarations(appRoot, files)).toThrow(/Poll: prop "options"/)
  })
})

/** A component with the given `defineComarkComponent()` argument and a `level` enum prop. */
function componentWithMacro(argument: string) {
  return componentFile('Gauge.vue', [
    '<script setup lang="ts">',
    'interface Props { level?: \'low\' | \'high\', note?: string }',
    'defineProps<Props>()',
    `defineComarkComponent<Props>(${argument})`,
    '</script>',
    '<template><div><slot /></div></template>',
    '',
  ].join('\n'))
}

describe('a declaration with its defineComarkComponent() metadata', () => {
  it('merges the macro\'s argument in', () => {
    const [declaration] = readComarkComponentDeclarations(appRoot, componentWithMacro(`{
      label: 'Gauge', icon: 'i-lucide-gauge', description: 'A level', placeholder: 'Why this level.',
      props: { level: { label: 'Level', example: 'high', enumLabels: { low: 'Low level' }, enumIcons: { high: 'i-lucide-arrow-up' } } },
    }`))
    expect(declaration).toEqual({
      tag: 'gauge',
      label: 'Gauge',
      icon: 'i-lucide-gauge',
      description: 'A level',
      placeholder: 'Why this level.',
      props: {
        level: { kind: 'enum', values: ['low', 'high'], label: 'Level', example: 'high', enumLabels: { low: 'Low level' }, enumIcons: { high: 'i-lucide-arrow-up' } },
        note: { kind: 'string' },
      },
      slot: true,
      propsEditedInPlace: [],
      inline: false,
    })
  })

  it('fails on an unknown key, naming the component and the key', () => {
    expect(() => readComarkComponentDeclarations(appRoot, componentWithMacro('{ title: \'Gauge\' }'))).toThrow(/Gauge: defineComarkComponent\(\) has the unknown key "title"; it takes label, description, icon, placeholder, props, and label, example, enumLabels, enumIcons per stored prop/)
    expect(() => readComarkComponentDeclarations(appRoot, componentWithMacro('{ props: { level: { hint: \'x\' } } }'))).toThrow(/Gauge: .*unknown key "props\.level\.hint"/)
    expect(() => readComarkComponentDeclarations(appRoot, componentWithMacro('{ props: { size: {} } }'))).toThrow(/Gauge: .*unknown key "props\.size"/)
  })
})
