// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { buildCommitSchemaExtensions } from '~~/server/utils/editor-schema'
import { parseMarkdownToJson, serializeDocToMarkdown } from '~/comark/markdown-engine'
import { recordLinkSelection, takeLinkSelection } from './doc-link-selection'
import {
  BUBBLE_REQUEST_KEY,
  LinkTargetKeys,
  bubbleTargetAt,
  linkTargetAt,
  openHref,
  removeTarget,
  requestLinkBubble,
  retarget,
  retargetedCitation,
  setCitationUrl,
  setLinkHref,
  unsetLinkAt,
} from './link-target'
import type { LinkTarget } from './link-target'

let editor: Editor

async function edit(markdown: string): Promise<Editor> {
  editor = new Editor({
    extensions: [...buildCommitSchemaExtensions(), LinkTargetKeys],
    content: await parseMarkdownToJson(markdown),
  })
  return editor
}

/** The position of the first node of `type`. */
function posOf(type: string): number {
  let at = -1
  editor.state.doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === type) at = pos
  })
  return at
}

/** The position right after the first occurrence of `text`. */
function after(text: string): number {
  let at = -1
  editor.state.doc.descendants((node, pos) => {
    const index = node.isText ? node.text!.indexOf(text) : -1
    if (at < 0 && index >= 0) at = pos + index + text.length
  })
  return at
}

function selectNode(type: string): void {
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, posOf(type))))
}

const markdown = () => serializeDocToMarkdown(editor.getJSON())

/** Presses `Mod-k` in the editor. Answers whether the key reached the document. */
function pressModK(): boolean {
  let reached = false
  const listen = () => (reached = true)
  document.addEventListener('keydown', listen)
  editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
  document.removeEventListener('keydown', listen)
  return reached
}

afterEach(() => editor?.destroy())

describe('the link target at the selection', () => {
  it('is the whole link for a caret inside it', async () => {
    await edit('See [the guide](https://example.org/guide) here.')
    editor.commands.setTextSelection(after('the g'))
    expect(linkTargetAt(editor.state)).toEqual({
      kind: 'link',
      from: after('See '),
      to: after('the guide'),
      attrs: { href: 'https://example.org/guide' },
    })
  })

  it('is the link for words selected inside it, but those belong to the formatting bubble', async () => {
    await edit('See [the guide](https://example.org/guide) here.')
    editor.commands.setTextSelection({ from: after('See '), to: after('the') })
    expect(linkTargetAt(editor.state)?.kind).toBe('link')
    expect(bubbleTargetAt(editor.state)).toBeNull()
  })

  it('is none for a selection running past the link', async () => {
    await edit('See [the guide](https://example.org/guide) here.')
    editor.commands.setTextSelection({ from: after('See '), to: after('here') })
    expect(linkTargetAt(editor.state)).toBeNull()
  })

  it('is a selected page link or citation', async () => {
    await edit('See :doc[Rollback]{nid="42" block="b-4f2a"} and :citation{url="https://example.org/a"}.')
    selectNode('docLink')
    expect(linkTargetAt(editor.state)).toMatchObject({ kind: 'docLink', attrs: { nid: 42, block: 'b-4f2a', label: 'Rollback' } })
    selectNode('citation')
    expect(bubbleTargetAt(editor.state)).toMatchObject({ kind: 'citation', attrs: { url: 'https://example.org/a' } })
  })

  it('is none in plain text', async () => {
    await edit('Plain words only.')
    editor.commands.setTextSelection(3)
    expect(linkTargetAt(editor.state)).toBeNull()
    expect(bubbleTargetAt(editor.state)).toBeNull()
  })
})

describe('a request for the bubble', () => {
  it('offers an empty link over words without one, until the selection moves', async () => {
    await edit('Plain words only.')
    editor.commands.setTextSelection({ from: 1, to: 6 })
    requestLinkBubble(editor, 'url')
    expect(bubbleTargetAt(editor.state)).toEqual({ kind: 'link', from: 1, to: 6, attrs: { href: '' } })
    editor.commands.setTextSelection(3)
    expect(BUBBLE_REQUEST_KEY.getState(editor.state)).toBeNull()
  })

  it('opens on Mod-k: the actions on a link, the URL field on bare words', async () => {
    await edit('See [the guide](https://example.org/guide) and plain words.')
    editor.commands.setTextSelection(after('the g'))
    pressModK()
    expect(BUBBLE_REQUEST_KEY.getState(editor.state)?.focus).toBe('actions')
    editor.commands.setTextSelection({ from: after('and '), to: after('plain') })
    pressModK()
    expect(BUBBLE_REQUEST_KEY.getState(editor.state)?.focus).toBe('url')
  })

  it('keeps a handled Mod-k from the app’s search shortcut, and passes on any other', async () => {
    await edit('See [the guide](https://example.org/guide) and plain words.')
    document.body.appendChild(editor.view.dom)
    editor.commands.setTextSelection(after('the g'))
    expect(pressModK()).toBe(false)
    editor.commands.setTextSelection(after('plain'))
    expect(pressModK()).toBe(true)
    editor.view.dom.remove()
  })
})

