import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap'
import { editorSchema } from './editor-schema'
import type { FieldSpec, FieldValues } from './entity-fields'
import { seedFields } from './doc-seed'

vi.mock('./drupal', () => ({
  drupalFetchWithAuth: vi.fn(),
  fetchCeWorkingCopy: vi.fn(),
  commitKbPageWithAuth: vi.fn(),
}))
import {
  drupalFetchWithAuth,
  fetchCeWorkingCopy,
  commitKbPageWithAuth,
} from './drupal'
import { commitDocument, contentHash, serializeYDoc, CommitValidationError } from './commit'
import {
  createRefTypeResolver,
  dirtyFieldKeys,
  fieldsCommitHooks,
  fieldsPatchPayload,
} from './commit-fields'

const fetchMock = vi.mocked(drupalFetchWithAuth)
const readMock = vi.mocked(fetchCeWorkingCopy)

/** The working copy the concurrency check reads, off a bare page. */
function readsPage(page: unknown): void {
  readMock.mockResolvedValue({ page } as never)
}
const commitMock = vi.mocked(commitKbPageWithAuth)

const SPECS: FieldSpec[] = [
  { key: 'type', name: 'field_type', multiple: false, reference: false },
  { key: 'summary', name: 'field_summary', multiple: false, reference: false },
  { key: 'owner', name: 'field_owner', multiple: false, reference: true, entityType: 'user', bundles: [] },
  { key: 'tags', name: 'field_tags', multiple: true, reference: true, entityType: 'taxonomy_term', bundles: ['kb_tags'] },
]

/** Resolver stub over a fixed id → type table; unknown ids stay unresolved. */
function tableResolver(table: Record<string, string>) {
  return async (_spec: FieldSpec, id: string) => table[id] ?? null
}

describe('fieldsPatchPayload', () => {
  it('maps title + scalars to attributes and refs to resolved relationships', async () => {
    const values: FieldValues = {
      title: 'New title',
      type: 'adr',
      summary: null,
      owner: { id: 'uuid-marta', label: 'Marta' },
      tags: [{ id: 'uuid-arch', label: 'architecture' }],
    }
    const payload = await fieldsPatchPayload(SPECS, values, Object.keys(values), tableResolver({
      'uuid-marta': 'user--user',
      'uuid-arch': 'taxonomy_term--kb_tags',
    }))
    expect(payload).toEqual({
      attributes: { title: 'New title', field_type: 'adr', field_summary: null },
      relationships: {
        field_owner: { data: { type: 'user--user', id: 'uuid-marta' } },
        field_tags: { data: [{ type: 'taxonomy_term--kb_tags', id: 'uuid-arch' }] },
      },
    })
  })

  it('clears a single ref with data: null and a multi ref with data: []', async () => {
    const payload = await fieldsPatchPayload(
      SPECS, { owner: null, tags: [] }, ['owner', 'tags'], tableResolver({}),
    )
    expect(payload).toEqual({
      relationships: {
        field_owner: { data: null },
        field_tags: { data: [] },
      },
    })
  })

  it('maps only the given keys — untouched values stay out of the PATCH', async () => {
    const values: FieldValues = { title: 'T', type: 'adr', summary: 'S' }
    const payload = await fieldsPatchPayload(SPECS, values, ['summary'], tableResolver({}))
    expect(payload).toEqual({ attributes: { field_summary: 'S' } })
  })

  it('an unresolvable ref blocks with a per-field error keyed by JSON:API name', async () => {
    const values: FieldValues = {
      owner: { id: 'uuid-ghost', label: 'Ghost' },
      tags: [{ id: 'uuid-arch', label: 'architecture' }, { id: 'uuid-gone', label: '' }],
    }
    const err = await fieldsPatchPayload(SPECS, values, ['owner', 'tags'], tableResolver({
      'uuid-arch': 'taxonomy_term--kb_tags',
    })).catch(e => e)
    expect(err).toBeInstanceOf(CommitValidationError)
    expect((err as CommitValidationError).fields).toEqual({
      field_owner: ['Referenced user "Ghost" does not exist.'],
      field_tags: ['Referenced taxonomy_term "uuid-gone" does not exist.'],
    })
  })

  it('an unresolvable ref listed as known (baseline) is dropped, not an error', async () => {
    const values: FieldValues = {
      owner: { id: 'uuid-dead', label: '' },
      tags: [{ id: 'uuid-dead2', label: '' }, { id: 'uuid-arch', label: 'architecture' }],
    }
    const payload = await fieldsPatchPayload(SPECS, values, ['owner', 'tags'], tableResolver({
      'uuid-arch': 'taxonomy_term--kb_tags',
    }), new Set(['uuid-dead', 'uuid-dead2']))
    expect(payload).toEqual({
      relationships: {
        field_owner: { data: null },
        field_tags: { data: [{ type: 'taxonomy_term--kb_tags', id: 'uuid-arch' }] },
      },
    })
  })

  it('a key without a spec is refused, never guessed at', async () => {
    const err = await fieldsPatchPayload(SPECS, { rogue: 'x' }, ['rogue'], tableResolver({}))
      .catch(e => e)
    expect(err).toBeInstanceOf(CommitValidationError)
    expect((err as CommitValidationError).fields).toHaveProperty('rogue')
  })
})

