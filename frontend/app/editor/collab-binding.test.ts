// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import * as Y from 'yjs'
import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import Collaboration from '@tiptap/extension-collaboration'
import { refreshReviewMarks } from './review-marks'

/**
 * What a mounted collaborative editor does to the Y fragment it is bound to.
 *
 * The session dispatches decoration-only transactions on this view — the
 * sidecar mirror moving, a peer claiming a block — and every one of them makes
 * y-tiptap compare ProseMirror's document against the fragment and write the
 * difference back. That is safe exactly while the two can agree, and the
 * fragment being EMPTY is the one state where they cannot: ProseMirror has no
 * empty document, the schema fills one with a blank paragraph, so the write
 * back puts that paragraph into the fragment.
 *
 * Which is why nothing may empty a fragment an editor still holds: the blank
 * paragraph reads as content to every seeding path (an empty fragment is how
 * they know a document is not hydrated yet), so the page never comes back.
 */

const editors: Editor[] = []
afterEach(() => { editors.splice(0).forEach(editor => editor.destroy()) })

/** An editor bound to `ydoc`, mounted, as the session mounts it. */
function mount(ydoc: Y.Doc): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [Document, Paragraph, Text, Collaboration.configure({ document: ydoc })],
  })
  editors.push(editor)
  return editor
}

/** Content arriving over the wire — a peer's or the server's, not this view's. */
function arrive(ydoc: Y.Doc, text: string): void {
  const source = new Y.Doc()
  const paragraph = new Y.XmlElement('paragraph')
  paragraph.insert(0, [new Y.XmlText(text)])
  source.getXmlFragment('default').insert(0, [paragraph])
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(source))
}

const fragmentOf = (ydoc: Y.Doc) => ydoc.getXmlFragment('default')

describe('the collab editor over its Y fragment', () => {
  it('leaves a fragment holding the page alone', () => {
    const ydoc = new Y.Doc()
    const editor = mount(ydoc)
    arrive(ydoc, 'the page')

    refreshReviewMarks(editor.view)

    expect(fragmentOf(ydoc).toString()).toBe('<paragraph>the page</paragraph>')
  })

  it('leaves a fragment nothing has hydrated yet empty', () => {
    const ydoc = new Y.Doc()
    const editor = mount(ydoc)

    refreshReviewMarks(editor.view)

    expect(fragmentOf(ydoc).length).toBe(0)
  })

  it('fills an emptied fragment with a blank paragraph — nothing may empty one it holds', () => {
    const ydoc = new Y.Doc()
    const editor = mount(ydoc)
    arrive(ydoc, 'the page')
    const fragment = fragmentOf(ydoc)
    Y.transact(ydoc, () => fragment.delete(0, fragment.length))

    refreshReviewMarks(editor.view)

    expect(fragment.toString()).toBe('<paragraph></paragraph>')
    expect(fragment.length, 'no seeding path reads this as "not hydrated"').toBe(1)
  })
})
