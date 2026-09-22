/**
 * Round-trip harness: markdown → editor doc → markdown, through the real
 * production code paths — the shared @tiptap/markdown engine
 * (app/comark/markdown-engine.ts) used by editor hydration and the
 * headless commit service alike. Sync and DOM-free.
 *
 * The harness is generic over a `RoundTripImpl` so the same corpus can
 * A/B-gate an alternative conversion pipeline: pass another
 * implementation to `runCorpus` / `roundTrip`.
 */
import { getSchema } from '@tiptap/core'
import Code from '@tiptap/extension-code'
import HorizontalRule from '@tiptap/extension-horizontal-rule'
import StarterKit from '@tiptap/starter-kit'
import { mergeAttributes } from '@tiptap/core'
import type { Node as ProseNode } from '@tiptap/pm/model'
import type { AnyExtension } from '@tiptap/core'
import { buildEditorExtensions, starterKitMarkdownOverrides } from '../../app/editor/extensions'
import { parseMarkdownToDoc, serializeDocToMarkdown } from '../../app/comark/markdown-engine'

export interface RoundTripImpl {
  name: string
  load(markdown: string): Promise<ProseNode>
  save(doc: ProseNode): string
}

/**
 * The schema-relevant extension set the live editor runs with. Nuxt UI's
 * UEditor assembles its core set internally (node_modules/@nuxt/ui/dist/
 * runtime/components/Editor.vue) and appends our `:extensions` prop; this
 * mirrors that assembly line by line, with the options the edit pages pass
 * (`:starter-kit="{ history: false, undoRedo: false,
 * ...starterKitMarkdownOverrides }"`, `:mention="false"`, no placeholder).
 * Collaboration / CollaborationCaret are omitted — they contribute no
 * schema nodes or marks, only Y.js plugins that need a live provider.
 */
export function editorExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      code: false,
      horizontalRule: false,
      link: { openOnClick: false },
      undoRedo: false,
      ...starterKitMarkdownOverrides,
    }),
    Code.extend({ excludes: 'code' }),
    HorizontalRule.extend({
      renderHTML() {
        return ['div', mergeAttributes(this.options.HTMLAttributes, { 'data-type': this.name }), ['hr']]
      },
    }),
    ...buildEditorExtensions(),
  ]
}

export const editorSchema = getSchema(editorExtensions())

export const productionImpl: RoundTripImpl = {
  name: 'production',
  async load(markdown: string): Promise<ProseNode> {
    return parseMarkdownToDoc(markdown)
  },
  save(doc: ProseNode): string {
    return serializeDocToMarkdown(doc)
  },
}

/** One load→save pass. */
export async function roundTrip(impl: RoundTripImpl, markdown: string): Promise<string> {
  return impl.save(await impl.load(markdown))
}
