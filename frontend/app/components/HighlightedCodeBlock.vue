<script setup lang="ts">
/**
 * A code fence, from the token lines the tree pass highlighted
 * (`code-block` in shared/utils/comark-tree.ts). Rendered as spans, never as
 * HTML: the colours are theme variables `main.css` resolves per colour mode.
 *
 * The root is the `pre`, so the block id lands on it and the block margin
 * anchors to it as to any other block.
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import type { CodeLine } from '#shared/utils/code-highlight'
import { codeLanguage } from '#shared/utils/code-languages'

const props = defineProps<{
  /** The language id, set only for a fence the highlighter coloured. */
  language?: string
  lines: CodeLine[]
}>()

const label = computed(() => codeLanguage(props.language)?.label ?? '')
const code = computed(() => props.lines.map(line => line.map(t => t.content).join('')).join('\n'))

const state = ref<'idle' | 'copied' | 'failed'>('idle')
let reset: ReturnType<typeof setTimeout> | undefined

/** The Clipboard API is secure-context only; the code stays selectable either way. */
async function copy(): Promise<void> {
  try {
    await globalThis.navigator.clipboard.writeText(code.value)
    state.value = 'copied'
  }
  catch {
    state.value = 'failed'
  }
  clearTimeout(reset)
  reset = setTimeout(() => (state.value = 'idle'), 2000)
}

onBeforeUnmount(() => clearTimeout(reset))

const icon = computed(() => ({
  idle: 'i-lucide-copy',
  copied: 'i-lucide-check',
  failed: 'i-lucide-triangle-alert',
})[state.value])

const status = computed(() => ({
  idle: '',
  copied: 'Code copied',
  failed: 'Copy failed — select the code and copy it by hand',
})[state.value])
</script>

<!-- Whitespace inside `pre` is content: every break below sits inside a tag. -->
<template>
  <pre
    class="okb-code"
    :data-language="language || undefined"
  ><span
    class="okb-code-tools"
  ><span
    v-if="label"
    class="okb-code-lang"
  >{{ label }}</span><button
    type="button"
    class="okb-code-copy"
    aria-label="Copy code"
    :data-state="state"
    @click="copy"
  ><UIcon
    :name="icon"
    class="size-4"
    aria-hidden="true"
  /></button><span
    class="sr-only"
    role="status"
  >{{ status }}</span></span><code><template
    v-for="(line, i) in lines"
    :key="i"
  ><template v-if="i > 0">{{ '\n' }}</template><span
    v-for="(token, j) in line"
    :key="j"
    v-bind="token.style ? { class: 'okb-code-token', style: token.style } : {}"
  >{{ token.content }}</span></template></code></pre>
</template>
