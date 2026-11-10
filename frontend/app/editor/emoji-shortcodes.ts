import { Extension, InputRule } from '@tiptap/core'
import { shortcodeToEmoji, type EmojiItem } from '@tiptap/extension-emoji'

// Import lazily: this module pulls in the whole emoji library.
export { emojis } from '@tiptap/extension-emoji'

/** Short names for the status emoji pages use most, on top of the GitHub/Slack shortcodes. */
export const SHORTCODE_ALIASES: Readonly<Record<string, string>> = {
  warn: 'warning',
  check: 'white_check_mark',
  done: 'white_check_mark',
  error: 'x',
  tip: 'bulb',
  idea: 'bulb',
  note: 'memo',
  wip: 'construction',
}

/** The emoji data with each alias added to the shortcodes of the emoji it names. */
export function withShortcodeAliases<T extends EmojiItem>(items: readonly T[]): T[] {
  return items.map((item) => {
    const added = Object.keys(SHORTCODE_ALIASES).filter(alias => item.shortcodes.includes(SHORTCODE_ALIASES[alias]!))
    return added.length ? { ...item, shortcodes: [...item.shortcodes, ...added] } : item
  })
}

/** Adds U+FE0F to a lone symbol that renders as a text glyph by default (⚠ → ⚠️). */
export function withEmojiPresentation(emoji: string): string {
  return /^\p{Extended_Pictographic}$/u.test(emoji) && !/\p{Emoji_Presentation}/u.test(emoji)
    ? `${emoji}\u{FE0F}`
    : emoji
}

/** The emoji data with every character in its emoji presentation. */
export function emojiPresentationItems<T extends EmojiItem>(items: readonly T[]): T[] {
  return items.map(item => item.emoji ? { ...item, emoji: withEmojiPresentation(item.emoji) } : item)
}

/** Whether a menu query is long enough: two characters, or one that is a whole shortcode (`:x`). */
export function isEmojiQuery(query: string, items: readonly EmojiItem[]): boolean {
  return query.length >= 2 || (query.length === 1 && items.some(item => item.shortcodes.includes(query)))
}

/** Replaces a closed shortcode after a space or at the line start (`:x:` → ❌), as GitHub and Slack do. */
export function emojiShortcodeInputRule(items: EmojiItem[]) {
  return Extension.create({
    name: 'emojiShortcodeInputRule',
    addInputRules() {
      return [new InputRule({
        find: /(?:^|\s)(:([a-z0-9_+-]+):)$/,
        handler: ({ state, range, match }) => {
          const emoji = shortcodeToEmoji(match[2]!, items)?.emoji
          if (!emoji) return null
          state.tr.insertText(emoji, range.from + match[0].lastIndexOf(match[1]!), range.to)
        },
      })]
    },
  })
}
