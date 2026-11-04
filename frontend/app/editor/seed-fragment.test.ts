import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap'
import { editorSchema } from '~~/server/utils/editor-schema'
import { serializeYDoc } from '~~/server/utils/commit'
import { seedEmptyFragment } from './seed-fragment'

const peerUpdate = () => Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(editorSchema, {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a peer wrote this' }] }],
} as never, 'default'))

describe('seedEmptyFragment', () => {
  it('seeds an empty fragment with the parsed body', async () => {
    const ydoc = new Y.Doc()
    await seedEmptyFragment(ydoc, editorSchema, 'from drupal {#b-1}')
    expect(await serializeYDoc(ydoc)).toBe('from drupal {#b-1}')
  })

  it('leaves a fragment a peer filled while the body parsed', async () => {
    const ydoc = new Y.Doc()
    const seeding = seedEmptyFragment(ydoc, editorSchema, 'from drupal')
    Y.applyUpdate(ydoc, peerUpdate())
    await seeding
    expect(await serializeYDoc(ydoc)).toBe('a peer wrote this')
  })

  it('seeds nothing for a session that went while the body parsed', async () => {
    const ydoc = new Y.Doc()
    await seedEmptyFragment(ydoc, editorSchema, 'from drupal', () => true)
    expect(ydoc.getXmlFragment('default').length).toBe(0)
  })
})