describe('where Open goes', () => {
  it('is the href, the URL, or the page alias with the block', async () => {
    await edit('[a](https://example.org/a) :doc[B]{nid="42" block="b-1"} :citation{nid="7"}')
    editor.commands.setTextSelection(2)
    expect(openHref(linkTargetAt(editor.state)!, null)).toBe('https://example.org/a')
    selectNode('docLink')
    expect(openHref(linkTargetAt(editor.state)!, '/handbook/b')).toBe('/handbook/b#b-1')
    selectNode('citation')
    expect(openHref(linkTargetAt(editor.state)!, null)).toBe('/node/7')
  })

  it('is nowhere for a page target without a page', async () => {
    await edit(':citation{nid="7"}')
    selectNode('citation')
    const target = linkTargetAt(editor.state)!
    expect(openHref({ ...target, attrs: { ...target.attrs, nid: null } } as LinkTarget, null)).toBe('')
  })
})

describe('changing and removing a target', () => {
  it('points a link elsewhere', async () => {
    await edit('See [the guide](https://example.org/guide) here.')
    editor.commands.setTextSelection(after('the g'))
    expect(setLinkHref(editor, linkTargetAt(editor.state)!, 'https://example.org/new')).toBe(true)
    expect(await markdown()).toBe('See [the guide](https://example.org/new) here.')
    expect(editor.state.selection.from).toBe(after('the g'))
  })

  it('links selected words', async () => {
    await edit('Plain words only.')
    editor.commands.setTextSelection({ from: 1, to: 6 })
    requestLinkBubble(editor, 'url')
    setLinkHref(editor, bubbleTargetAt(editor.state)!, 'https://example.org/p')
    expect(await markdown()).toBe('[Plain](https://example.org/p) words only.')
  })

  it('unlinks, keeping the words', async () => {
    await edit('See [the guide](https://example.org/guide) here.')
    editor.commands.setTextSelection(after('the g'))
    unsetLinkAt(editor, linkTargetAt(editor.state)!)
    expect(await markdown()).toBe('See the guide here.')
  })

  it('removes a page link, leaving its label as text', async () => {
    await edit('See :doc[Rollback]{nid="42"} here.')
    selectNode('docLink')
    removeTarget(editor, linkTargetAt(editor.state)!)
    expect(await markdown()).toBe('See Rollback here.')
  })

  it('removes a citation', async () => {
    await edit('Derived. :citation{nid="42" block="b-a"}')
    selectNode('citation')
    removeTarget(editor, linkTargetAt(editor.state)!)
    expect(await markdown()).toBe('Derived.')
  })

  it('removes a citation with one of the spaces around it', async () => {
    await edit('Derived :citation{nid="42" block="b-a"} here.')
    selectNode('citation')
    removeTarget(editor, linkTargetAt(editor.state)!)
    expect(await markdown()).toBe('Derived here.')
  })

  it('points a URL citation at another https URL, and at nothing else', async () => {
    await edit('Derived. :citation{url="https://example.org/a"} more.')
    selectNode('citation')
    expect(setCitationUrl(editor, linkTargetAt(editor.state)!, 'javascript:alert(1)')).toBe(false)
    expect(setCitationUrl(editor, linkTargetAt(editor.state)!, 'https://example.org/b')).toBe(true)
    expect(await markdown()).toBe('Derived. :citation{url="https://example.org/b"} more.')
  })

  it('opens the picker after a page link, recording the node and its label for the pick to replace', async () => {
    await edit('See :doc[Rollback]{nid="42"} here.')
    selectNode('docLink')
    const target = linkTargetAt(editor.state)!
    retarget(editor, target)
    expect(editor.state.doc.textBetween(target.to, target.to + 2)).toBe('[[')
    expect(takeLinkSelection(target.to)).toEqual({ text: 'Rollback', range: { from: target.from, to: target.to } })
  })

  it('opens the citation picker after a citation, recording the node though it has no words', async () => {
    await edit('Derived. :citation{nid="42" block="b-a"} more.')
    selectNode('citation')
    const target = linkTargetAt(editor.state)!
    retarget(editor, target)
    expect(editor.state.doc.textBetween(target.to, target.to + 2)).toBe('[^')
    expect(takeLinkSelection(target.to)).toEqual({ text: '', range: { from: target.from, to: target.to } })
  })
})

describe('what a citation pick replaces', () => {
  it('is the citation being retargeted', async () => {
    await edit('Derived. :citation{nid="42" block="b-a"} more.')
    selectNode('citation')
    const target = linkTargetAt(editor.state)!
    retarget(editor, target)
    const recorded = takeLinkSelection(target.to)
    expect(retargetedCitation(editor.state.doc, recorded)).toEqual(recorded)
  })

  it('is never the words a page-link `[[` was opened on at the same spot', async () => {
    await edit('Plain words only.')
    const from = after('Plain ')
    const to = after('words')
    recordLinkSelection('words', to, { from, to })
    expect(retargetedCitation(editor.state.doc, takeLinkSelection(to))).toBeNull()
  })

  it('is nothing for a caret pick', async () => {
    expect(retargetedCitation((await edit('Plain.')).state.doc, null)).toBeNull()
  })
})
