import { describe, it, expect, vi } from 'vitest'
import * as Y from 'yjs'
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap'
import { editorSchema } from './editor-schema'
import * as sessionRead from './session-read'
import { contentHash } from './commit'
import type { FieldSpec } from './entity-fields'

/**
 * What a draft read may take from a live session, and what it may not.
 *
 * The `useHocuspocus` accessor is mocked per case: the module reaches for it
 * lazily, so a process with no collab server simply has no live content.
 */

const documents = new Map<string, unknown>()
const useHocuspocus = vi.fn(() => ({ documents }))
vi.mock('./hocuspocus', () => ({ useHocuspocus: () => useHocuspocus() }))

const SPECS: FieldSpec[] = [
  { key: 'summary', name: 'field_summary', multiple: false, reference: false },
  { key: 'type', name: 'field_type', multiple: false, reference: false },
]

function docWithText(text: string): Y.Doc {
  return prosemirrorJSONToYDoc(
    editorSchema,
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } as never,
    'default',
  )
}

function liveContent(nid: number, specs: FieldSpec[] = SPECS) {
  return sessionRead.liveContent(nid, specs)
}

describe('liveContent', () => {
  it('no document loaded → nothing live', async () => {
    documents.clear()
    expect(await liveContent(7)).toBeNull()
  })

  it('serializes the open document as a commit would write it', async () => {
    documents.clear()
    const doc = docWithText('Typed but not checkpointed.')
    doc.getMap('fields').set('summary', 'Live summary.')
    documents.set('node:7', doc)

    const live = await liveContent(7)
    expect(live?.body.trim()).toBe('Typed but not checkpointed.')
    // Only the exposed keys, and only the ones the document actually carries —
    // a key it lacks must stay the revision's, not become null.
    expect(live?.fields).toEqual({ summary: 'Live summary.' })
  })

  it('tells edits no checkpoint wrote from a body Drupal holds', async () => {
    documents.clear()
    const doc = docWithText('Written by an agent.')
    documents.set('node:7', doc)
    expect((await liveContent(7))?.uncommitted).toBe(true)

    doc.getMap('_meta').set('last_commit_hash', contentHash((await liveContent(7))!.body))
    expect((await liveContent(7))?.uncommitted).toBe(false)
  })

  it('counts a fields-only change as uncommitted', async () => {
    documents.clear()
    const doc = docWithText('Checkpointed.')
    documents.set('node:7', doc)
    doc.getMap('_meta').set('last_commit_hash', contentHash((await liveContent(7))!.body))
    doc.getMap('_meta').set('fields_baseline', { summary: 'Committed summary.' })
    doc.getMap('fields').set('summary', 'Committed summary.')
    expect((await liveContent(7))?.uncommitted).toBe(false)

    doc.getMap('fields').set('summary', 'Edited summary.')
    expect((await liveContent(7))?.uncommitted).toBe(true)
  })

  it('hashes a duplicate block id as the checkpoint wrote it', async () => {
    documents.clear()
    const paragraph = (text: string) => ({ type: 'paragraph', attrs: { id: 'b-dup00001' }, content: [{ type: 'text', text }] })
    const doc = prosemirrorJSONToYDoc(
      editorSchema,
      { type: 'doc', content: [paragraph('One.'), paragraph('Two.')] } as never,
      'default',
    )
    doc.getMap('_meta').set('last_commit_hash', contentHash('One. {#b-dup00001}\n\nTwo. {#b-dup00001-2}'))
    documents.set('node:7', doc)

    const live = await liveContent(7)
    expect(live?.body).toBe('One. {#b-dup00001}\n\nTwo. {#b-dup00001-2}')
    expect(live?.uncommitted).toBe(false)
  })

  it('keeps a leading H1, which is a block and not the title', async () => {
    documents.clear()
    documents.set('node:7', prosemirrorJSONToYDoc(
      editorSchema,
      {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Body.' }] },
        ],
      } as never,
      'default',
    ))
    const live = await liveContent(7)
    expect(live?.body).toContain('# Title')
    expect(live?.body).toContain('Body.')
  })

  it('an unhydrated document is not an empty page', async () => {
    documents.clear()
    // A document loads with an empty fragment until a peer hydrates it; Drupal
    // holds the better answer until then.
    documents.set('node:7', new Y.Doc())
    expect(await liveContent(7)).toBeNull()
  })

  it('a still-loading document is not consulted', async () => {
    documents.clear()
    const doc = docWithText('half loaded') as Y.Doc & { isLoading?: boolean }
    doc.isLoading = true
    documents.set('node:7', doc)
    expect(await liveContent(7)).toBeNull()
  })

  it('another node’s document is not this node’s draft', async () => {
    documents.clear()
    documents.set('node:8', docWithText('Somebody else’s page.'))
    expect(await liveContent(7)).toBeNull()
  })

  it('no collab server in the process → nothing live', async () => {
    documents.clear()
    useHocuspocus.mockImplementationOnce(() => { throw new Error('no nitro app') })
    expect(await liveContent(7)).toBeNull()
  })
})
