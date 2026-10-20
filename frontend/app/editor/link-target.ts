import { Extension, getMarkRange, isTextSelection } from '@tiptap/core'
import { isChangeOrigin } from '@tiptap/extension-collaboration'
import type { Editor } from '@tiptap/core'
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { keydownHandler } from '@tiptap/pm/keymap'
import type { EditorState } from '@tiptap/pm/state'
import type { Node } from '@tiptap/pm/model'
import { recordLinkSelection } from './doc-link-selection'
import { trackRange } from './tracked-range'
import type { LinkSelection } from './doc-link-selection'
import { docLinkHref } from '#shared/utils/doc-links'
import { CITATION_TAG, citeTarget } from '#shared/utils/citations'

/**
 * What the link bubble is about: a link mark, a page link, a link to a page
 * file or a citation, and where it sits. Vue-free, so the bubble (components/LinkTargetBubble.vue),
 * the toolbar's Link button and the keymap share one reading of the state.
 */
export type LinkTarget =
  | { kind: 'link', from: number, to: number, attrs: { href: string } }
  | { kind: 'docLink', from: number, to: number, attrs: DocLinkAttrs }
  | { kind: 'citation', from: number, to: number, attrs: CitationAttrs }
  | { kind: 'attachment', from: number, to: number, attrs: AttachmentLinkAttrs }

interface AttachmentLinkAttrs { file: string | null, label: string }
interface DocLinkAttrs { nid: number | null, block: string | null, label: string }
interface CitationAttrs { nid: number | null, block: string | null, v: string | null, url: string | null }

/** A file of this page, as the bubble offers it. */
export interface PageFileChoice {
  uuid: string
  name: string
  size: number
  url: string
}

/** This page's files for the bubble: the list, and the file picker. */
export interface PageFileSource {
  list: () => PageFileChoice[]
  /** Puts the file the picker gives on the page once `link` embeds it (an upload is listed anyway). */
  pick: (link: (uuid: string) => boolean) => Promise<void>
}

/** The bubble's own plugin key, so the editor surface can show and hide it. */
export const LINK_BUBBLE_KEY = new PluginKey('linkTargetBubble')

/**
 * A request to open the bubble, made by `Mod-k` or the Link button.
 *
 * - `actions`: show the bubble and focus its first button.
 * - `url`: open its URL field. On a selection without a link this creates one.
 * - `files`: open the file picker to link a file.
 *
 * Kept while the selection it was made on stands. A co-editor's change keeps
 * it on the selection y-tiptap restores.
 */
export interface BubbleRequest {
  focus: 'actions' | 'url' | 'files'
  from: number
  to: number
}

export const BUBBLE_REQUEST_KEY = new PluginKey<BubbleRequest | null>('linkBubbleRequest')

/** The link, page link or citation the selection is on, or null. */
export function linkTargetAt(state: EditorState): LinkTarget | null {
  const { selection } = state
  if (selection instanceof NodeSelection) {
    const { node, from, to } = selection
    if (node.type.name === 'docLink') return { kind: 'docLink', from, to, attrs: node.attrs as DocLinkAttrs }
    if (node.type.name === CITATION_TAG) return { kind: 'citation', from, to, attrs: node.attrs as CitationAttrs }
    if (node.type.name === 'attachmentInline') return { kind: 'attachment', from, to, attrs: node.attrs as AttachmentLinkAttrs }
    return null
  }
  const type = state.schema.marks.link
  if (!type || !isTextSelection(selection)) return null
  const range = getMarkRange(selection.$from, type)
  if (!range || selection.to > range.to) return null
  const mark = state.doc.resolve(range.from + 1).marks().find(item => item.type === type)
  return { kind: 'link', from: range.from, to: range.to, attrs: { href: String(mark?.attrs.href ?? '') } }
}

/**
 * The target the bubble shows, or null to keep it hidden.
 *
 * Words selected inside a link belong to the formatting bubble, unless a
 * request asked for this one. A request on words without a link offers an
 * empty link over them.
 */
