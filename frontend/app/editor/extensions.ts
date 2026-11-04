import { TaskItem, TaskList } from '@tiptap/extension-list'
import { OkbCodeBlock } from './nodes/code-block'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import { BlockId } from './nodes/block-id'
import { Callout } from './nodes/callout'
import { OkbCite } from './nodes/cite'
import { OkbDocLink } from './nodes/doc-link'
import { OkbImage } from './nodes/image'
import { OkbAttachment, OkbAttachmentInline } from './nodes/attachment'
import { OkbEmbed } from './nodes/embed'
import { Infobox } from './nodes/infobox'
import { OkbMention } from './nodes/mention'
import { OkbOrderedList } from './nodes/ordered-list'
import CalloutNodeView from '../components/CalloutNodeView.vue'
import CodeBlockNodeView from '../components/CodeBlockNodeView.vue'
import ImageNodeView from '../components/ImageNodeView.vue'
import AttachmentNodeView from '../components/AttachmentNodeView.vue'
import EmbedNodeView from '../components/EmbedNodeView.vue'
import InfoboxNodeView from '../components/InfoboxNodeView.vue'
import { CaretMemory } from './cite-insert'
import { CiteNumbers } from './cite-numbers'
import { codeHighlightPlugin } from './code-highlight'
import { fenceCaretPlugin } from './fence-caret'
import { fenceErrorPlugin } from './fence-error'
import { fenceFor } from '#shared/utils/fences'
import { DocLinkSelection } from './doc-link-selection'
import { PageFileDropHandler } from './drop-files'
import { LinkOpen } from './link-open'
import { LinkTargetKeys } from './link-target'
import { PageImageFileHandler } from './paste-image'
import { SelectionKeydownSync } from './selection-sync'

/**
 * Comark nodes layered on top of what Nuxt UI's UEditor already loads
 * (StarterKit + image + horizontal-rule + code):
 *
 * - Callout / Infobox NodeViews for the ::fence components.
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
    BlockId,
    Callout.extend({
      addNodeView() {
        return VueNodeViewRenderer(CalloutNodeView)
      },
    }),
    Infobox.extend({
      addNodeView() {
        return VueNodeViewRenderer(InfoboxNodeView)
      },
    }),
    OkbImage.extend({
      addNodeView() {
        return VueNodeViewRenderer(ImageNodeView)
      },
    }),
    OkbAttachment.extend({
      addNodeView() {
        return VueNodeViewRenderer(AttachmentNodeView)
      },
    }),
    OkbAttachmentInline.extend({
      addNodeView() {
        return VueNodeViewRenderer(AttachmentNodeView)
      },
    }),
    OkbEmbed.extend({
      addNodeView() {
        return VueNodeViewRenderer(EmbedNodeView)
      },
    }),
    OkbCite,
    OkbDocLink,
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
        return [...(this.parent?.() ?? []), codeHighlightPlugin(this.name), fenceErrorPlugin(), fenceCaretPlugin(this.name)]
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
