import { TaskItem, TaskList } from '@tiptap/extension-list'
import { OkbCodeBlock } from './nodes/code-block'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import type { AnyExtension, Node } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import { comarkEditorParts } from '#okb-comark-editor-parts'
import { comarkComponentDeclarations } from '#shared/utils/comark-components'
import { BlockId } from './nodes/block-id'
import { buildComarkComponentNodes } from './nodes/comark-component-nodes'
import { OkbMention } from './nodes/mention'
import { OkbOrderedList } from './nodes/ordered-list'
import CodeBlockNodeView from '../components/CodeBlockNodeView.vue'
import ComponentNodeView from '../components/ComponentNodeView.vue'
import { CaretMemory } from './cite-insert'
import { CiteNumbers } from './cite-numbers'
import { codeHighlightPlugin } from './code-highlight'
import { fenceErrorPlugin } from './fence-error'
import { fenceFor } from '#shared/utils/fences'
import { DocLinkSelection } from './doc-link-selection'
import { HiddenCaretKeys } from './hidden-caret'
import { PageFileDropHandler } from './drop-files'
import { LinkOpen } from './link-open'
import { LinkTargetKeys } from './link-target'
import { PageImageFileHandler } from './paste-image'
import { SelectionKeydownSync } from './selection-sync'

/** The editor nodes of the comark components with their node views, and the extensions their editor parts add. */
function buildComarkComponentEditorExtensions(): AnyExtension[] {
  return buildComarkComponentNodes().flatMap(([tag, nodes]) => {
    const part = comarkEditorParts[tag]
    if (comarkComponentDeclarations[tag]?.inline) return [...nodes, ...(part?.extensions ?? [])]
    const nodeView = part?.nodeView ?? ComponentNodeView
    return [
      ...nodes.map(node => (node as Node).extend({
        addNodeView() {
          return VueNodeViewRenderer(nodeView)
        },
      })),
      ...(part?.extensions ?? []),
    ]
  })
}

/**
 * Comark nodes layered on top of what Nuxt UI's UEditor already loads
 * (StarterKit + image + horizontal-rule + code):
 *
 * - The comark components' nodes, each block with its node view: the
 *   component's own editor part, or the generic `ComponentNodeView`. Chips
 *   stay native DOM (ADR 0026).
 * - The code block's NodeView (language picker, a fence component's
 *   preview) and its highlighting.
 * - GFM tables + task lists — comark parses both, so the schema must
 *   carry them or an edit+save destroys the content (round-trip corpus
 *   in test/roundtrip/ enforces this).
 * - The code block and the ordered list replace StarterKit's copies, which
 *   the pages disable (`codeBlock: false, orderedList: false` in `:starter-kit`).
 *
 * The node SCHEMA (name / attrs / parse+render HTML) lives in the Vue-free
 * ./nodes/ modules, which the server-side commit schema
 * (server/utils/editor-schema.ts) reuses verbatim. Here we only add the
 * live-preview Vue NodeViews via `.extend()`, so the client and the
 * headless commit path serialize against one shared schema definition.
 *
 * The slash menu, mention popover, and toolbar are wired declaratively in
 * pages/node/[id]/edit.vue via <UEditorSuggestionMenu>, <UEditorMentionMenu>,
 * <UEditorToolbar>, and the `:handlers` prop — no hand-rolled extensions
 * needed for those.
 */
export function buildEditorExtensions() {
  return [
    SelectionKeydownSync,
    CaretMemory,
    DocLinkSelection,
    LinkOpen,
    LinkTargetKeys,
    PageImageFileHandler,
    PageFileDropHandler,
    CiteNumbers,
    HiddenCaretKeys,
    BlockId,
    ...buildComarkComponentEditorExtensions(),
    OkbMention,
    OkbCodeBlock.extend({
      addStorage() {
        // A fence's open source survives a rebuild of its node view.
        return { openFences: new Set<string>() }
      },
      addNodeView() {
        return VueNodeViewRenderer(CodeBlockNodeView, {
          // A fence component's block has another root element: ProseMirror rebuilds the view.
          update: ({ oldNode, newNode, updateProps }) => {
            if (newNode.type !== oldNode.type) return false
            if (fenceFor(oldNode.attrs.language)?.language !== fenceFor(newNode.attrs.language)?.language) return false
            updateProps()
            return true
          },
          // Outside the editable code only a mousedown or a drag reaches ProseMirror: keys on a drawing's link or the toggle stay theirs.
          stopEvent: ({ event }) => event.target instanceof Element
            && !event.target.closest('[data-node-view-content]')
            && event.type !== 'mousedown' && !event.type.startsWith('drag') && event.type !== 'drop',
        })
      },
      addProseMirrorPlugins() {
        return [...(this.parent?.() ?? []), codeHighlightPlugin(this.name), fenceErrorPlugin()]
      },
    }),
    OkbOrderedList,
    Table,
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({ nested: true }),
  ]
}
