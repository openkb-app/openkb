// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { emojis } from '@tiptap/extension-emoji'
import { SHORTCODE_ALIASES, emojiPresentationItems, emojiShortcodeInputRule, isEmojiQuery, withEmojiPresentation, withShortcodeAliases } from './emoji-shortcodes'

const editors: Editor[] = []
afterEach(() => { editors.splice(0).forEach(editor => editor.destroy()) })

/** Types `text` into a fresh editor one character at a time, so input rules run, and returns the editor. */
function editorWithTyped(text: string, setup?: (editor: Editor) => void): Editor {
  const editor = new Editor({ extensions: [StarterKit, emojiShortcodeInputRule(emojiPresentationItems(withShortcodeAliases(emojis)))] })
  editors.push(editor)
  setup?.(editor)
  for (const char of text) {
    const { from, to } = editor.state.selection
    const handled = editor.view.someProp('handleTextInput', f => f(editor.view, from, to, char, () => editor.state.tr.insertText(char, from, to)))
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(char, from, to))
  }
  return editor
}

/** Types `text` into a fresh editor and returns the paragraph text. */
function typeIntoEditor(text: string, setup?: (editor: Editor) => void): string {
  return editorWithTyped(text, setup).state.doc.textContent
}

describe('withEmojiPresentation', () => {
  it('adds U+FE0F to a text-default symbol', () => {
    expect(withEmojiPresentation('⚠')).toBe('⚠️')
    expect(withEmojiPresentation('❤')).toBe('❤️')
  })

  it('leaves emoji-default characters and sequences alone', () => {
    expect(withEmojiPresentation('✅')).toBe('✅')
    expect(withEmojiPresentation('❌')).toBe('❌')
    expect(withEmojiPresentation('👍🏽')).toBe('👍🏽')
    expect(withEmojiPresentation('⚠️')).toBe('⚠️')
  })

  it('gives warning its emoji form in the menu data', () => {
    expect(emojiPresentationItems(emojis).find(item => item.shortcodes.includes('warning'))?.emoji).toBe('⚠️')
  })
})

describe('withShortcodeAliases', () => {
  it('adds every alias to exactly one emoji, and no alias is a shortcode already', () => {
    const aliased = withShortcodeAliases(emojis)
    for (const alias of Object.keys(SHORTCODE_ALIASES)) {
      expect(emojis.some(item => item.shortcodes.includes(alias)), alias).toBe(false)
      expect(aliased.filter(item => item.shortcodes.includes(alias)), alias).toHaveLength(1)
    }
  })

  it('keeps the original shortcodes first', () => {
    expect(withShortcodeAliases(emojis).find(item => item.shortcodes.includes('warn'))?.shortcodes).toEqual(['warning', 'warn'])
  })
})

describe('isEmojiQuery', () => {
  it('accepts two characters, or one that is a whole shortcode', () => {
    expect(isEmojiQuery('ch', emojis)).toBe(true)
    expect(isEmojiQuery('x', emojis)).toBe(true)
  })

  it('rejects an empty query and a single character that is no shortcode', () => {
    expect(isEmojiQuery('', emojis)).toBe(false)
    expect(isEmojiQuery('D', emojis)).toBe(false)
    expect(isEmojiQuery('P', emojis)).toBe(false)
  })
})

describe('emojiShortcodeInputRule', () => {
  it('replaces a closed shortcode', () => {
    expect(typeIntoEditor('done :x:')).toBe('done ❌')
    expect(typeIntoEditor(':white_check_mark: ok')).toBe('✅ ok')
    expect(typeIntoEditor('a :warning:')).toBe('a ⚠️')
    expect(typeIntoEditor('a :warn:')).toBe('a ⚠️')
    expect(typeIntoEditor('a :done:')).toBe('a ✅')
  })

  it('gives the shortcode back on undoInputRule', () => {
    const editor = editorWithTyped('done :x:')
    expect(editor.state.doc.textContent).toBe('done ❌')
    editor.commands.undoInputRule()
    expect(editor.state.doc.textContent).toBe('done :x:')
  })

  it('keeps unknown shortcodes and colons inside words, times and URLs', () => {
    expect(typeIntoEditor('a :nosuchemoji:')).toBe('a :nosuchemoji:')
    expect(typeIntoEditor('at 10:30:')).toBe('at 10:30:')
    expect(typeIntoEditor('foo:x:')).toBe('foo:x:')
  })

  it('keeps shortcodes in code', () => {
    expect(typeIntoEditor(':x:', editor => editor.commands.setCodeBlock())).toBe(':x:')
    expect(typeIntoEditor(':x:', editor => editor.commands.setMark('code'))).toBe(':x:')
  })
})
