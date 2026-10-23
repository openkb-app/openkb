import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { addPageFile, liveFileLists, liveHiddenFiles, setFileHidden } from '#shared/utils/page-files'
import { ceFileLists, dirtyFileKeys, filesBaseline, filesCommitHooks, hasNewFile, seedFiles } from './commit-files'
import type { CommitContext, CommitResult } from './commit'

const A = '11111111-2222-4333-8444-555555555555'
const B = '66666666-7777-4888-9999-000000000000'

function context(doc: Y.Doc): CommitContext {
  return { docName: 'node:1', nid: 1, trigger: 'quiet', identity: {}, doc }
}

describe('the page file lane', () => {
  it('reads the lists off the CE props, by uuid', () => {
    expect(ceFileLists({
      attachments: [{ id: '3', uuid: A, label: 'a.pdf' }],
      images: { id: '4', uuid: B, label: 'b.png' },
    })).toEqual({ attachments: [A], images: [B], hidden: [] })
    expect(ceFileLists({})).toEqual({ attachments: [], images: [], hidden: [] })
  })

  it('reads an attachment with display off as hidden', () => {
    expect(ceFileLists({
      attachments: [{ uuid: A, display: false }, { uuid: B, display: true }],
    })).toEqual({ attachments: [A, B], images: [], hidden: [A] })
  })

  it('seeds the hidden flags with the lists', () => {
    const doc = new Y.Doc()
    seedFiles(doc, { attachments: [A, B], images: [], hidden: [A] })
    expect(liveHiddenFiles(doc)).toEqual([A])
    expect(dirtyFileKeys(doc)).toEqual([])

    seedFiles(doc, { attachments: [A, B], images: [], hidden: [B] })
    expect(liveHiddenFiles(doc)).toEqual([B])
  })

  it('writes the attachments with their display flag once a flag moves', async () => {
    const doc = new Y.Doc()
    seedFiles(doc, { attachments: [A, B], images: [] })
    setFileHidden(doc, A, true)
    expect(dirtyFileKeys(doc)).toEqual(['attachments'])
    expect(hasNewFile(doc)).toBe(false)
    const hooks = filesCommitHooks()
    const ctx = context(doc)
    hooks.captures[0]!(ctx)

    const extra = await hooks.payloadExtenders[0]!({}, ctx)
    expect(extra).toEqual({
      relationships: {
        field_kb_attachments: {
          data: [
            { type: 'file--file', id: A, meta: { display: 0 } },
            { type: 'file--file', id: B, meta: { display: 1 } },
          ],
        },
      },
    })

    await hooks.postCommit[0]!({ outcome: 'committed', committed: true, files: { field_kb_attachments: [A, B] } }, ctx)
    expect(filesBaseline(doc)?.hidden).toEqual([A])
    expect(dirtyFileKeys(doc)).toEqual([])

    setFileHidden(doc, A, false)
    expect(dirtyFileKeys(doc)).toEqual(['attachments'])
  })

  it('is clean after a seed and dirty, as an upload, once a file joins', () => {
    const doc = new Y.Doc()
    seedFiles(doc, { attachments: [A], images: [] })
    expect(liveFileLists(doc).attachments).toEqual([A])
    expect(dirtyFileKeys(doc)).toEqual([])
    expect(hasNewFile(doc)).toBe(false)

    addPageFile(doc, 'images', B)
    expect(dirtyFileKeys(doc)).toEqual(['images'])
    expect(hasNewFile(doc)).toBe(true)
  })

  it('writes a changed list as the field relationship and leaves the others out', async () => {
    const doc = new Y.Doc()
    seedFiles(doc, { attachments: [A], images: [] })
    addPageFile(doc, 'images', B)
    const hooks = filesCommitHooks()
    const ctx = context(doc)
    hooks.captures[0]!(ctx)

    expect(await hooks.dirtyChecks[0]!(ctx)).toBe(true)
    const extra = await hooks.payloadExtenders[0]!({ attributes: { title: 'T' } }, ctx)
    expect(extra).toEqual({
      attributes: { title: 'T' },
      relationships: { field_kb_images: { data: [{ type: 'file--file', id: B }] } },
    })
  })

  it('advances the baseline to what Drupal kept and drops what it refused', async () => {
    const doc = new Y.Doc()
    seedFiles(doc, { attachments: [], images: [] })
    addPageFile(doc, 'attachments', A)
    addPageFile(doc, 'attachments', B)
    const hooks = filesCommitHooks()
    const ctx = context(doc)
    hooks.captures[0]!(ctx)
    await hooks.payloadExtenders[0]!({}, ctx)

    const result: CommitResult = { outcome: 'committed', committed: true, files: { field_kb_attachments: [A] } }
    await hooks.postCommit[0]!(result, ctx)

    expect(filesBaseline(doc)?.attachments).toEqual([A])
    expect(liveFileLists(doc).attachments).toEqual([A])
    expect(dirtyFileKeys(doc)).toEqual([])
  })

  it('keeps a file a peer added while the commit was in flight', async () => {
    const doc = new Y.Doc()
    seedFiles(doc, { attachments: [], images: [] })
    addPageFile(doc, 'attachments', A)
    const hooks = filesCommitHooks()
    const ctx = context(doc)
    hooks.captures[0]!(ctx)
    addPageFile(doc, 'attachments', B)

    await hooks.postCommit[0]!({ outcome: 'committed', committed: true, files: { field_kb_attachments: [A] } }, ctx)

    expect(liveFileLists(doc).attachments).toEqual([A, B])
    expect(hasNewFile(doc)).toBe(true)
  })
})
