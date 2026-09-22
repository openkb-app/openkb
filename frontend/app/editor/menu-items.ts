import type { Editor, ChainedCommands } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import type { Transaction } from '@tiptap/pm/state'
import { requestMediaSelection } from '~/composables/useMediaLibraryPicker'
import { recordLinkSelection } from '~/editor/doc-link-selection'
import { CITATION_TAG } from '#shared/utils/citations'

type CalloutKind = 'info' | 'warning' | 'success' | 'danger'

interface CalloutCmd { type?: CalloutKind }

interface EditorHandler {
  canExecute(editor: Editor, cmd?: unknown): boolean
  execute(editor: Editor, cmd?: unknown): ChainedCommands
  isActive(editor: Editor, cmd?: unknown): boolean
  isDisabled?(editor: Editor, cmd?: unknown): boolean
}

/**
 * The table operations, as TipTap command names. A comark table is a GFM
 * pipe table — one header row, one cell per column.
 */
type TableOp = 'addRowBefore' | 'addRowAfter' | 'deleteRow'
  | 'addColumnBefore' | 'addColumnAfter' | 'deleteColumn' | 'deleteTable'

/**
 * Table commands are TipTap-native (@tiptap/extension-table); Nuxt UI's
 * UEditor ships no `table` handler, so these wrap the extension's own
 * commands in the declarative handler shape. `canExecute` already returns
 * false outside a table for the row/column ops, which is what disables the
 * toolbar buttons. Nested tables don't exist in GFM, so insertion is
 * blocked inside a table.
 */
function tableOpHandler(fnName: TableOp): EditorHandler {
  return {
    canExecute: editor => editor.can()[fnName](),
    execute: editor => editor.chain().focus()[fnName](),
    isActive: () => false,
  }
}

interface TableBlockCmd { pos: number, op: TableOp }

/**
 * The caret goes into the table's last cell before the operation runs.
 * prosemirror-tables reads its target off a selection inside the table, and
 * the block menu opens with the table itself node-selected — which is also
 * what makes "below" and "right" append rather than land after the first row.
 */
function tableBlockChain(chain: ChainedCommands, editor: Editor, cmd: TableBlockCmd): ChainedCommands | null {
  const { doc } = editor.state
  // A peer transaction can shift the position out from under an open menu;
  // `nodeAt` throws past the end, and this runs inside the menu's computed.
  const node = cmd.pos >= 0 && cmd.pos < doc.content.size ? doc.nodeAt(cmd.pos) : null
  if (!node) return null
  return chain.setTextSelection(TextSelection.near(doc.resolve(cmd.pos + node.nodeSize - 1), -1).from)[cmd.op]()
}

const LIST_TYPES = ['bulletList', 'orderedList', 'taskList']

/**
 * GFM has no tables inside lists — a table swallowed into a list item
 * serializes to indented markdown that comark renders as literal text. When
 * the caret sits in a list, the position after the outermost enclosing list
 * is where the table must go instead.
 */
function posAfterEnclosingList(editor: Editor): number | null {
  const { $from } = editor.state.selection
  for (let depth = 1; depth <= $from.depth; depth++) {
    if (LIST_TYPES.includes($from.node(depth).type.name)) return $from.after(depth)
  }
  return null
}

/** Puts the caret in the block at `pos`, then applies the target's own command. */
function turnIntoChain(chain: ChainedCommands, editor: Editor, cmd: TurnIntoCmd): ChainedCommands {
  const op = TURN_INTO_OPS[cmd.target]
  if (!op) return chain
  const pos = Math.min(cmd.pos + 1, editor.state.doc.content.size)
  return op(chain.setTextSelection(pos), cmd.level)
}

/** The block shapes the block menu's "Turn into" offers, as chain steps. */
const TURN_INTO_OPS: Record<string, (chain: ChainedCommands, level?: number) => ChainedCommands> = {
  paragraph: chain => chain.setParagraph(),
  heading: (chain, level) => chain.toggleHeading({ level: (level ?? 2) as 1 | 2 | 3 }),
  bulletList: chain => chain.toggleBulletList(),
  orderedList: chain => chain.toggleOrderedList(),
  taskList: chain => chain.toggleTaskList(),
  blockquote: chain => chain.toggleBlockquote(),
  codeBlock: chain => chain.toggleCodeBlock(),
}

interface TurnIntoCmd { pos: number, target: string, level?: number }

