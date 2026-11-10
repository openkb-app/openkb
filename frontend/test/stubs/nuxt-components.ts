/**
 * What `#components` resolves to under vitest. Nuxt builds that module from the
 * auto-import scan, which no unit suite runs, so the suites get the
 * components they render through it.
 */
import { defineComponent, h } from 'vue'

export { default as CustomMention } from '~/components/global/CustomMention.vue'

export const NuxtLink = defineComponent({
  name: 'NuxtLink',
  props: { to: { type: [String, Object], default: undefined } },
  setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()),
})