export function bubbleTargetAt(state: EditorState): LinkTarget | null {
  const target = linkTargetAt(state)
  const request = BUBBLE_REQUEST_KEY.getState(state)
  if (request) {
    if (target) return target
    const { from, to, empty } = state.selection
    if (!isTextSelection(state.selection) || empty) return null
    return { kind: 'link', from, to, attrs: { href: '' } }
  }
  if (target?.kind === 'link' && !state.selection.empty) return null
  return target
}

/**
 * Where Open goes. `path` is the resolved alias of a page target, or the
 * download URL of a file, if any. Empty for a target without either.
 */
export function openHref(target: LinkTarget, path: string | null): string {
  if (target.kind === 'link') return target.attrs.href
  if (target.kind === 'attachment') return path ?? ''
  if (target.kind === 'citation' && target.attrs.url) return target.attrs.url
  return target.attrs.nid ? docLinkHref(target.attrs.nid, path, target.attrs.block) : ''
}

/** Opens the bubble for the current selection. */
export function requestLinkBubble(editor: Editor, focus: BubbleRequest['focus']): boolean {
  const { from, to } = editor.state.selection
  editor.view.dispatch(editor.state.tr.setMeta(BUBBLE_REQUEST_KEY, { focus, from, to }))
  return true
}

/** Drops an open request, e.g. a new link the author escaped from. */
export function clearLinkBubbleRequest(editor: Editor): void {
  if (BUBBLE_REQUEST_KEY.getState(editor.state)) {
    editor.view.dispatch(editor.state.tr.setMeta(BUBBLE_REQUEST_KEY, null))
  }
}

/** Points a link (or the words of a new one) at `href`. The selection stays. */
export function setLinkHref(editor: Editor, target: LinkTarget, href: string): boolean {
  if (target.kind !== 'link' || !href.trim()) return false
  const { from, to } = editor.state.selection
  return editor.chain().focus()
    .setTextSelection({ from: target.from, to: target.to })
    .setLink({ href: href.trim() })
    .setTextSelection({ from, to })
    .run()
}

/**
 * Makes the target a link to page file `file`: the words of a link or a
 * selection become its label, a file link keeps its own.
 */
export function setFileLink(editor: Editor, target: LinkTarget, file: string): boolean {
  if (target.kind !== 'link' && target.kind !== 'attachment') return false
  const label = target.kind === 'attachment' ? target.attrs.label : editor.state.doc.textBetween(target.from, target.to, ' ')
  return editor.chain().focus().command(({ tr, state }) => {
    const type = state.schema.nodes.attachmentInline
    if (!type) return false
    const node = type.create({ file, label: target.kind === 'link' && label === target.attrs.href ? '' : label })
    tr.replaceWith(target.from, target.to, node)
    tr.setSelection(TextSelection.create(tr.doc, target.from + node.nodeSize))
    tr.setMeta(BUBBLE_REQUEST_KEY, null)
    return true
  }).run()
}

/**
 * Follows a target through later edits, e.g. a peer typing while an upload
 * runs. `current()` is null once the target's words are deleted.
 */
export function trackLinkTarget(editor: Editor, target: LinkTarget): { current: () => LinkTarget | null, stop: () => void } {
  const range = trackRange(editor, target.from, target.to)
  return {
    current: () => {
      const now = range.current()
      return now ? { ...target, ...now } as LinkTarget : null
    },
    stop: range.stop,
  }
}

/** Removes the link mark; the words stay. */
export function unsetLinkAt(editor: Editor, target: LinkTarget): boolean {
  if (target.kind !== 'link') return false
  return editor.chain().focus().command(({ tr, state }) => {
    tr.removeMark(target.from, target.to, state.schema.marks.link)
    return true
  }).run()
}

/** Points a URL citation at another URL. Only `https?://` counts, as in `citeTarget`. */
export function setCitationUrl(editor: Editor, target: LinkTarget, url: string): boolean {
  if (target.kind !== 'citation' || citeTarget({ url })?.kind !== 'url') return false
  return editor.chain().focus().command(({ tr }) => {
    if (tr.doc.nodeAt(target.from)?.type.name !== CITATION_TAG) return false
    tr.setNodeAttribute(target.from, 'url', url.trim())
    return true
  }).run()
}

