import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import { BlockId } from './nodes/block-id'
import { BlockWrapper } from './nodes/block-wrapper'
import { Callout } from './nodes/callout'
import { OkbCite } from './nodes/cite'
import { OkbDocLink } from './nodes/doc-link'
import { OkbImage } from './nodes/image'
import { Infobox } from './nodes/infobox'
import { OkbMention } from './nodes/mention'
import {
  OkbCodeBlock,
  OkbHardBreak,
  OkbHeading,
  OkbLink,
  OkbListItem,
  OkbParagraph,
  OkbTable,
  OkbUnderline,
  markdownOverrideExtensions,
} from './nodes/markdown-overrides'
import CalloutNodeView from '../components/CalloutNodeView.vue'
import ImageNodeView from '../components/ImageNodeView.vue'
import InfoboxNodeView from '../components/InfoboxNodeView.vue'
import { CiteNumbers } from './cite-numbers'
import { DocLinkSelection } from './doc-link-selection'
import { SelectionKeydownSync } from './selection-sync'

/**
 * StarterKit sub-extensions the pages must disable (`:starter-kit` prop)
 * because buildEditorExtensions ships a comark-canonical markdown
 * replacement — same schema, different markdown grammar (see
 * ./nodes/markdown-overrides.ts). UEditor's own Mention and Image copies
 * are disabled the same way (`:mention="false"`, `:image="false"`) in
 * favor of ./nodes/mention.ts (round-trips the Drupal uid) and
 * ./nodes/image.ts (carries the Drupal media UUID + ::image grammar).
 */
export const starterKitMarkdownOverrides = {
  codeBlock: false,
  hardBreak: false,
  heading: false,
  link: false,
  listItem: false,
  paragraph: false,
  underline: false,
} as const

/**
 * Comark nodes layered on top of what Nuxt UI's UEditor already loads
 * (StarterKit + image + horizontal-rule + code):
 *
 * - Callout / Infobox NodeViews for the ::fence components.
 * - GFM tables + task lists — comark parses both, so the schema must
 *   carry them or an edit+save destroys the content (round-trip corpus
 *   in test/roundtrip/ enforces this).
 * - The comark-canonical markdown override set (Okb*), replacing the
 *   StarterKit copies disabled via starterKitMarkdownOverrides, so the
 *   editor's own markdown surface (content-type="markdown") shares the
 *   engine's grammar.
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
    DocLinkSelection,
    CiteNumbers,
    BlockId,
    BlockWrapper,
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
    OkbCite,
    OkbDocLink,
    OkbMention,
    OkbCodeBlock,
    OkbHardBreak,
    OkbHeading,
    OkbLink.configure({ openOnClick: false }),
    OkbListItem,
    OkbParagraph,
    OkbUnderline,
    ...markdownOverrideExtensions(),
    OkbTable,
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({ nested: true }),
  ]
}
