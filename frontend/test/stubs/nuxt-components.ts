/**
 * What `#components` resolves to under vitest. Nuxt builds that module from the
 * auto-import scan, which no unit suite runs, so the suites get the one
 * component they render through it.
 */
import { defineComponent, h } from 'vue'

export const NuxtLink = defineComponent({
  name: 'NuxtLink',
  props: { to: { type: [String, Object], default: undefined } },
  setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()),
})
