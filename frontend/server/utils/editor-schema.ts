import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Code from '@tiptap/extension-code'
import HorizontalRule from '@tiptap/extension-horizontal-rule'
import type { Schema } from '@tiptap/pm/model'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import { BlockId } from '../../app/editor/nodes/block-id'
import { BlockWrapper } from '../../app/editor/nodes/block-wrapper'
import { Callout } from '../../app/editor/nodes/callout'
import { OkbCite } from '../../app/editor/nodes/cite'
import { OkbDocLink } from '../../app/editor/nodes/doc-link'
import { OkbImage } from '../../app/editor/nodes/image'
import { Infobox } from '../../app/editor/nodes/infobox'
import { OkbMention } from '../../app/editor/nodes/mention'
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
} from '../../app/editor/nodes/markdown-overrides'

/**
 * Schema-only mirror of the live editor's extension set — no Vue, no
 * NodeViews, no jsdom. The headless commit service (server/utils/commit.ts)
 * needs a ProseMirror Schema to turn a Y.Doc fragment back into a document it
 * can serialize to comark markdown; it must be the SAME schema (node + mark
 * names and attributes) the browser editor uses, or serialization drifts.
 *
 * The set replicates what Nuxt UI's UEditor registers in
 * node_modules/@nuxt/ui/dist/runtime/components/Editor.vue:
 *
 *   StarterKit.configure({ code: false, horizontalRule: false, link })
 *   Code.extend({ excludes: 'code' })
 *   HorizontalRule (re-added because StarterKit's copy is disabled)
 *   Mention
 *
 * UEditor's own Image copy is disabled (`:image="false"` on the edit pages)
 * in favor of OkbImage — the same node extended with the `media` attribute
 * and the `::image` fence grammar (see app/editor/nodes/image.ts).
 *
 * plus the GFM Table family + TaskList/TaskItem and our own Callout / Infobox
 * nodes — the latter imported from the exact Vue-free modules
 * app/editor/extensions.ts wraps with NodeViews, so there is one schema
 * definition, not a hand-copied duplicate. editor-schema.test.ts is the drift
 * tripwire: it diffs this schema against the live editor's own schema (the
 * UEditor base exported here + buildEditorExtensions()), so any
 * schema-contributing extension added on one side and not the other fails.
 *
 * Extensions that add ProseMirror plugins but no schema (Collaboration,
 * CollaborationCaret, Placeholder, the mention suggestion) are intentionally
 * omitted — they contribute nothing to a Schema and some pull in browser-only
 * code. Markdown parsing is never done here (that is the client's HTML-seed
 * job); the server only serializes an already-synced Y.Doc.
 */
export function buildUEditorBaseExtensions() {
  return [
    StarterKit.configure({
      code: false,
      horizontalRule: false,
      // Replaced below by comark-canonical markdown overrides (same
      // schema, different markdown grammar) — see markdown-overrides.ts.
      codeBlock: false,
      hardBreak: false,
      heading: false,
      link: false,
      listItem: false,
      paragraph: false,
      underline: false,
    }),
    Code.extend({ excludes: 'code' }),
    HorizontalRule,
    OkbMention,
    OkbCodeBlock,
    OkbHardBreak,
    OkbHeading,
    OkbLink.configure({ openOnClick: false }),
    OkbListItem,
    OkbParagraph,
    OkbUnderline,
  ]
}

export function buildCommitSchemaExtensions() {
  return [
    ...buildUEditorBaseExtensions(),
    ...markdownOverrideExtensions(),
    BlockId,
    BlockWrapper,
    Callout,
    OkbCite,
    OkbDocLink,
    Infobox,
    OkbImage,
    OkbTable,
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({ nested: true }),
  ]
}

/** Built once — a Schema is immutable and reused across every commit. */
export const editorSchema: Schema = getSchema(buildCommitSchemaExtensions())
