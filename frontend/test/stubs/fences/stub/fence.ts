import type { FenceOptions } from '#shared/utils/fences'

/** A test-only fence for the generic fence tests: refuses any `!`. */
export default {
  label: 'Sketch',
  description: 'A test fence',
  icon: 'i-lucide-pencil',
  languageLabel: 'Stub',
  template: 'one\ntwo',
  agentHint: 'a sketch',
} satisfies FenceOptions
