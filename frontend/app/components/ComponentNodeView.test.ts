// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import type { Component } from 'vue'

// A test-only component with a prop of every kind, its title edited in place.
vi.mock('#okb-comark-components', async (importOriginal) => {
  const original = await importOriginal<{ comarkComponentDeclarations: Record<string, unknown> }>()
  return {
    comarkComponentDeclarations: {
      ...original.comarkComponentDeclarations,
      widget: {
        tag: 'widget',
        props: {
          title: { kind: 'string' },
          size: { kind: 'enum', values: ['small', 'large'], default: 'small' },
          count: { kind: 'number' },
          open: { kind: 'boolean' },
        },
        slot: true,
        propsEditedInPlace: ['title'],
        inline: false,
      },
      // The same props with the labels a `defineComarkComponent()` call gives them.
      gadget: {
        tag: 'gadget',
        label: 'Handy gadget',
        props: {
          size: { kind: 'enum', values: ['small', 'large'], default: 'small', label: 'Dimensions', enumLabels: { small: 'Compact' }, enumIcons: { large: 'i-lucide-maximize' } },
          count: { kind: 'number', label: 'How many' },
        },
        slot: true,
        propsEditedInPlace: [],
        inline: false,
      },
    },
  }
})
vi.mock('#okb-comark-vue-components', () => ({
  comarkVueComponents: {
    callout: defineComponent({ setup: (_, { slots }) => () => h('div', { 'data-test': 'callout' }, slots.default?.()) }),
    infobox: defineComponent({ props: { title: String }, setup: (props, { slots }) => () => h('section', { 'data-test': 'infobox' }, [h('h3', slots.title?.() ?? props.title), slots.default?.()]) }),
    widget: defineComponent({ props: { title: String }, setup: (props, { slots }) => () => h('section', { 'data-test': 'widget' }, [h('h3', slots.title?.() ?? props.title), slots.default?.()]) }),
  },
}))
vi.mock('#okb-comark-editor-parts', async () => {
  const { default: settingsMenu } = await import('./comark/Callout.settings.vue')
  return { comarkEditorParts: { callout: { settingsMenu } } }
})

const { default: ComponentNodeView } = await import('./ComponentNodeView.vue')
const { default: ComponentSettingsMenu } = await import('./ComponentSettingsMenu.vue')
const { comarkComponentDeclarations } = await import('#shared/utils/comark-components')

/** Nuxt UI's select, as a plain select that emits what USelect would. */
const USelect = defineComponent({
  props: { modelValue: String, items: Array },
  emits: ['update:modelValue'],
  setup: (props, { emit, attrs }) => () => h('select', {
    'aria-label': attrs['aria-label'],
    'value': props.modelValue,
    'onChange': (event: Event) => emit('update:modelValue', (event.target as HTMLSelectElement).value),
  }, (props.items as Array<{ label: string, value: string, icon?: string }>).map(item => h('option', { 'value': item.value, 'data-icon': item.icon }, item.label))),
})
/** Nuxt UI's switch, as a checkbox. */
const USwitch = defineComponent({
  props: { modelValue: Boolean },
  emits: ['update:modelValue'],
  setup: (props, { emit }) => () => h('input', { type: 'checkbox', checked: props.modelValue, onChange: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).checked) }),
})
/** Nuxt UI's input, as a plain input. */
const UInput = defineComponent({
  props: { modelValue: [String, Number], type: String },
  emits: ['update:modelValue'],
  setup: (props, { emit }) => () => h('input', { type: props.type, value: props.modelValue, onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value) }),
})
/** Nuxt UI's popover: the trigger, and the content once the trigger is clicked. */
const UPopover = defineComponent({
  setup: (_, { slots }) => {
    const open = ref(false)
    return () => h('div', { onClick: () => { open.value = true } }, [slots.default?.(), open.value ? slots.content?.() : null])
  },
})
const UButton = defineComponent({ setup: (_, { attrs }) => () => h('button', { 'aria-label': attrs['aria-label'] }) })
const UFormField = defineComponent({ props: { label: String }, setup: (props, { slots }) => () => h('label', [props.label, slots.default?.()]) })

/** Mounts a component with the Nuxt UI stand-ins and the injections Tiptap's node view wrapper reads. */
function mount(component: Component, props: Record<string, unknown>): HTMLElement {
  const root = document.createElement('div')
  document.body.append(root)
  createApp({ render: () => h(component, props) })
    .component('USelect', USelect)
    .component('USwitch', USwitch)
    .component('UInput', UInput)
    .component('UPopover', UPopover)
    .component('UButton', UButton)
    .component('UFormField', UFormField)
    .provide('onDragStart', () => {})
    .provide('decorationClasses', '')
    .mount(root)
  return root
}

/** A node view's props for a node of `tag` with `attrs`. */
function nodeViewProps(tag: string, attrs: Record<string, unknown>, updateAttributes = vi.fn()) {
  return {
    node: { type: { name: tag }, attrs: { ...attrs, id: 'b-1' } },
    updateAttributes,
    decorations: [], innerDecorations: {}, selected: false, extension: {}, getPos: () => 0, view: {}, editor: {}, deleteNode: () => {}, HTMLAttributes: {},
  }
}