export const comarkHandlers: Record<string, EditorHandler> = {
  /**
   * Re-shapes one block, named by position.
   *
   * Nuxt UI's own `heading`/`paragraph`/list handlers act on the selection,
   * and the block menu opens with the block NODE-selected — a shape
   * `setBlockType` will not apply to, so every target would offer itself
   * disabled. Putting the caret in the block first is what the same commands
   * need, and taking the position from the item rather than from the selection
   * is what keeps the offer and the action about the same block.
   */
  turnInto: {
    canExecute: (editor, cmd) => turnIntoChain(editor.can().chain(), editor, cmd as TurnIntoCmd).run(),
    execute: (editor, cmd) => turnIntoChain(editor.chain().focus(), editor, cmd as TurnIntoCmd),
    isActive: () => false,
  },
  table: {
    canExecute: editor => editor.can().insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
    // insertTable is bare replaceSelectionWith at the caret (no placement
    // option), so with the caret in a list the handler lifts it out first:
    // an empty paragraph after the list, caret inside — replaceSelectionWith
    // then swallows the empty textblock, leaving the table right after the
    // list at the top level.
    execute: (editor) => {
      const chain = editor.chain().focus()
      const pos = posAfterEnclosingList(editor)
      if (pos !== null) {
        chain.insertContentAt(pos, { type: 'paragraph' }).setTextSelection(pos + 1)
      }
      return chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true })
    },
    isActive: editor => editor.isActive('table'),
    isDisabled: editor => editor.isActive('table'),
  },
  tableAddRowBefore: tableOpHandler('addRowBefore'),
  tableAddRowAfter: tableOpHandler('addRowAfter'),
  tableDeleteRow: tableOpHandler('deleteRow'),
  tableAddColumnBefore: tableOpHandler('addColumnBefore'),
  tableAddColumnAfter: tableOpHandler('addColumnAfter'),
  tableDeleteColumn: tableOpHandler('deleteColumn'),
  tableDeleteTable: tableOpHandler('deleteTable'),
  tableBlockOp: {
    canExecute: (editor, cmd) => tableBlockChain(editor.can().chain(), editor, cmd as TableBlockCmd)?.run() ?? false,
    execute: (editor, cmd) => tableBlockChain(editor.chain().focus(), editor, cmd as TableBlockCmd) ?? editor.chain(),
    isActive: () => false,
  },
  callout: {
    canExecute: editor => editor.can().insertContent(''),
    execute: (editor, cmd) => editor.chain().focus().insertContent({
      type: 'callout',
      attrs: { type: (cmd as CalloutCmd)?.type ?? 'info' },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'New callout — type here.' }] }],
    }),
    isActive: (editor, cmd) => editor.isActive('callout', { type: (cmd as CalloutCmd)?.type }),
  },
  infobox: {
    canExecute: editor => editor.can().insertContent(''),
    execute: editor => editor.chain().focus().insertContent({
      type: 'infobox',
      attrs: { title: 'Info' },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'New infobox — set a title above and edit text here.' }] }],
    }),
    isActive: editor => editor.isActive('infobox'),
  },
  // Types the `[[` the picker popover is keyed on (editor/components/
  // DocLinkMenu.vue), so the slash menu and the toolbar need no second opener.
  // The `[[` goes after a selection rather than over it, so the words stay on
  // screen while the picker is open; a pick replaces both with the link and
  // keeps the words as its label (editor/doc-link-selection.ts). On a caret the
  // link carries the target's own title.
  docLink: {
    canExecute: editor => editor.can().insertContent('[['),
    execute: (editor) => {
      const { from, to } = editor.state.selection
      if (from !== to) {
        recordLinkSelection(editor.state.doc.textBetween(from, to, ' '), to, { from, to })
      }
      return editor.chain().focus().setTextSelection(to).insertContent('[[')
    },
    isActive: editor => editor.isActive('docLink'),
  },
  // Types the `[^` the same picker's citation mode is keyed on. A citation
  // carries no words of its own, so it goes after a selection rather than
  // over it.
  cite: {
    canExecute: editor => editor.can().insertContent('[^'),
    execute: editor => editor.chain().focus().setTextSelection(editor.state.selection.to).insertContent('[^'),
    isActive: editor => editor.isActive(CITATION_TAG),
  },
  // Replaces UEditor's built-in image handler (a bare URL prompt): opens
  // Drupal's media-library dialog and inserts one media-image node per
  // selected UUID. The selection is async — execute() captures the insert
  // position and kicks the dialog off, returning an unmodified chain; the
  // insertion runs when the dialog settles. The position is captured at
  // execute() time because the dialog steals focus and selection — reading
  // it at settle time lands the insert at the doc start. While the dialog
  // is open the captured position is mapped through every transaction, so
  // it stays anchored to the same spot when the document changes under it
  // (collaborative edits, stray selection resets). Like tables, images are
  // lifted out of lists (GFM has no block content in list items the editor
  // could keep canonical).
  image: {
    canExecute: editor => editor.can().insertContent(''),
    execute: (editor) => {
      let insertPos = posAfterEnclosingList(editor) ?? editor.state.selection.to
      const track = ({ transaction }: { transaction: Transaction }) => {
        insertPos = transaction.mapping.map(insertPos)
      }
      editor.on('transaction', track)
      requestMediaSelection().then((uuids) => {
        if (!uuids || uuids.length === 0) return
        const images = uuids.map(uuid => ({ type: 'image', attrs: { media: uuid, alt: '' } }))
        // Belt and braces on top of the mapping: never insert past the end.
        const pos = Math.min(insertPos, editor.state.doc.content.size)
        // Text cursor after the images, not the NodeSelection insertContentAt
        // leaves: with the image node-selected, the next typed character
        // would REPLACE the image.
        editor.chain().focus().insertContentAt(pos, images).setTextSelection(pos + images.length).run()
      }).catch((error) => {
        console.error('Media-library dialog failed', error)
      }).finally(() => {
        editor.off('transaction', track)
      })
      return editor.chain()
    },
    isActive: editor => editor.isActive('image'),
  },
}

