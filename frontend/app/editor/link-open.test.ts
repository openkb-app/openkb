// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Link from '@tiptap/extension-link'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { OkbCite } from './nodes/cite'
import { OkbDocLink } from './nodes/doc-link'
import { LinkOpen, linkOpenHint } from './link-open'

describe('opening a link from the editor', () => {
  let editor: Editor
  let open: ReturnType<typeof vi.fn>

  beforeEach(() => {
    open = vi.fn()
    vi.stubGlobal('open', open)
    const element = document.createElement('div')
    document.body.append(element)
    editor = new Editor({
      element,
      extensions: [Document, Paragraph, Text, Link.configure({ openOnClick: false }), OkbDocLink, OkbCite, LinkOpen],
      content: '<p>See <a href="https://example.org/guide">the guide</a> and '
        + '<span data-type="doc-link" data-nid="42" data-block="b-4f2a">Rollback</span>.'
        + '<span data-type="citation" data-url="https://example.org/source"></span>'
        + '<span data-type="citation" data-nid="7" data-block="b-77aa"></span></p>',
    })
  })

  afterEach(() => {
    editor.destroy()
    vi.unstubAllGlobals()
  })

  /**
   * Dispatches a mouse event and returns whether the editor cancelled it.
   * Cancels it afterwards either way, so happy-dom never follows the link.
   */
  function dispatch(selector: string, init: MouseEventInit, type = 'click'): boolean {
    let cancelled = false
    window.addEventListener(type, (event) => {
      cancelled = event.defaultPrevented
      event.preventDefault()
    }, { once: true })
    editor.view.dom.querySelector(selector)!.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
    return cancelled
  }

  it('opens a link in a new tab on Ctrl+Click', () => {
    expect(dispatch('a', { button: 0, ctrlKey: true })).toBe(true)
    expect(open).toHaveBeenCalledWith('https://example.org/guide', '_blank', 'noopener,noreferrer')
  })

  it('opens it on Cmd+Click on macOS, where Ctrl+Click is the context menu', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)' })
    dispatch('a', { button: 0, ctrlKey: true })
    expect(open).not.toHaveBeenCalled()
    dispatch('a', { button: 0, metaKey: true })
    expect(open).toHaveBeenCalledOnce()
  })

  it('leaves Cmd+Click to the editor elsewhere', () => {
    dispatch('a', { button: 0, metaKey: true })
    expect(open).not.toHaveBeenCalled()
  })

  it('leaves an empty or fragment-only link to the editor', () => {
    const link = (text: string, href: string) => ({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] })
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [link('blocked', 'javascript:alert(1)'), link('here', '#b-4f2a')] }],
    })
    expect(dispatch('a[href=""]', { button: 0, ctrlKey: true })).toBe(false)
    expect(dispatch('a[href^="#"]', { button: 0, ctrlKey: true })).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('opens it on a middle-click', () => {
    dispatch('a', { button: 1 }, 'auxclick')
    expect(open).toHaveBeenCalledOnce()
  })

  describe('a page link', () => {
    let tab: { opener: unknown, location: { replace: ReturnType<typeof vi.fn> } }

    beforeEach(() => {
      tab = { opener: window, location: { replace: vi.fn() } }
      open.mockReturnValue(tab)
    })

    it('opens at the target’s alias and the block it names', async () => {
      const fetch = vi.fn(async () => Response.json({ path: '/handbook/release' }))
      vi.stubGlobal('fetch', fetch)
      dispatch('[data-type="doc-link"]', { button: 0, ctrlKey: true })
      expect(open).toHaveBeenCalledWith('', '_blank')
      expect(tab.opener).toBeNull()
      expect(fetch).toHaveBeenCalledWith('/api/node/42?version=default')
      await vi.waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith('/handbook/release#b-4f2a'))
    })

    it('opens at `/node/<nid>` when the target does not resolve', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
      dispatch('[data-type="doc-link"]', { button: 0, ctrlKey: true })
      await vi.waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith('/node/42#b-4f2a'))
    })
  })

  describe('a citation', () => {
    it('opens its URL on Ctrl+Click', () => {
      dispatch('[data-url]', { button: 0, ctrlKey: true })
      expect(open).toHaveBeenCalledWith('https://example.org/source', '_blank', 'noopener,noreferrer')
    })

    it('opens the cited block’s page on a middle-click', async () => {
      const tab = { opener: window, location: { replace: vi.fn() } }
      open.mockReturnValue(tab)
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ path: '/handbook/source' })))
      dispatch('[data-type="citation"][data-nid]', { button: 1 }, 'auxclick')
      await vi.waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith('/handbook/source#b-77aa'))
    })
  })

  it('cancels the mousedown of a Ctrl+Click and a middle-click', () => {
    expect(dispatch('a', { button: 0, ctrlKey: true }, 'mousedown')).toBe(true)
    expect(dispatch('a', { button: 1 }, 'mousedown')).toBe(true)
  })

  it('leaves a plain click to the editor', () => {
    expect(dispatch('a', { button: 0 }, 'mousedown')).toBe(false)
    expect(dispatch('a', { button: 0 })).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('leaves a modified click outside a link to the editor', () => {
    expect(dispatch('p', { button: 0, ctrlKey: true })).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('shows the hint on every link, and keeps it out of the document', () => {
    const titled = [...editor.view.dom.querySelectorAll('[title]')]
    expect(titled.map(element => element.getAttribute('data-type') ?? element.textContent))
      .toEqual(['the guide', 'doc-link', 'citation', 'citation'])
    expect(titled.every(element => element.getAttribute('title') === linkOpenHint())).toBe(true)
    expect(editor.getHTML()).not.toContain('title=')
  })
})