describe('createRefTypeResolver', () => {
  beforeEach(() => { fetchMock.mockReset() })

  const notFound = Object.assign(new Error('Request failed (404)'), { statusCode: 404 })

  it('resolves through the candidate bundles and memoizes per id', async () => {
    fetchMock.mockRejectedValueOnce(notFound).mockResolvedValue({})
    const resolve = createRefTypeResolver({ Authorization: 'Bearer collab' })
    const spec: FieldSpec = { key: 't', name: 'field_t', multiple: false, reference: true, entityType: 'taxonomy_term', bundles: ['a', 'b'] }
    expect(await resolve(spec, 'uuid-1')).toBe('taxonomy_term--b')
    expect(fetchMock).toHaveBeenNthCalledWith(1, { Authorization: 'Bearer collab' }, '/jsonapi/taxonomy_term/a/uuid-1?fields[taxonomy_term--a]=')
    expect(fetchMock).toHaveBeenNthCalledWith(2, { Authorization: 'Bearer collab' }, '/jsonapi/taxonomy_term/b/uuid-1?fields[taxonomy_term--b]=')
    expect(await resolve(spec, 'uuid-1')).toBe('taxonomy_term--b')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('bundle-less refs (user) probe entityType as the bundle', async () => {
    fetchMock.mockResolvedValue({})
    const resolve = createRefTypeResolver({ Authorization: 'Bearer collab' })
    const spec: FieldSpec = { key: 'o', name: 'field_o', multiple: false, reference: true, entityType: 'user', bundles: [] }
    expect(await resolve(spec, 'uuid-u')).toBe('user--user')
    expect(fetchMock).toHaveBeenCalledWith({ Authorization: 'Bearer collab' }, '/jsonapi/user/user/uuid-u?fields[user--user]=')
  })

  it('404 everywhere resolves to null; a non-404 failure propagates', async () => {
    fetchMock.mockRejectedValue(notFound)
    const resolve = createRefTypeResolver({ Authorization: 'Bearer collab' })
    const spec: FieldSpec = { key: 'o', name: 'field_o', multiple: false, reference: true, entityType: 'user', bundles: [] }
    expect(await resolve(spec, 'uuid-gone')).toBeNull()

    fetchMock.mockRejectedValue(Object.assign(new Error('boom'), { statusCode: 503 }))
    await expect(resolve(spec, 'uuid-other')).rejects.toThrow('boom')
  })
})

/** A seeded doc with a body fragment, field values and a matching baseline. */
function sessionDoc(fields: FieldValues): Y.Doc {
  const json = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }] }
  const doc = prosemirrorJSONToYDoc(editorSchema, json as never, 'default')
  seedFields(doc, fields)
  return doc
}

describe('dirtyFieldKeys', () => {
  it('diffs the live fields map against the seed baseline', () => {
    const doc = sessionDoc({ title: 'T', type: 'article' })
    expect(dirtyFieldKeys(doc)).toEqual([])
    doc.getMap('fields').set('type', 'adr')
    expect(dirtyFieldKeys(doc)).toEqual(['type'])
  })

  it('no baseline (pre-seeding document) means no field lane', () => {
    const doc = new Y.Doc()
    doc.getMap('fields').set('type', 'adr')
    expect(dirtyFieldKeys(doc)).toEqual([])
  })

  it('a live key the baseline does not carry is a shrunk contract, not an edit', () => {
    // Persisted document from when `space` was still on the frontmatter form
    // display: the key survives in the Y.Map after a re-seed drops it from the
    // baseline. It must not read as a session edit.
    const doc = sessionDoc({ title: 'T', type: 'article' })
    doc.getMap('fields').set('space', { id: 'uuid-space', label: 'General' })
    expect(dirtyFieldKeys(doc)).toEqual([])
  })
})