const NODE_NAME = { docLink: 'docLink', citation: CITATION_TAG, attachment: 'attachmentInline' } as const

/**
 * Removes the target. A page link leaves its label behind as plain text, a
 * file link its label or the file's name. A
 * citation takes the space before it along, where that space has no word
 * after it to separate.
 */
export function removeTarget(editor: Editor, target: LinkTarget, fileName = ''): boolean {
  if (target.kind === 'link') return unsetLinkAt(editor, target)
  return editor.chain().focus().command(({ tr, state }) => {
    if (tr.doc.nodeAt(target.from)?.type.name !== NODE_NAME[target.kind]) return false
    const words = target.kind === 'docLink' ? target.attrs.label : target.kind === 'attachment' ? target.attrs.label || fileName : ''
    if (words) {
      tr.replaceWith(target.from, target.to, state.schema.text(words))
      return true
    }
    const $from = tr.doc.resolve(target.from)
    const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 1), $from.parentOffset, '', ' ')
    const next = tr.doc.resolve(target.to)
    const after = next.parent.textBetween(next.parentOffset, Math.min(next.parent.content.size, next.parentOffset + 1), '', ' ')
    tr.delete(before === ' ' && /^\s?$/.test(after) ? target.from - 1 : target.from, target.to)
    return true
  }).run()
}

/**
 * Opens the page picker to pick a new target for a page link or citation.
 *
 * The trigger goes right after the node, which is recorded as the range the
 * pick replaces (components/DocLinkMenu.vue). A page link keeps its label.
 */
export function retarget(editor: Editor, target: LinkTarget): boolean {
  if (target.kind === 'link') return false
  if (target.kind === 'attachment') return requestLinkBubble(editor, 'files')
  const label = target.kind === 'docLink' ? target.attrs.label : ''
  recordLinkSelection(label, target.to, { from: target.from, to: target.to })
  return editor.chain().focus().setTextSelection(target.to)
    .insertContent(target.kind === 'docLink' ? '[[' : '[^')
    .run()
}

/**
 * The recorded selection a citation pick replaces: only a citation being
 * retargeted. Words recorded for a `[[` at the same spot stay.
 */
export function retargetedCitation(doc: Node, selection: LinkSelection | null): LinkSelection | null {
  if (!selection?.range) return selection
  return doc.nodeAt(selection.range.from)?.type.name === CITATION_TAG ? selection : null
}

/**
 * Holds the bubble request, and binds `Mod-k`:
 *
 * - on a link, page link or citation: show the bubble, focus on its first button
 * - on words without a link: open the URL field to link them
 *
 * A handled `Mod-k` stops there: the bubble takes focus before the app's
 * search shortcut sees the key, which would then no longer count it as typed
 * in the editor.
 */
export const LinkTargetKeys = Extension.create({
  name: 'linkTargetKeys',

  addProseMirrorPlugins() {
    const editor = this.editor
    const keys = keydownHandler({
      'Mod-k': (state) => {
        if (linkTargetAt(state)) return requestLinkBubble(editor, 'actions')
        if (!state.selection.empty && isTextSelection(state.selection)) return requestLinkBubble(editor, 'url')
        return false
      },
    })
    return [
      new Plugin<BubbleRequest | null>({
        key: BUBBLE_REQUEST_KEY,
        state: {
          init: () => null,
          apply(tr, value, _old, state) {
            const meta = tr.getMeta(BUBBLE_REQUEST_KEY) as BubbleRequest | null | undefined
            if (meta !== undefined) return meta
            if (!value) return null
            if (isChangeOrigin(tr)) return { ...value, from: state.selection.from, to: state.selection.to }
            const from = tr.mapping.map(value.from)
            const to = tr.mapping.map(value.to)
            return state.selection.from === from && state.selection.to === to ? { ...value, from, to } : null
          },
        },
        props: {
          handleKeyDown(view, event) {
            if (!keys(view, event)) return false
            event.stopPropagation()
            return true
          },
        },
      }),
    ]
  },
})