/**
 * The rarer block inserts, offered by both the slash menu and the formatting
 * toolbar's (+) menu — one list so the two never drift. `kind` routes each
 * through the editor handler map (createHandlers + comarkHandlers); the
 * AI-prompt placeholder has no command yet, so the (+) menu appends it
 * separately with the session's own handler.
 */
export const insertBlockItems = [
  { kind: 'taskList', label: 'Task list', icon: 'i-lucide-list-todo', description: 'Checklist with checkboxes' },
  { kind: 'codeBlock', label: 'Code block', icon: 'i-lucide-code', description: 'Fenced code block' },
  { kind: 'horizontalRule', label: 'Horizontal rule', icon: 'i-lucide-minus', description: 'Divider line' },
  { kind: 'callout', type: 'info', label: 'Callout', icon: 'i-lucide-info', description: 'Info box — switch the type inside' },
  { kind: 'infobox', label: 'Infobox', icon: 'i-lucide-square', description: 'Titled bordered box' },
]

const [taskList, codeBlock, horizontalRule] = insertBlockItems
const comarkInserts = insertBlockItems.slice(3)

export const slashItems = [[
  { type: 'label', label: 'Text' },
  { kind: 'heading', level: 2, label: 'Heading 2', icon: 'i-lucide-heading-2', description: 'Section heading' },
  { kind: 'heading', level: 3, label: 'Heading 3', icon: 'i-lucide-heading-3', description: 'Sub-section heading' },
  { kind: 'bulletList', label: 'Bullet list', icon: 'i-lucide-list', description: 'Unordered list' },
  { kind: 'orderedList', label: 'Ordered list', icon: 'i-lucide-list-ordered', description: 'Numbered list' },
  taskList,
  { kind: 'table', label: 'Table', icon: 'i-lucide-table', description: '3×3 table with header row' },
  codeBlock,
  horizontalRule,
  { kind: 'image', label: 'Image', icon: 'i-lucide-image', description: 'Image from the media library' },
  { kind: 'docLink', label: 'Link to a page', icon: 'i-lucide-file-symlink', description: 'Link to another page or one of its blocks' },
  { kind: 'cite', label: 'Cite a source', icon: 'i-lucide-quote', description: 'Cite the page or block this text comes from' },
  { type: 'label', label: 'Comark' },
  ...comarkInserts,
]]

/**
 * The row and column operations, in the order every table surface offers
 * them. One list, so the toolbar dropdown, the bubble group and the block
 * menu never drift. `op` is the TipTap command name the block menu runs
 * against a position; `kind` the handler the other two dispatch by.
 */
export const tableOpItems = [
  { kind: 'tableAddRowBefore', op: 'addRowBefore', label: 'Add row above', icon: 'i-lucide-between-horizontal-start' },
  { kind: 'tableAddRowAfter', op: 'addRowAfter', label: 'Add row below', icon: 'i-lucide-between-horizontal-end' },
  { kind: 'tableDeleteRow', op: 'deleteRow', label: 'Delete row', icon: 'i-lucide-rows-3' },
  { kind: 'tableAddColumnBefore', op: 'addColumnBefore', label: 'Add column left', icon: 'i-lucide-between-vertical-start' },
  { kind: 'tableAddColumnAfter', op: 'addColumnAfter', label: 'Add column right', icon: 'i-lucide-between-vertical-end' },
  { kind: 'tableDeleteColumn', op: 'deleteColumn', label: 'Delete column', icon: 'i-lucide-columns-3' },
] as const satisfies ReadonlyArray<{ kind: string, op: TableOp, label: string, icon: string }>

/** The contextual table controls — a dropdown on the formatting toolbar. */
export const tableToolbarItem = {
  label: 'Table',
  icon: 'i-lucide-table',
  tooltip: { text: 'Table' },
  items: [
    { kind: 'table', label: 'Insert table', icon: 'i-lucide-table' },
    ...tableOpItems.map(({ kind, label, icon }) => ({ kind, label, icon })),
    { kind: 'tableDeleteTable', label: 'Delete table', icon: 'i-lucide-trash-2' },
  ],
}

/** The same operations as the bubble toolbar's icon-only group. */
export const tableBubbleItems = tableOpItems.map(({ kind, icon, label }) => ({
  kind,
  icon,
  'aria-label': label,
  tooltip: { text: label },
}))