describe('fieldsCommitHooks through commitDocument', () => {
  const fetchSpecs = async () => SPECS

  function hp(docName: string, ydoc: Y.Doc) {
    return { documents: new Map<string, unknown>([[docName, ydoc]]) } as never
  }

  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue({})
    readMock.mockReset()
    readsPage({ titleHeading: '', id: 'uuid-1', nid: 1, changed: 100 } as never)
    commitMock.mockReset().mockResolvedValue({ changed: 200, review: null })
  })

  it('a field-only change commits — body hash alone no longer decides clean', async () => {
    const doc = sessionDoc({ title: 'T', type: 'article' })
    doc.getMap('_meta').set('last_commit_hash', contentHash(serializeYDoc(doc)))
    doc.getMap('fields').set('type', 'adr')

    const res = await commitDocument(hp('node:1', doc), 'node:1', {
      trigger: 'disconnect',
      identity: { token: 'collab' },
      hooks: fieldsCommitHooks(fetchSpecs),
    })

    expect(res.outcome).toBe('committed')
    expect(commitMock).toHaveBeenCalledWith({ Authorization: 'Bearer collab' }, 1, expect.any(String), {
      basedOnChanged: 100,
      attributes: { revision_log: 'OpenKB commit (disconnect)', field_type: 'adr' },
    })
    // Baseline advanced by exactly the committed key → the next trigger is clean.
    expect((doc.getMap('_meta').get('fields_baseline') as FieldValues).type).toBe('adr')
    const again = await commitDocument(hp('node:1', doc), 'node:1', {
      trigger: 'quiet',
      identity: { token: 'collab' },
      hooks: fieldsCommitHooks(fetchSpecs),
    })
    expect(again.outcome).toBe('clean')
    expect(commitMock).toHaveBeenCalledOnce()
  })

  it('a write landing mid-checkpoint belongs to the next revision, not this one', async () => {
    // The session-lapse race: a checkpoint is already talking to Drupal when
    // the next writer's ops reach the live document. The revision carries the
    // body serialized before that round trip, so it has to carry the fields
    // that stood with it — a later value would ride into a revision signed for
    // the writer who started this one, and the value it replaced would reach no
    // revision at all.
    const doc = sessionDoc({ title: 'T', summary: 'stored.' })
    doc.getMap('fields').set('summary', 'A wrote this.')
    const bodyAtCheckpoint = `${serializeYDoc(doc)}\n`

    let release!: () => void
    const inFlight = new Promise<void>((resolve) => { release = resolve })
    readMock.mockImplementation(async () => {
      await inFlight
      return { page: { titleHeading: '', id: 'uuid-1', nid: 1, changed: 100 } } as never
    })

    const checkpoint = commitDocument(hp('node:1', doc), 'node:1', {
      trigger: 'agent',
      identity: { token: 'collab' },
      hooks: fieldsCommitHooks(fetchSpecs),
    })
    // B takes the document over while the round trip is open.
    await Promise.resolve()
    doc.getMap('fields').set('summary', 'B wrote this.')
    release()
    await checkpoint

    expect(commitMock).toHaveBeenCalledWith({ Authorization: 'Bearer collab' }, 1, bodyAtCheckpoint, {
      attributes: { revision_log: 'OpenKB commit (agent)', field_summary: 'A wrote this.' },
      basedOnChanged: 100,
    })
    // B's value is still owed, and reaches Drupal under B's own checkpoint.
    expect(dirtyFieldKeys(doc)).toEqual(['summary'])
  })

  it('unchanged doc + fields stays clean — zero requests', async () => {
    const doc = sessionDoc({ title: 'T', type: 'article' })
    doc.getMap('_meta').set('last_commit_hash', contentHash(serializeYDoc(doc)))

    const res = await commitDocument(hp('node:1', doc), 'node:1', {
      trigger: 'quiet',
      identity: { token: 'collab' },
      hooks: fieldsCommitHooks(fetchSpecs),
    })
    expect(res.outcome).toBe('clean')
    expect(readMock).not.toHaveBeenCalled()
    expect(commitMock).not.toHaveBeenCalled()
  })

  it('title + ref changes land as attributes + resolved relationships in ONE PATCH', async () => {
    const doc = sessionDoc({ title: 'T', owner: null, tags: [] })
    doc.getMap('fields').set('title', 'Renamed')
    doc.getMap('fields').set('owner', { id: 'uuid-marta', label: 'Marta' })

    const res = await commitDocument(hp('node:1', doc), 'node:1', {
      trigger: 'manual',
      identity: { token: 'collab' },
      hooks: fieldsCommitHooks(fetchSpecs),
    })

    expect(res.outcome).toBe('committed')
    expect(commitMock).toHaveBeenCalledOnce()
    expect(commitMock).toHaveBeenCalledWith({ Authorization: 'Bearer collab' }, 1, expect.any(String), {
      basedOnChanged: 100,
      attributes: { revision_log: 'OpenKB commit (manual)', title: 'Renamed' },
      relationships: { field_owner: { data: { type: 'user--user', id: 'uuid-marta' } } },
    })
  })

  it('an unresolvable ref blocks the commit with per-field commit_error', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('Request failed (404)'), { statusCode: 404 }))
    const doc = sessionDoc({ title: 'T', owner: null })
    doc.getMap('fields').set('owner', { id: 'uuid-ghost', label: 'Ghost' })

    const res = await commitDocument(hp('node:1', doc), 'node:1', {
      trigger: 'manual',
      identity: { token: 'collab' },
      hooks: fieldsCommitHooks(fetchSpecs),
      now: () => 99,
    })

    expect(res.outcome).toBe('invalid')
    expect(res.fields).toEqual({ field_owner: ['Referenced user "Ghost" does not exist.'] })
    expect(commitMock).not.toHaveBeenCalled()
    expect(doc.getMap('_meta').get('commit_error')).toMatchObject({
      at: 99,
      kind: 'validation',
      fields: { field_owner: ['Referenced user "Ghost" does not exist.'] },
    })
    // Baseline untouched — the change stays dirty and retryable.
    expect((doc.getMap('_meta').get('fields_baseline') as FieldValues).owner).toBeNull()
  })

  it('schema unreachable defers the field lane without blocking the body', async () => {
    const doc = sessionDoc({ title: 'T', type: 'article' })
    doc.getMap('fields').set('type', 'adr')

    const res = await commitDocument(hp('node:1', doc), 'node:1', {
      trigger: 'disconnect',
      identity: { token: 'collab' },
      hooks: fieldsCommitHooks(async () => null),
    })

    expect(res.outcome).toBe('committed')
    expect(commitMock).toHaveBeenCalledWith({ Authorization: 'Bearer collab' }, 1, expect.any(String), {
      basedOnChanged: 100,
      attributes: { revision_log: 'OpenKB commit (disconnect)' },
    })
    // Baseline NOT advanced — the field diff survives for the next commit.
    expect(dirtyFieldKeys(doc)).toEqual(['type'])
  })

  it('a key the shrunk contract cannot address is pruned, never sent', async () => {
    // `space` left the `frontmatter` form display while this document sat in
    // the store, so both its live map and its baseline still carry the key.
    // The commit must go through and converge the document on the new
    // contract — not refuse with "no exposed field".
    const doc = sessionDoc({ title: 'T', type: 'article' })
    doc.getMap('_meta').set('fields_baseline', {
      ...(doc.getMap('_meta').get('fields_baseline') as FieldValues),
      space: { id: 'uuid-space', label: 'General' },
    })
    doc.getMap('fields').set('space', { id: 'uuid-space', label: 'General' })
    doc.getMap('fields').set('type', 'adr')

    const res = await commitDocument(hp('node:1', doc), 'node:1', {
      trigger: 'manual',
      identity: { token: 'collab' },
      hooks: fieldsCommitHooks(fetchSpecs),
    })

    expect(res.outcome).toBe('committed')
    expect(commitMock).toHaveBeenCalledWith({ Authorization: 'Bearer collab' }, 1, expect.any(String), {
      basedOnChanged: 100,
      attributes: { revision_log: 'OpenKB commit (manual)', field_type: 'adr' },
    })
    expect(doc.getMap('fields').has('space')).toBe(false)
    expect(doc.getMap('_meta').get('fields_baseline')).not.toHaveProperty('space')
    expect(dirtyFieldKeys(doc)).toEqual([])
  })

  it('an inherited dangling ref is dropped from the write instead of wedging the commit', async () => {
    // The baseline carries a ref whose target got deleted underneath the
    // session; the user then adds a real tag. The commit must not be blocked
    // by corruption the session merely inherited.
    const doc = sessionDoc({ title: 'T', tags: [{ id: 'uuid-dead', label: '' }] })
    doc.getMap('fields').set('tags', [{ id: 'uuid-dead', label: '' }, { id: 'uuid-new', label: 'fresh' }])
    fetchMock.mockImplementation(async (_cookie, path) => {
      if (String(path).includes('uuid-dead')) {
        throw Object.assign(new Error('Request failed (404)'), { statusCode: 404 })
      }
      return {}
    })

    const res = await commitDocument(hp('node:1', doc), 'node:1', {
      trigger: 'disconnect',
      identity: { token: 'collab' },
      hooks: fieldsCommitHooks(fetchSpecs),
    })

    expect(res.outcome).toBe('committed')
    expect(commitMock).toHaveBeenCalledWith({ Authorization: 'Bearer collab' }, 1, expect.any(String), {
      basedOnChanged: 100,
      attributes: { revision_log: 'OpenKB commit (disconnect)' },
      relationships: { field_tags: { data: [{ type: 'taxonomy_term--kb_tags', id: 'uuid-new' }] } },
    })
    // Baseline advanced to the WRITTEN value and the live map converged on it
    // (dead ref removed everywhere) — the next trigger is clean.
    expect((doc.getMap('_meta').get('fields_baseline') as FieldValues).tags).toEqual([{ id: 'uuid-new', label: 'fresh' }])
    expect(doc.getMap('fields').get('tags')).toEqual([{ id: 'uuid-new', label: 'fresh' }])
    expect(dirtyFieldKeys(doc)).toEqual([])
  })

  it('dropping a dangling ref subtracts from the then-live value — a peer add mid-PATCH survives', async () => {
    const doc = sessionDoc({ title: 'T', tags: [{ id: 'uuid-dead', label: '' }] })
    doc.getMap('fields').set('tags', [{ id: 'uuid-dead', label: '' }, { id: 'uuid-new', label: 'fresh' }])
    fetchMock.mockImplementation(async (_cookie, path) => {
      if (String(path).includes('uuid-dead')) {
        throw Object.assign(new Error('Request failed (404)'), { statusCode: 404 })
      }
      return {}
    })
    // A peer adds another tag while the PATCH is in flight.
    commitMock.mockImplementation(async () => {
      doc.getMap('fields').set('tags', [
        { id: 'uuid-dead', label: '' },
        { id: 'uuid-new', label: 'fresh' },
        { id: 'uuid-peer', label: 'peer' },
      ])
      return { changed: 200, review: null }
    })

    const res = await commitDocument(hp('node:1', doc), 'node:1', {
      trigger: 'manual',
      identity: { token: 'collab' },
      hooks: fieldsCommitHooks(fetchSpecs),
    })

    expect(res.outcome).toBe('committed')
    // The dead ref is removed, the peer's addition survives and stays dirty
    // against the advanced baseline — it reaches the next commit.
    expect(doc.getMap('fields').get('tags')).toEqual([
      { id: 'uuid-new', label: 'fresh' },
      { id: 'uuid-peer', label: 'peer' },
    ])
    expect((doc.getMap('_meta').get('fields_baseline') as FieldValues).tags).toEqual([{ id: 'uuid-new', label: 'fresh' }])
    expect(dirtyFieldKeys(doc)).toEqual(['tags'])
  })

  it('a peer edit mid-PATCH still differs from the advanced baseline', async () => {
    const doc = sessionDoc({ title: 'T', type: 'article' })
    doc.getMap('fields').set('type', 'adr')
    // The peer edit lands while the PATCH is in flight.
    commitMock.mockImplementation(async () => {
      doc.getMap('fields').set('type', 'rfc')
      return { changed: 200, review: null }
    })

    const res = await commitDocument(hp('node:1', doc), 'node:1', {
      trigger: 'manual',
      identity: { token: 'collab' },
      hooks: fieldsCommitHooks(fetchSpecs),
    })

    expect(res.outcome).toBe('committed')
    // Baseline carries what was committed ('adr'), not the live map ('rfc') —
    // the peer's edit is still dirty and reaches the next commit.
    expect((doc.getMap('_meta').get('fields_baseline') as FieldValues).type).toBe('adr')
    expect(dirtyFieldKeys(doc)).toEqual(['type'])
  })
})
