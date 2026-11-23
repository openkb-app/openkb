import { describe, expect, it } from 'vitest'
import { compileScript, parse } from 'vue/compiler-sfc'
import { comarkComponentMacroVitePlugin, readComarkComponentMacro, removeComarkComponentMacro } from './macro'

/** A Gauge SFC whose `<script setup>` holds the given lines. */
function gaugeSource(...lines: string[]): string {
  return ['<script setup lang="ts">', ...lines, '</script>', '<template><div><slot /></div></template>', ''].join('\n')
}

/** Reads the macro of a Gauge SFC with the given `defineComarkComponent()` argument. */
function readGaugeMacro(argument: string) {
  return readComarkComponentMacro(gaugeSource(`defineComarkComponent(${argument})`), '/app/components/comark/Gauge.vue')
}

/** The macro plugin's transform hook. */
const transform = comarkComponentMacroVitePlugin().transform as (code: string, id: string) => { code: string } | undefined

describe('the defineComarkComponent() macro', () => {
  it('reads the literal argument', () => {
    expect(readGaugeMacro('{ label: \'Gauge\', props: { level: { example: 2, label: `Level`, enumLabels: { \'low\': \'Low\' } } } }'))
      .toEqual({ label: 'Gauge', props: { level: { example: 2, label: 'Level', enumLabels: { low: 'Low' } } } })
    expect(readComarkComponentMacro(gaugeSource('const level = 1'), '/app/components/comark/Gauge.vue')).toBeNull()
  })

  it('fails on a non-literal argument, naming the component', () => {
    expect(() => readGaugeMacro('{ label: labelOfGauge() }')).toThrow(/Gauge: defineComarkComponent\(\) takes a literal object; `labelOfGauge\(\)` is not a literal/)
    expect(() => readGaugeMacro('meta')).toThrow(/Gauge: .*`meta` is not a literal/)
    expect(() => readGaugeMacro('{ ...meta }')).toThrow(/Gauge: .*`\.\.\.meta` is not a plain property/)
    expect(() => readGaugeMacro('\'Gauge\'')).toThrow(/Gauge: defineComarkComponent\(\) takes a literal object$/)
    expect(() => readGaugeMacro('')).toThrow(/Gauge: defineComarkComponent\(\) takes a literal object$/)
  })

  it('fails on the key __proto__', () => {
    expect(() => readGaugeMacro('{ __proto__: { label: \'Gauge\' } }')).toThrow(/`__proto__: .*` is not a plain property/)
    expect(() => readGaugeMacro('{ props: { \'__proto__\': {} } }')).toThrow(/`'__proto__': {}` is not a plain property/)
  })

  it('fails unless it is one top-level statement of <script setup>, naming the file', () => {
    const message = /Gauge\.vue: defineComarkComponent\(\) is called once, as a top-level statement of <script setup>/
    const plain = '<script lang="ts">\ndefineComarkComponent({ label: \'Plain\' })\n</script>\n<template><div /></template>\n'
    expect(() => readComarkComponentMacro(plain, '/app/components/comark/Gauge.vue')).toThrow(message)
    const twice = gaugeSource('defineComarkComponent({ label: \'One\' })', 'defineComarkComponent({ label: \'Two\' })')
    expect(() => readComarkComponentMacro(twice, '/app/components/comark/Gauge.vue')).toThrow(message)
    const nested = gaugeSource('if (import.meta.client) {', '  defineComarkComponent({ label: \'Nested\' })', '}')
    expect(() => readComarkComponentMacro(nested, '/app/components/comark/Gauge.vue')).toThrow(message)
  })

  it('fails on a call outside a comark component, naming the file', () => {
    const source = gaugeSource('defineComarkComponent({ label: \'Card\' })')
    expect(() => transform(source, '/app/components/Card.vue')).toThrow(/\/app\/components\/Card\.vue: defineComarkComponent\(\) is for a comark component/)
    expect(() => transform(source, '/app/components/comark/Card.editor.vue')).toThrow(/is for a comark component/)
    expect(transform(gaugeSource('// defineComarkComponent is not called here'), '/app/components/Card.vue')).toBeUndefined()
  })

  it('leaves no runtime code', () => {
    const source = gaugeSource('interface Props { level?: \'low\' | \'high\' }', 'defineProps<Props>()', 'defineComarkComponent<Props>({ label: \'Gauge\' })')
    const stripped = transform(source, '/app/components/comark/Gauge.vue')!.code
    expect(stripped).toBe(removeComarkComponentMacro(source, '/app/components/comark/Gauge.vue'))
    expect(stripped.split('\n')).toHaveLength(source.split('\n').length)
    const compiled = compileScript(parse(stripped).descriptor, { id: 'gauge' }).content
    expect(compiled).not.toContain('defineComarkComponent')
    expect(compiled).not.toContain('Gauge\'')
  })

  it('keeps a ; in place of the call, so the lines around it stay apart', () => {
    const source = gaugeSource('const level = 1', 'defineComarkComponent({ label: \'Joined\' });', '[level].forEach(String)')
    const stripped = removeComarkComponentMacro(source, '/app/components/comark/Joined.vue')
    expect(stripped.split('\n')[2]).toMatch(/^; +$/)
    const compiled = compileScript(parse(stripped).descriptor, { id: 'joined' }).content
    expect(compiled).toContain('[level].forEach(String)')
    expect(compiled).not.toMatch(/1\s+\[level\]/)
  })
})
