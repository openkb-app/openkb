import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Code from '@tiptap/extension-code'
import HorizontalRule from '@tiptap/extension-horizontal-rule'
import type { Schema } from '@tiptap/pm/model'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import { BlockId } from '../../app/editor/nodes/block-id'
import { buildComarkComponentNodes } from '../../app/editor/nodes/comark-component-nodes'
import { OkbLink } from '../../app/editor/nodes/link'
import { OkbMention } from '../../app/editor/nodes/mention'
import { OkbOrderedList } from '../../app/editor/nodes/ordered-list'
import { OkbCodeBlock } from '../../app/editor/nodes/code-block'

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
 * in favor of OkbImage — the same node extended with the `file` attribute
 * (see app/editor/nodes/image.ts). StarterKit's code block, ordered list and
 * link are disabled the same way, for our own (the client's NodeView; a digit
 * list only, app/editor/nodes/ordered-list.ts; the link below code,
 * app/editor/nodes/link.ts).
 *
 * plus the GFM Table family + TaskList/TaskItem and the comark components'
 * nodes — built by the same Vue-free call app/editor/extensions.ts wraps with
 * node views, so there is one schema definition, not a hand-copied duplicate. editor-schema.test.ts is the drift
 * tripwire: it diffs this schema against the live editor's own schema (the
 * UEditor base exported here + buildEditorExtensions()), so any
 * schema-contributing extension added on one side and not the other fails.
 *
 * Extensions that add ProseMirror plugins but no schema (Collaboration,
 * CollaborationCaret, Placeholder, the mention suggestion) are intentionally
 * omitted — they contribute nothing to a Schema and some pull in browser-only
 * code.
 */
export function buildUEditorBaseExtensions() {
  return [
    StarterKit.configure({
      code: false,
      horizontalRule: false,
      // The pages disable them too: buildEditorExtensions brings its own.
      codeBlock: false,
      orderedList: false,
      link: false,
    }),
    Code.extend({ excludes: 'code' }),
    HorizontalRule,
    OkbLink,
    OkbMention,
    OkbCodeBlock,
    OkbOrderedList,
  ]
}

/** The commit schema's extensions: the UEditor base plus the app's own nodes. */
export function buildCommitSchemaExtensions() {
  return [
    ...buildUEditorBaseExtensions(),
    BlockId,
    ...buildComarkComponentNodes().flatMap(([, nodes]) => nodes),
    Table,
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({ nested: true }),
  ]
}

/** Built once — a Schema is immutable and reused across every commit. */
export const editorSchema: Schema = getSchema(buildCommitSchemaExtensions())
