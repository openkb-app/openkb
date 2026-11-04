import CodeBlock from '@tiptap/extension-code-block'

/**
 * A code block that keeps its fence's info string after the language
 * (`ts [file.ts] {1,3}` → `meta: '[file.ts] {1,3}'`): the stored markdown
 * keeps it, the editor does not show it.
 *
 * Vue-free, shared by the live editor and the commit schema.
 */
export const OkbCodeBlock = CodeBlock.extend({
  /** Adds `meta`, the info string after the language, not rendered. */
  addAttributes() {
    return {
      ...this.parent?.(),
      meta: { default: null, rendered: false },
    }
  },
})