/** Replaces IntersectionObserver with one that reports every observed element as `visible`. */
function stubIntersectionObserver(visible: boolean) {
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      this.callback([{ isIntersecting: visible, target, time: 0 } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver)
    }
    unobserve() {}
    disconnect() {}
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('the default settings menu', () => {
  const declaration = comarkComponentDeclarations.widget!
  const { title: _title, ...menuProps } = declaration.props

  it('is a gear labelled after the component, its form mounted only when opened', async () => {
    const root = mount(ComponentSettingsMenu, { declaration, menuProps, values: {} })
    const gear = root.querySelector('button')!
    expect(gear.getAttribute('aria-label')).toBe('Widget settings')
    expect(root.querySelector('[data-test="component-settings-form"]')).toBeNull()
    gear.click()
    await nextTick()
    expect(root.querySelector('[data-test="component-settings-form"]')).not.toBeNull()
  })

  it('has one field per prop it edits, by kind, and emits each change at once', async () => {
    const change = vi.fn()
    const root = mount(ComponentSettingsMenu, { declaration, menuProps, values: { size: 'large', count: 3, open: true }, onChange: change })
    root.querySelector('button')!.click()
    await nextTick()
    const form = root.querySelector('[data-test="component-settings-form"]')!
    expect([...form.querySelectorAll('label')].map(label => label.firstChild?.textContent)).toEqual(['Size', 'Count', 'Open'])

    const select = form.querySelector('select')!
    expect([...select.options].map(option => option.value)).toEqual(['small', 'large'])
    select.value = 'small'
    select.dispatchEvent(new Event('change'))
    expect(change).toHaveBeenLastCalledWith('size', 'small')

    const number = form.querySelector<HTMLInputElement>('input[type="number"]')!
    expect(number.value).toBe('3')
    number.value = '7'
    number.dispatchEvent(new Event('input'))
    expect(change).toHaveBeenLastCalledWith('count', 7)
    number.value = ''
    number.dispatchEvent(new Event('input'))
    expect(change).toHaveBeenLastCalledWith('count', null)

    const toggle = form.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    toggle.checked = false
    toggle.dispatchEvent(new Event('change'))
    expect(change).toHaveBeenLastCalledWith('open', false)
  })

  it('takes the component, field and enum labels and the enum icons from the declaration', async () => {
    const gadget = comarkComponentDeclarations.gadget!
    const root = mount(ComponentSettingsMenu, { declaration: gadget, menuProps: gadget.props, values: {} })
    expect(root.querySelector('button')!.getAttribute('aria-label')).toBe('Handy gadget settings')
    root.querySelector('button')!.click()
    await nextTick()
    const form = root.querySelector('[data-test="component-settings-form"]')!
    expect([...form.querySelectorAll('label')].map(label => label.firstChild?.textContent)).toEqual(['Dimensions', 'How many'])
    expect([...form.querySelector('select')!.options].map(option => option.textContent)).toEqual(['Compact', 'Large'])
    expect([...form.querySelector('select')!.options].map(option => option.dataset.icon)).toEqual([undefined, 'i-lucide-maximize'])
  })
})

describe('the generic node view', () => {
  it('edits a text prop in place, in the slot of its name, and leaves it out of the menu', async () => {
    stubIntersectionObserver(true)
    const updateAttributes = vi.fn()
    const root = mount(ComponentNodeView, nodeViewProps('widget', { title: 'Plan', size: 'small' }, updateAttributes))
    const field = root.querySelector<HTMLInputElement>('[data-test="widget"] h3 input')!
    expect(field.value).toBe('Plan')
    expect(field.placeholder).toBe('Widget title…')
    field.value = 'Plans'
    field.dispatchEvent(new Event('input'))
    expect(updateAttributes).toHaveBeenCalledWith({ title: 'Plans' })

    await vi.waitFor(() => expect(root.querySelector('[data-test="component-settings"]')).not.toBeNull())
    root.querySelector<HTMLButtonElement>('[data-test="component-settings"] button')!.click()
    await nextTick()
    const labels = [...root.querySelectorAll('[data-test="component-settings-form"] label')].map(label => label.firstChild?.textContent)
    expect(labels).toEqual(['Size', 'Count', 'Open'])
  })

  it('gives a component with no prop left for the menu no gear', async () => {
    stubIntersectionObserver(true)
    const root = mount(ComponentNodeView, nodeViewProps('infobox', { title: '' }))
    await nextTick()
    expect(root.querySelector<HTMLInputElement>('[data-test="infobox"] h3 input')!.placeholder).toBe('Infobox title…')
    expect(root.querySelector('[data-test="component-settings"]')).toBeNull()
  })

  it('renders a component\'s own settings menu, and mounts none outside the viewport', async () => {
    stubIntersectionObserver(false)
    const outside = mount(ComponentNodeView, nodeViewProps('callout', { type: 'warning' }))
    await nextTick()
    expect(outside.querySelector('[data-test="callout"]')).not.toBeNull()
    expect(outside.querySelector('[data-test="component-controls"]')).toBeNull()

    stubIntersectionObserver(true)
    const updateAttributes = vi.fn()
    const root = mount(ComponentNodeView, nodeViewProps('callout', { type: 'warning' }, updateAttributes))
    await vi.waitFor(() => expect(root.querySelector('[data-test="component-controls"]')).not.toBeNull())
    expect(root.querySelector('[data-test="component-settings"]')).toBeNull()
    const select = root.querySelector('select')!
    expect(select.getAttribute('aria-label')).toBe('Callout type')
    expect([...select.options].map(option => [option.value, option.textContent])).toEqual([
      ['info', 'Info'], ['warning', 'Warning'], ['success', 'Success'], ['danger', 'Danger'],
    ])
    select.value = 'success'
    select.dispatchEvent(new Event('change'))
    expect(updateAttributes).toHaveBeenCalledWith({ type: 'success' })
  })
})
