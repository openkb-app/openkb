import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { collectComarkComponentFiles, comarkTagOfComponentFile, readComarkComponentDeclarations } from './comark-components'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
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
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the comark component declarations', () => {
  const app = collectComarkComponentFiles([join(appRoot, 'app')])
  const declarations = Object.fromEntries(readComarkComponentDeclarations(appRoot, app).map(d => [d.tag, d]))

  it('reads the callout: an enum with its default, and a body', () => {
    expect(declarations.callout).toEqual({
      tag: 'callout',
      props: { type: { kind: 'enum', values: ['info', 'warning', 'success', 'danger'], default: 'info', notIndexed: true } },
      slot: true,
      propsEditedInPlace: [],
      inline: false,
    })
  })

  it('reads the infobox: a string title edited in place by its slot, and a body', () => {
    expect(declarations.infobox).toMatchObject({ props: { title: { kind: 'string' } }, slot: true, propsEditedInPlace: ['title'], inline: false })
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
    expect(comarkTagOfComponentFile('CustomDocLink.vue')).toBe('doc-link')
  })

  it('fails on a stored prop of another type, naming component and prop', () => {
    const files = componentFile('CustomPoll.vue', '<script setup lang="ts">\ndefineProps<{ options?: string[] }>()\n</script>\n<template><div /></template>\n')
    expect(() => readComarkComponentDeclarations(appRoot, files)).toThrow(/CustomPoll: prop "options"/)
  })
})
