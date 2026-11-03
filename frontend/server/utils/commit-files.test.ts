import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { addPageFile, liveFileLists, liveFileNames, liveHiddenFiles, removePageFile, setFileHidden, setFileName } from '#shared/utils/page-files'
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
    })).toEqual({ attachments: [A], images: [B], hidden: [], names: {} })
    expect(ceFileLists({})).toEqual({ attachments: [], images: [], hidden: [], names: {} })
  })

  it('reads an attachment with display off as hidden', () => {
    expect(ceFileLists({
      attachments: [{ uuid: A, display: false }, { uuid: B, display: true }],
    })).toEqual({ attachments: [A, B], images: [], hidden: [A], names: {} })
  })

  it('reads the file names off both lists; a file on both takes its attachment name', () => {
    expect(ceFileLists({
      attachments: [{ uuid: A, name: 'Report' }, { uuid: B }],
      images: [{ uuid: A, name: 'Photo' }, { uuid: B, name: 'Chart' }],
    }).names).toEqual({ [A]: 'Report', [B]: 'Chart' })
  })

  it('writes each item with its name once a file is renamed, and the baseline follows', async () => {
    const doc = new Y.Doc()
    seedFiles(doc, { attachments: [A], images: [B], names: { [B]: 'Chart' } })
    expect(liveFileNames(doc)).toEqual({ [B]: 'Chart' })
    expect(dirtyFileKeys(doc)).toEqual([])

    setFileName(doc, A, 'Report')
    expect(dirtyFileKeys(doc)).toEqual(['attachments'])
    const hooks = filesCommitHooks()
    const ctx = context(doc)
    hooks.captures[0]!(ctx)
    expect(await hooks.payloadExtenders[0]!({}, ctx)).toEqual({
      relationships: {
        field_kb_attachments: { data: [{ type: 'file--file', id: A, meta: { display: 1, description: 'Report' } }] },
      },
    })
    await hooks.postCommit[0]!({ outcome: 'committed', committed: true, files: { field_kb_attachments: [A] } }, ctx)
    expect(filesBaseline(doc)?.names).toEqual({ [A]: 'Report', [B]: 'Chart' })
    expect(dirtyFileKeys(doc)).toEqual([])

    setFileName(doc, B, '')
    expect(dirtyFileKeys(doc)).toEqual(['images'])
    const next = context(doc)
    hooks.captures[0]!(next)
    expect(await hooks.payloadExtenders[0]!({}, next)).toEqual({
      relationships: { field_kb_images: { data: [{ type: 'file--file', id: B, meta: { title: '' } }] } },
    })
  })

  it('cuts a name to 255 characters, also one a peer wrote uncut', async () => {
    const doc = new Y.Doc()
    seedFiles(doc, { attachments: [A], images: [B] })
    setFileName(doc, A, ` ${'a'.repeat(300)} `)
    expect(liveFileNames(doc)[A]).toBe('a'.repeat(255))
    doc.getMap('files.names').set(B, 'b'.repeat(300))
    const hooks = filesCommitHooks()
    const ctx = context(doc)
    hooks.captures[0]!(ctx)
    expect(await hooks.payloadExtenders[0]!({}, ctx)).toMatchObject({
      relationships: {
        field_kb_attachments: { data: [{ meta: { description: 'a'.repeat(255) } }] },
        field_kb_images: { data: [{ meta: { title: 'b'.repeat(255) } }] },
      },
    })
  })

  it('counts characters, so the cut never splits an emoji', async () => {
    const doc = new Y.Doc()
    seedFiles(doc, { attachments: [A] })
    doc.getMap('files.names').set(A, `${'a'.repeat(254)}😀b`)
    const hooks = filesCommitHooks()
    const ctx = context(doc)
    hooks.captures[0]!(ctx)
    const payload = JSON.parse(JSON.stringify(await hooks.payloadExtenders[0]!({}, ctx)))
    const description = payload.relationships.field_kb_attachments.data[0].meta.description as string
    expect(description).toBe(`${'a'.repeat(254)}😀`)
    expect(description.isWellFormed()).toBe(true)
  })

  it('drops the name of a file taken off the page', () => {
    const doc = new Y.Doc()
    seedFiles(doc, { attachments: [A], images: [A], names: { [A]: 'Report' } })
    removePageFile(doc, 'images', A)
    expect(liveFileNames(doc)).toEqual({ [A]: 'Report' })
    removePageFile(doc, 'attachments', A)
    expect(doc.getMap('files.names').size).toBe(0)
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
            { type: 'file--file', id: A, meta: { display: 0, description: '' } },
            { type: 'file--file', id: B, meta: { display: 1, description: '' } },
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
      relationships: { field_kb_images: { data: [{ type: 'file--file', id: B, meta: { title: '' } }] } },
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
