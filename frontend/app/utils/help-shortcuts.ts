/**
 * What the help page at `/help/shortcuts` lists: the keys the app and the
 * editor answer to, the sequences that open a picker, and the markdown the
 * editor converts as it is typed.
 *
 * The rows live in the repo next to the code they describe, so a release
 * cannot ship a page naming a shortcut nothing binds. `appShortcuts` carries
 * the `defineShortcuts` id of every entry and `help-shortcuts.test.ts` reads
 * those ids back off `composables/useAppShortcuts.ts`.
 *
 * Every `what` is plain prose — the page renders it as text. A spelling that
 * has to read as code belongs in `keys` or `code`.
 */

/** One row of a key table: the keys as `UKbd` values, and what they do. */
export interface ShortcutRow {
  keys: string[]
  what: string
}

/** An app shortcut, named by the `defineShortcuts` id the layout binds. */
export interface AppShortcutRow {
  /** The `defineShortcuts` key, e.g. `meta_k`. */
  id: string
  what: string
}

/** One row of a markdown table: what is typed or stored, and what it means. */
export interface TypedRow {
  code: string
  what: string
}

/**
 * A `defineShortcuts` id as `UKbd` values — `meta_k` → `['meta', 'K']`.
 * `meta` renders ⌘ on macOS and Ctrl elsewhere; a single letter is a key cap.
 */
export function shortcutKeys(id: string): string[] {
  return id.split('_').map(part => (part.length === 1 ? part.toUpperCase() : part))
}

/** The app's own shortcuts — `composables/useAppShortcuts.ts`. */
export const appShortcuts: AppShortcutRow[] = [
  { id: 'meta_k', what: 'Go to search, with the caret in the query field' },
  { id: 'meta_j', what: 'Open or close the Ask OpenKnowledgebase chat' },
]

/** What the editor binds: TipTap's own keymaps, plus the Y.js undo history. */
export const editorShortcuts: ShortcutRow[] = [
  { keys: ['meta', 'Z'], what: 'Undo your own last change — never a co-editor’s' },
  { keys: ['meta', 'shift', 'Z'], what: 'Redo' },
  { keys: ['meta', 'Y'], what: 'Redo' },
  { keys: ['meta', 'B'], what: 'Bold' },
  { keys: ['meta', 'I'], what: 'Italic' },
  { keys: ['meta', 'U'], what: 'Underline' },
  { keys: ['meta', 'shift', 'S'], what: 'Strikethrough' },
  { keys: ['meta', 'E'], what: 'Inline code' },
  { keys: ['meta', 'alt', '2'], what: 'Heading — the digit is the level, 1 to 6. A page’s own H1 is its title field, so its text starts at 2' },
  { keys: ['meta', 'alt', '0'], what: 'Back to a plain paragraph' },
  { keys: ['meta', 'shift', '8'], what: 'Bullet list' },
  { keys: ['meta', 'shift', '7'], what: 'Ordered list' },
  { keys: ['meta', 'shift', '9'], what: 'Task list' },
  { keys: ['meta', 'shift', 'B'], what: 'Quote' },
  { keys: ['meta', 'alt', 'C'], what: 'Code block' },
  { keys: ['shift', 'enter'], what: 'Line break inside the block' },
  { keys: ['meta', 'enter'], what: 'Line break inside the block' },
  { keys: ['meta', 'X'], what: 'Cut the block its ⠿ gutter selected' },
  { keys: ['meta', 'C'], what: 'Copy that block, as markdown carrying its id' },
  { keys: ['meta', 'V'], what: 'Paste the clipboard at the caret. To put copied blocks in as blocks of their own, use “Paste below” in the ⠿ menu' },
  { keys: ['escape'], what: 'Leave a picker, keeping what was typed as text' },
]

/** The sequences that open something while typing in the editor. */
export const typedTriggers: TypedRow[] = [
  { code: '/', what: 'The block menu: every block this editor inserts — headings, lists, a table, code, a rule, an image, a callout, an infobox — plus a link to a page and a citation' },
  { code: '[[', what: 'Link to another page. Typing a title offers pages; adding # offers that page’s blocks' },
  { code: '[^', what: 'Cite the source this text comes from: a page, one of its blocks, or a pasted https:// address' },
  { code: '@', what: 'Mention a person' },
]

/** Markdown the editor turns into a block or a mark while it is typed. */
export const markdownRules: TypedRow[] = [
  { code: '# ', what: 'Heading. Up to six hashes for level 6' },
  { code: '- ', what: 'Bullet list — a star or a plus does the same' },
  { code: '1. ', what: 'Ordered list, starting at the number typed' },
  { code: '[ ] ', what: 'Task list item; put an x between the brackets for a ticked one' },
  { code: '> ', what: 'Quote' },
  { code: '```js ', what: 'Code block, in the language named after the fence. Three tildes open one too' },
  { code: '---', what: 'Horizontal rule' },
  { code: '**bold**', what: 'Bold — two underscores do the same' },
  { code: '*italic*', what: 'Italic — one underscore does the same' },
  { code: '~~strike~~', what: 'Strikethrough' },
  { code: '`code`', what: 'Inline code' },
]
