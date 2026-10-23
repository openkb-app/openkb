import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { addPageFile, changePageFiles, embeddedFiles, liveFileLists, liveHiddenFiles, removePageFile, setFileHidden, setHiddenFiles, setPageFiles } from './page-files'

const A = '11111111-2222-4333-8444-555555555555'
const B = '66666666-7777-4888-9999-000000000000'

/** Two peers' documents, each update relayed to the other. */
function peers(): [Y.Doc, Y.Doc] {
  const one = new Y.Doc()
  const two = new Y.Doc()
  one.on('update', (update: Uint8Array) => Y.applyUpdate(two, update))
  two.on('update', (update: Uint8Array) => Y.applyUpdate(one, update))
  return [one, two]
}

describe('page file lists', () => {
  it('keeps both files when two peers attach at once', () => {
    const one = new Y.Doc()
    const two = new Y.Doc()
    addPageFile(one, 'attachments', A)
    addPageFile(two, 'attachments', B)
    Y.applyUpdate(one, Y.encodeStateAsUpdate(two))
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one))

    expect(liveFileLists(one).attachments.sort()).toEqual([A, B].sort())
    expect(liveFileLists(two).attachments).toEqual(liveFileLists(one).attachments)
  })

  it('adds a file once and removes it wherever it sits', () => {
    const [one, two] = peers()
    addPageFile(one, 'images', A)
    addPageFile(two, 'images', A)
    addPageFile(two, 'images', B)
    expect(liveFileLists(one).images).toEqual([A, B])

    removePageFile(two, 'images', A)
    expect(liveFileLists(one)).toEqual({ attachments: [], images: [B] })
  })

  it('replaces a list, and leaves an equal one untouched', () => {
    const doc = new Y.Doc()
    setPageFiles(doc, 'attachments', [A, B])
    let updates = 0
    doc.on('update', () => updates++)
    setPageFiles(doc, 'attachments', [A, B])
    expect(updates).toBe(0)
    setPageFiles(doc, 'attachments', [B])
    expect(liveFileLists(doc).attachments).toEqual([B])
  })

  it('replaces by diff: a peer\'s concurrent add and remove both stand', () => {
    const C = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const one = new Y.Doc()
    const two = new Y.Doc()
    addPageFile(one, 'attachments', A)
    addPageFile(one, 'attachments', B)
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one))

    // Unsynced: the agent keeps A, drops B, adds C; a person adds D, removes A.
    setPageFiles(one, 'attachments', [A, C])
    const D = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    addPageFile(two, 'attachments', D)
    removePageFile(two, 'attachments', A)
    Y.applyUpdate(one, Y.encodeStateAsUpdate(two))
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one))

    expect(liveFileLists(one).attachments.sort()).toEqual([C, D].sort())
    expect(liveFileLists(two).attachments).toEqual(liveFileLists(one).attachments)
  })

  it('an agent removing one file keeps a file added since it read the page', () => {
    const [one, two] = peers()
    addPageFile(one, 'attachments', A)
    // The agent read [A]; a person adds B, synced before the agent writes.
    addPageFile(two, 'attachments', B)
    expect(changePageFiles(one, 'attachments', { remove: [A] })).toBe(true)
    expect(liveFileLists(two).attachments).toEqual([B])
  })

  it('reports no change for a file already listed or already gone', () => {
    const doc = new Y.Doc()
    addPageFile(doc, 'images', A)
    expect(changePageFiles(doc, 'images', { add: [A], remove: [B] })).toBe(false)
  })
})

describe('hidden attachments', () => {
  it('lists the hidden attachments in list order, and a peer sees a flag change', () => {
    const [one, two] = peers()
    addPageFile(one, 'attachments', A)
    addPageFile(one, 'attachments', B)
    setFileHidden(two, B, true)
    setFileHidden(two, A, true)
    expect(liveHiddenFiles(one)).toEqual([A, B])

    setFileHidden(one, A, false)
    expect(liveHiddenFiles(two)).toEqual([B])
  })

  it('drops the flag of a file taken off the attachments, so a file attached again is listed', () => {
    const doc = new Y.Doc()
    addPageFile(doc, 'attachments', A)
    addPageFile(doc, 'attachments', B)
    setFileHidden(doc, A, true)
    setFileHidden(doc, B, true)
    removePageFile(doc, 'attachments', A)
    setPageFiles(doc, 'attachments', [])
    expect(doc.getMap('files.hidden').size).toBe(0)
    addPageFile(doc, 'attachments', A)
    expect(liveHiddenFiles(doc)).toEqual([])
  })

  it('keeps the flag when the file leaves the images', () => {
    const doc = new Y.Doc()
    addPageFile(doc, 'attachments', A)
    addPageFile(doc, 'images', A)
    setFileHidden(doc, A, true)
    removePageFile(doc, 'images', A)
    expect(liveHiddenFiles(doc)).toEqual([A])
  })

  it('sets the flags of the named attachments only', () => {
    const doc = new Y.Doc()
    setPageFiles(doc, 'attachments', [A, B])
    setFileHidden(doc, A, true)
    setHiddenFiles(doc, [A], [])
    setHiddenFiles(doc, [B], [B])
    expect(liveHiddenFiles(doc)).toEqual([B])
  })

  it('finds the files the text shows as ::embed', () => {
    const doc = new Y.Doc()
    const embed = new Y.XmlElement('embed')
    embed.setAttribute('file', A)
    const card = new Y.XmlElement('attachment')
    card.setAttribute('file', B)
    doc.getXmlFragment('default').insert(0, [embed, card])
    expect([...embeddedFiles(doc)]).toEqual([A])
  })
})
