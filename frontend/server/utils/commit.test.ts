import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { Node as PMNode } from '@tiptap/pm/model'
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap'
import { editorSchema } from './editor-schema'
import { serializeDocToMarkdown } from '../../app/comark/markdown-engine'

vi.mock('./drupal', () => ({
  fetchCeWorkingCopy: vi.fn(),
  commitKbPageWithAuth: vi.fn(),
}))
import { fetchCeWorkingCopy, commitKbPageWithAuth } from './drupal'
import {
  serializeYDoc,
  contentHash,
  commitDocument,
  violationFields,
  CommitValidationError,
  TERMINAL_PRECONDITION_TRIES,
  type CommitContext,
} from './commit'

const readMock = vi.mocked(fetchCeWorkingCopy)

/** The working copy the concurrency check reads, off a bare page. */
function readsPage(page: unknown): void {
  readMock.mockResolvedValue({ page } as never)
}
const commitMock = vi.mocked(commitKbPageWithAuth)

type Json = Record<string, unknown>

function seed(json: Json): Y.Doc {
  return prosemirrorJSONToYDoc(editorSchema, json as never, 'default')
}

function hp(docName: string, ydoc: Y.Doc) {
  return { documents: new Map<string, unknown>([[docName, ydoc]]) } as never
}

const DOC_MARKS: Json = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
    { type: 'paragraph', content: [
      { type: 'text', marks: [{ type: 'bold' }], text: 'bold' },
      { type: 'text', text: ' plain ' },
      { type: 'text', marks: [{ type: 'italic' }], text: 'it' },
      { type: 'text', text: ' ' },
      { type: 'text', marks: [{ type: 'code' }], text: 'c' },
    ] },
    { type: 'bulletList', content: [
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
    ] },
  ],
}

const DOC_FENCES: Json = {
  type: 'doc',
  content: [
    { type: 'callout', attrs: { type: 'warning' }, content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'heads up' }] },
      { type: 'infobox', attrs: { title: 'Note' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'inner' }] }] },
    ] },
  ],
}

const DOC_CODE_MENTION: Json = {
  type: 'doc',
  content: [
    { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const x = 1' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'hi ' }, { type: 'mention', attrs: { id: 5, label: 'alice' } }] },
  ],
}

describe('serializeYDoc', () => {
  it('marks + heading + bullet list', () => {
    expect(serializeYDoc(seed(DOC_MARKS))).toBe('## Title\n\n**bold** plain *it* `c`\n\n- one\n- two')
  })

  it('nested callout/infobox fences (variable-length markers)', () => {
    expect(serializeYDoc(seed(DOC_FENCES))).toBe(':::callout{type="warning"}\nheads up\n\n::infobox{title="Note"}\ninner\n::\n:::')
  })

  it('code block language + mention (uid round-trips)', () => {
    expect(serializeYDoc(seed(DOC_CODE_MENTION))).toBe('```ts\nconst x = 1\n```\n\nhi :mention[alice]{uid="5"}')
  })

  it('byte-parity: Y.Doc path equals the direct (retired client) serialize path', () => {
    // The old client path was serializeDocToMarkdown(editor.state.doc), i.e.
    // serialize(Node.fromJSON(<schema>, json)). serializeYDoc goes through the
    // Y.Doc, which round-trips the same JSON. Same schema + same (unchanged)
    // serializer ⇒ identical bytes.
    for (const json of [DOC_MARKS, DOC_FENCES, DOC_CODE_MENTION]) {
      const direct = serializeDocToMarkdown(PMNode.fromJSON(editorSchema, json as never))
      expect(serializeYDoc(seed(json))).toBe(direct)
    }
  })
})

describe('contentHash', () => {
  it('is deterministic and content-sensitive', () => {
    expect(contentHash('a')).toBe(contentHash('a'))
    expect(contentHash('a')).not.toBe(contentHash('b'))
  })
})

describe('commitDocument', () => {
  beforeEach(() => {
    readMock.mockReset()
    commitMock.mockReset()
  })

  it('commits a dirty doc and writes the confirmed-checkpoint _meta', async () => {
    const ydoc = seed(DOC_MARKS)
    readsPage({ titleHeading: '', id: 'uuid-1', nid: 1, changed: 100 } as never)
    commitMock.mockResolvedValue({ changed: 200, review: null })

    const res = await commitDocument(hp('node:1', ydoc), 'node:1', {
      trigger: 'manual',
      identity: { token: 'collab' },
      now: () => 1234,
    })

    expect(res.outcome).toBe('committed')
    expect(res.committed).toBe(true)
    expect(res.changed).toBe(200)
    expect(commitMock).toHaveBeenCalledOnce()
    const meta = ydoc.getMap('_meta')
    expect(meta.get('drupal_changed')).toBe(200)
    expect(meta.get('last_commit_hash')).toBe(res.hash)
    expect(meta.get('last_save_at')).toBe(1234)
    expect(meta.get('last_commit')).toMatchObject({ at: 1234, changed: 200, trigger: 'manual' })
  })

  it('is idempotent: unchanged doc (matching hash) writes zero revisions', async () => {
    const ydoc = seed(DOC_MARKS)
    const meta = ydoc.getMap('_meta')
    meta.set('last_commit_hash', contentHash(serializeYDoc(ydoc)))

    const res = await commitDocument(hp('node:1', ydoc), 'node:1', {
      trigger: 'quiet',
      identity: { token: 'collab' },
    })

    expect(res.outcome).toBe('clean')
    expect(res.committed).toBe(false)
    expect(readMock).not.toHaveBeenCalled()
    expect(commitMock).not.toHaveBeenCalled()
  })

  it('repeated triggers after a commit stay clean (no revision churn)', async () => {
    const ydoc = seed(DOC_MARKS)
    readsPage({ titleHeading: '', id: 'uuid-1', nid: 1, changed: 100 } as never)
    commitMock.mockResolvedValue({ changed: 200, review: null })
    const arg = { trigger: 'disconnect' as const, identity: { token: 'collab' } }

    expect((await commitDocument(hp('node:1', ydoc), 'node:1', arg)).committed).toBe(true)
    expect((await commitDocument(hp('node:1', ydoc), 'node:1', arg)).outcome).toBe('clean')
    expect((await commitDocument(hp('node:1', ydoc), 'node:1', arg)).outcome).toBe('clean')
    expect(commitMock).toHaveBeenCalledOnce()
  })

  it('empty document + non-empty Drupal body → skipped, nothing written', async () => {
    // A document caught mid-flight: loaded from the snapshot store before any
    // peer hydrated its fragment, or between a reconcile clearing and
    // re-filling it. A disconnect checkpoint is immediate and lands there.
    const ydoc = seed({ type: 'doc', content: [] })
    ydoc.getMap('_meta').set('drupal_changed', 100)
    readsPage({ titleHeading: '', id: 'uuid-1', nid: 1, changed: 100, body: '# Real page\n' } as never)

    const res = await commitDocument(hp('node:1', ydoc), 'node:1', {
      trigger: 'disconnect',
      identity: { token: 'collab' },
    })

    expect(res.outcome).toBe('empty-body')
    expect(res.committed).toBe(false)
    expect(commitMock).not.toHaveBeenCalled()
    // Baselines untouched, so the next checkpoint still sees a dirty document.
    expect(ydoc.getMap('_meta').get('drupal_changed')).toBe(100)
    expect(ydoc.getMap('_meta').get('last_commit_hash')).toBeUndefined()
    expect(ydoc.getMap('_meta').get('external_change_detected')).toBeUndefined()
  })

  it('empty document + empty Drupal body → the guard does not fire', async () => {
    const ydoc = seed({ type: 'doc', content: [] })
    readsPage({ titleHeading: '', id: 'uuid-1', nid: 1, changed: 100, body: '' } as never)
    commitMock.mockResolvedValue({ changed: 200, review: null })

    const res = await commitDocument(hp('node:1', ydoc), 'node:1', {
      trigger: 'manual',
      identity: { token: 'collab' },
    })

    expect(res.outcome).not.toBe('empty-body')
  })

  it('a refused working-copy read is an error verdict, not a throw', async () => {
    // The concurrency check reads the working copy under the session's own
    // carrier, so Drupal's refusal reaches the caller as a verdict the
    // trigger can retry — an escaped rejection would take the checkpoint's
    // own error handling with it.
    const ydoc = seed(DOC_MARKS)
    readMock.mockRejectedValue(Object.assign(new Error('Forbidden'), { statusCode: 403 }))

    const res = await commitDocument(hp('node:1', ydoc), 'node:1', {
      trigger: 'manual',
      identity: { token: 'collab' },
      now: () => 77,
    })

    expect(res).toMatchObject({ outcome: 'error', committed: false, status: 403 })
    expect(commitMock).not.toHaveBeenCalled()
  })

  it('409: Drupal moved underneath the session → external_change_detected, no PATCH', async () => {
    const ydoc = seed(DOC_MARKS)
    ydoc.getMap('_meta').set('drupal_changed', 100)
    readsPage({ titleHeading: '', id: 'uuid-1', nid: 1, changed: 200 } as never)

    const res = await commitDocument(hp('node:1', ydoc), 'node:1', {
      trigger: 'manual',
      identity: { token: 'collab' },
      now: () => 77,
    })

    expect(res.outcome).toBe('conflict')
    expect(res.expected).toBe(100)
    expect(res.changed).toBe(200)
    expect(commitMock).not.toHaveBeenCalled()
    expect(ydoc.getMap('_meta').get('external_change_detected')).toMatchObject({ actual: 200, at: 77 })
  })

  it('Drupal moved to exactly this content → adopts the baseline, no conflict', async () => {
    const ydoc = seed(DOC_MARKS)
    ydoc.getMap('_meta').set('drupal_changed', 100)
    ydoc.getMap('_meta').set('external_change_detected', { actual: 200, at: 1 })
    const markdown = serializeYDoc(ydoc)
    readsPage({ titleHeading: '', id: 'uuid-1', nid: 1, changed: 200, body: markdown } as never)

    const res = await commitDocument(hp('node:1', ydoc), 'node:1', {
      trigger: 'manual',
      identity: { token: 'collab' },
      now: () => 77,
    })

    expect(res.outcome).toBe('clean')
    // `adopted` ≠ plain clean: a write DID land, its accounting counts as
    // delivered. The scheduler discharges on this.
    expect(res.adopted).toBe(true)
    expect(commitMock).not.toHaveBeenCalled()
    expect(ydoc.getMap('_meta').get('drupal_changed')).toBe(200)
    expect(ydoc.getMap('_meta').get('last_commit_hash')).toBe(contentHash(markdown))
    expect(ydoc.getMap('_meta').get('external_change_detected')).toBeUndefined()
  })

  it('a clean checkpoint that adopted nothing does not claim it did', async () => {
    // The discharge reads this flag, so the ordinary "nothing changed" answer
    // must not carry it — it would drop a window Drupal has never seen.
    const ydoc = seed(DOC_MARKS)
    ydoc.getMap('_meta').set('last_commit_hash', contentHash(serializeYDoc(ydoc)))

    const res = await commitDocument(hp('node:1', ydoc), 'node:1', {
      trigger: 'quiet',
      identity: { token: 'collab' },
    })

    expect(res.outcome).toBe('clean')
    expect(res.adopted).toBeUndefined()
  })

  it('422: validation error → commit_error surfaced to peers', async () => {
    const ydoc = seed(DOC_MARKS)
    readsPage({ titleHeading: '', id: 'uuid-1', nid: 1, changed: 100 } as never)
    commitMock.mockRejectedValue({ statusCode: 500, data: { drupalStatus: 422 }, message: 'field_kb_body invalid' })

    const res = await commitDocument(hp('node:1', ydoc), 'node:1', {
      trigger: 'manual',
      identity: { token: 'collab' },
      now: () => 88,
    })

    expect(res.outcome).toBe('invalid')
    expect(res.committed).toBe(false)
    const err = ydoc.getMap('_meta').get('commit_error') as { kind: string, at: number }
    expect(err).toMatchObject({ kind: 'validation', at: 88 })
  })

  it('422 with violations → per-field messages in commit_error.fields', async () => {
    const ydoc = seed(DOC_MARKS)
    readsPage({ titleHeading: '', id: 'uuid-1', nid: 1, changed: 100 } as never)
    commitMock.mockRejectedValue({
      statusCode: 422,
      message: 'Request failed (422)',
      data: {
        violations: [
          { detail: 'title: This value should not be null.', source: { pointer: '/data/attributes/title' } },
        ],
      },
    })

    const res = await commitDocument(hp('node:1', ydoc), 'node:1', {
      trigger: 'manual',
      identity: { token: 'collab' },
      now: () => 88,
    })

    expect(res.outcome).toBe('invalid')
    expect(res.fields).toEqual({ title: ['This value should not be null.'] })
    expect(ydoc.getMap('_meta').get('commit_error')).toMatchObject({
      kind: 'validation',
      fields: { title: ['This value should not be null.'] },
    })
  })

  it('auto-trigger without a captured cookie cannot PATCH', async () => {
    const ydoc = seed(DOC_MARKS)
    const res = await commitDocument(hp('node:1', ydoc), 'node:1', { trigger: 'quiet' })
    expect(res.outcome).toBe('no-credentials')
    expect(readMock).not.toHaveBeenCalled()
  })

  it('a session that no longer holds writes nothing — logged-out ops neither apply nor attribute', async () => {
    const ydoc = seed(DOC_MARKS)
    const res = await commitDocument(hp('node:1', ydoc), 'node:1', {
      trigger: 'quiet',
      identity: { token: 'collab', cookie: 'SESS=stale' },
      precondition: async () => 'unauthenticated',
    })
    expect(res.outcome).toBe('unauthenticated')
    expect(res.committed).toBe(false)
    expect(commitMock).not.toHaveBeenCalled()
    // No checkpoint means no attribution either: the sidecar the collab server
    // mirrors is never advanced for a credential Drupal stopped honouring.
    expect(ydoc.getMap('_meta').get('confirmed_checkpoint')).toBeUndefined()
  })

  it('returns the precondition its own verdict — an unreachable Drupal is not a dead session', async () => {
    const ydoc = seed(DOC_MARKS)
    const res = await commitDocument(hp('node:1', ydoc), 'node:1', {
      trigger: 'quiet',
      identity: { token: 'collab', cookie: 'SESS=live' },
      precondition: async () => 'error',
    })
    // Same skipped write, different meaning: 'unauthenticated' closes the
    // peers' sockets, 'error' costs this checkpoint and nothing else.
    expect(res.outcome).toBe('error')
    expect(res.committed).toBe(false)
    expect(commitMock).not.toHaveBeenCalled()
  })

  it('a disconnect asks an unreachable Drupal again, then gives up', async () => {
    // The last peer's checkpoint is the document's last: nothing after it will
    // ask a second time, so it asks here.
    const ydoc = seed(DOC_MARKS)
    const precondition = vi.fn<() => Promise<true | 'error'>>().mockResolvedValue('error')
    const waits: number[] = []
    const res = await commitDocument(hp('node:1', ydoc), 'node:1', {
      trigger: 'disconnect',
      identity: { token: 'collab', cookie: 'SESS=live' },
      precondition,
      wait: async (ms) => { waits.push(ms) },
    })
    expect(precondition).toHaveBeenCalledTimes(TERMINAL_PRECONDITION_TRIES)
    expect(waits).toHaveLength(TERMINAL_PRECONDITION_TRIES - 1)
    expect(res.outcome).toBe('error')
    expect(commitMock).not.toHaveBeenCalled()
  })

  it('a disconnect commits as soon as Drupal answers again', async () => {
    const ydoc = seed(DOC_MARKS)
    readsPage({ titleHeading: '', id: 'uuid-1', nid: 1, changed: 100 } as never)
    commitMock.mockResolvedValue({ changed: 200, review: null })
    const precondition = vi.fn<() => Promise<true | 'error'>>()
      .mockResolvedValueOnce('error')
      .mockResolvedValue(true)

    const res = await commitDocument(hp('node:1', ydoc), 'node:1', {
      trigger: 'disconnect',
      identity: { token: 'collab', cookie: 'SESS=live' },
      precondition,
      wait: async () => {},
    })
    expect(precondition).toHaveBeenCalledTimes(2)
    expect(res.outcome).toBe('committed')
  })

  it('a refusal is an answer — a disconnect does not ask twice', async () => {
    const ydoc = seed(DOC_MARKS)
    const precondition = vi.fn<() => Promise<true | 'unauthenticated'>>().mockResolvedValue('unauthenticated')
    const res = await commitDocument(hp('node:1', ydoc), 'node:1', {
      trigger: 'disconnect',
      identity: { token: 'collab', cookie: 'SESS=stale' },
      precondition,
      wait: async () => {},
    })
    expect(precondition).toHaveBeenCalledOnce()
    expect(res.outcome).toBe('unauthenticated')
  })

  it('a timer checkpoint asks once — the next one asks again', async () => {
    const ydoc = seed(DOC_MARKS)
    const precondition = vi.fn<() => Promise<true | 'error'>>().mockResolvedValue('error')
    await commitDocument(hp('node:1', ydoc), 'node:1', {
      trigger: 'quiet',
      identity: { token: 'collab', cookie: 'SESS=live' },
      precondition,
      wait: async () => {},
    })
    expect(precondition).toHaveBeenCalledOnce()
  })

  it('a session that still holds commits as usual', async () => {
    const ydoc = seed(DOC_MARKS)
    readsPage({ titleHeading: '', id: 'uuid-1', nid: 1, changed: 100 } as never)
    commitMock.mockResolvedValue({ changed: 200, review: null })

    const res = await commitDocument(hp('node:1', ydoc), 'node:1', {
      trigger: 'quiet',
      identity: { token: 'collab', cookie: 'SESS=live' },
      precondition: async () => true,
    })
    expect(res.outcome).toBe('committed')
    expect(commitMock).toHaveBeenCalled()
  })

  it('returns no-document when the doc is not loaded', async () => {
    const res = await commitDocument({ documents: new Map() } as never, 'node:9', {
      trigger: 'quiet',
      identity: { token: 'collab' },
    })
    expect(res.outcome).toBe('no-document')
  })
})

describe('commitDocument pipeline seams (no-op pass-through)', () => {
  beforeEach(() => {
    readMock.mockReset()
    readsPage({ titleHeading: '', id: 'uuid-1', nid: 1, changed: 100 } as never)
    commitMock.mockReset().mockResolvedValue({ changed: 200, review: null })
  })

  it('runs pre-serialize, payload-extender and post-commit hooks; identity hooks change nothing', async () => {
    const ydoc = seed(DOC_MARKS)
    const seen: string[] = []
    const contexts: CommitContext[] = []

    const res = await commitDocument(hp('node:1', ydoc), 'node:1', {
      trigger: 'manual',
      identity: { token: 'collab' },
      hooks: {
        preSerialize: [(json, ctx) => { seen.push('pre'); contexts.push(ctx); return json }],
        payloadExtenders: [(extra) => { seen.push('payload'); return extra }],
        postCommit: [(result, ctx) => { seen.push('post'); contexts.push(ctx); expect(result.committed).toBe(true) }],
      },
    })

    expect(res.outcome).toBe('committed')
    // No-op hooks leave the serialized markdown byte-identical to no hooks.
    expect(res.markdown).toBe(serializeYDoc(seed(DOC_MARKS)))
    expect(seen).toEqual(['pre', 'payload', 'post'])
    // Body attribute PATCHed with no extra fields beyond the revision log —
    // the stored text is the document plus its final newline.
    expect(commitMock).toHaveBeenCalledWith({ Authorization: 'Bearer collab' }, 1, `${res.markdown}\n`, {
      basedOnChanged: 100,
      attributes: { revision_log: 'OpenKB commit (manual)' },
    })
    for (const ctx of contexts) expect(ctx).toMatchObject({ docName: 'node:1', nid: 1, trigger: 'manual' })
  })

  it('writes the confirmed-checkpoint signal after every post-commit hook', async () => {
    // A peer drops its offline mirror when `last_commit` advances and
    // re-creates it on the very next doc update, so a lane writing to the doc
    // after the signal resurrects the mirror it just cleared.
    const ydoc = seed(DOC_MARKS)
    const order: string[] = []
    ydoc.getMap('_meta').observeDeep(() => {
      if (ydoc.getMap('_meta').get('last_commit')) order.push('signal')
    })

    await commitDocument(hp('node:1', ydoc), 'node:1', {
      trigger: 'manual',
      identity: { token: 'collab' },
      hooks: {
        postCommit: [(_result, ctx) => {
          order.push('hook')
          ctx.doc.transact(() => ctx.doc.getMap('_meta').set('lane_baseline', 'x'))
        }],
      },
    })

    expect(order).toEqual(['hook', 'signal'])
  })

  it('keeps the checkpoint signal when a post-commit hook throws', async () => {
    // The PATCH already landed; a bookkeeping failure must not make the
    // session believe it never checkpointed.
    const ydoc = seed(DOC_MARKS)
    const res = await commitDocument(hp('node:1', ydoc), 'node:1', {
      trigger: 'manual',
      identity: { token: 'collab' },
      hooks: { postCommit: [() => { throw new Error('lane bookkeeping blew up') }] },
    })

    expect(res.outcome).toBe('committed')
    expect(ydoc.getMap('_meta').get('last_commit')).toMatchObject({ trigger: 'manual' })
  })

  it('a payload extender can add attributes to the PATCH (OKB-9 seam)', async () => {
    const ydoc = seed(DOC_MARKS)
    await commitDocument(hp('node:1', ydoc), 'node:1', {
      trigger: 'manual',
      identity: { token: 'collab' },
      hooks: { payloadExtenders: [extra => ({ ...extra, attributes: { title: 'X' } })] },
    })
    expect(commitMock).toHaveBeenCalledWith({ Authorization: 'Bearer collab' }, 1, expect.any(String), {
      basedOnChanged: 100,
      attributes: { title: 'X', revision_log: 'OpenKB commit (manual)' },
    })
  })

  it.each(['manual', 'disconnect', 'quiet', 'max-dirty'] as const)(
    'records the %s trigger in the revision log message',
    async (trigger) => {
      await commitDocument(hp('node:1', seed(DOC_MARKS)), 'node:1', {
        trigger,
        identity: { token: 'collab' },
      })
      expect(commitMock).toHaveBeenCalledWith({ Authorization: 'Bearer collab' }, 1, expect.any(String), {
        basedOnChanged: 100,
        attributes: { revision_log: `OpenKB commit (${trigger})` },
      })
    },
  )

  it('names an agent in the revision log — its uid is the owner\'s', async () => {
    await commitDocument(hp('node:1', seed(DOC_MARKS)), 'node:1', {
      trigger: 'agent',
      identity: { token: 'tok', user: 'fago', via: 'Claude' },
    })
    expect(commitMock).toHaveBeenCalledWith(
      { Authorization: 'Bearer tok' }, 1, expect.any(String), {
        basedOnChanged: 100,
        attributes: { revision_log: 'OpenKB commit (agent) — fago via Claude' },
      })
  })

  it('leaves a human commit\'s message alone — revision_uid already names them', async () => {
    await commitDocument(hp('node:1', seed(DOC_MARKS)), 'node:1', {
      trigger: 'disconnect',
      identity: { token: 'collab', user: 'admin' },
    })
    expect(commitMock).toHaveBeenCalledWith({ Authorization: 'Bearer collab' }, 1, expect.any(String), {
      basedOnChanged: 100,
      attributes: { revision_log: 'OpenKB commit (disconnect)' },
    })
  })

  it('carries the collab credential and the window it accounts for', async () => {
    // What a checkpoint states about itself: who wrote which block, and the
    // human to file the revision under. Both ride the write that carries the
    // text, and neither is a claim a browser may make.
    await commitDocument(hp('node:1', seed(DOC_MARKS)), 'node:1', {
      trigger: 'quiet',
      identity: { token: 'collab', user: 'admin' },
      sessionWrite: {
        actingUid: 7,
        coAuthors: [{ name: 'ada', via: null }, { name: 'fago', via: null }],
        blocks: { 'b-1': [{ uid: 7, via: null }, { uid: 3, via: null }] },
      },
    })
    expect(commitMock).toHaveBeenCalledWith(
      { Authorization: 'Bearer collab' }, 1, expect.any(String), expect.objectContaining({
        attributes: { revision_log: 'OpenKB commit (quiet) — ada, fago' },
        session: { acting_uid: 7, blocks: { 'b-1': [{ uid: 7, via: null }, { uid: 3, via: null }] } },
      }))
  })

  it('is ONE Drupal write — the text, the credit and the ask together', async () => {
    // The property the two-write shape cost: there is no moment where Drupal
    // holds the paragraph and not the fact of who wrote it, which is the
    // moment its author could have signed it off. A second write reappearing
    // here is what this refuses. The state the write lands in is not named at
    // all: a checkpoint is content, and Drupal decides what content lands as.
    await commitDocument(hp('node:1', seed(DOC_MARKS)), 'node:1', {
      trigger: 'manual',
      identity: { token: 'collab-token' },
      sessionWrite: {
        actingUid: 7,
        coAuthors: [{ name: 'ada', via: null }, { name: 'fago', via: null }],
        blocks: { 'b-1': [{ uid: 7, via: null }, { uid: 3, via: null }] },
      },
    })
    expect(commitMock).toHaveBeenCalledTimes(1)
    expect(commitMock).toHaveBeenCalledWith(
      { Authorization: 'Bearer collab-token' }, 1, expect.any(String), expect.objectContaining({
        attributes: expect.not.objectContaining({ moderation_state: expect.anything() }),
        session: { acting_uid: 7, blocks: { 'b-1': [{ uid: 7, via: null }, { uid: 3, via: null }] } },
      }))
  })

  it('does not list a lone co-author — revision_uid already names them', async () => {
    await commitDocument(hp('node:1', seed(DOC_MARKS)), 'node:1', {
      trigger: 'quiet',
      identity: { token: 'collab', user: 'admin' },
      sessionWrite: {
        actingUid: 7,
        coAuthors: [{ name: 'admin', via: null }],
        blocks: { 'b-1': [{ uid: 7, via: null }] },
      },
    })
    expect(commitMock).toHaveBeenCalledWith(
      { Authorization: 'Bearer collab' }, 1, expect.any(String), expect.objectContaining({
        attributes: { revision_log: 'OpenKB commit (quiet)' },
        session: { acting_uid: 7, blocks: { 'b-1': [{ uid: 7, via: null }] } },
      }))
  })

  it('names the window\'s writer, not the carrier the document was opened with', async () => {
    // A document one agent started and another took over: the captured carrier
    // still names the first, and a timer-driven checkpoint rides it. Drupal
    // files the revision under the window's author, and the log is the only
    // place an agent appears at all — so both have to name the same actor.
    await commitDocument(hp('node:1', seed(DOC_MARKS)), 'node:1', {
      trigger: 'disconnect',
      identity: { token: 'tok-a', user: 'agent-a', via: 'alpha' },
      sessionWrite: {
        actingUid: 9,
        coAuthors: [{ name: 'agent-b', via: 'beta' }],
        blocks: { 'b-1': [{ uid: 9, via: 'beta' }] },
      },
    })
    expect(commitMock).toHaveBeenCalledWith(
      { Authorization: 'Bearer tok-a' }, 1, expect.any(String),
      expect.objectContaining({
        attributes: { revision_log: 'OpenKB commit (disconnect) — agent-b via beta' },
      }))
  })

  it('names no author on a session write whose window measured nobody', async () => {
    // Drupal then files it under the account that authenticated the request,
    // which is what the revision would have said anyway.
    await commitDocument(hp('node:1', seed(DOC_MARKS)), 'node:1', {
      trigger: 'quiet',
      identity: { token: 'collab' },
      sessionWrite: { actingUid: null, coAuthors: [], blocks: {} },
    })
    expect(commitMock).toHaveBeenCalledWith(
      { Authorization: 'Bearer collab' }, 1, expect.any(String), expect.objectContaining({
        attributes: { revision_log: 'OpenKB commit (quiet)' },
        session: { acting_uid: null, blocks: {} },
      }))
  })

  it('an extender can override the revision log message', async () => {
    await commitDocument(hp('node:1', seed(DOC_MARKS)), 'node:1', {
      trigger: 'quiet',
      identity: { token: 'collab' },
      hooks: { payloadExtenders: [extra => ({ ...extra, attributes: { revision_log: 'custom' } })] },
    })
    expect(commitMock).toHaveBeenCalledWith({ Authorization: 'Bearer collab' }, 1, expect.any(String), {
      basedOnChanged: 100,
      attributes: { revision_log: 'custom' },
    })
  })

  it('extenders may be async', async () => {
    await commitDocument(hp('node:1', seed(DOC_MARKS)), 'node:1', {
      trigger: 'manual',
      identity: { token: 'collab' },
      hooks: { payloadExtenders: [async extra => ({ ...extra, attributes: { title: 'async' } })] },
    })
    expect(commitMock).toHaveBeenCalledWith({ Authorization: 'Bearer collab' }, 1, expect.any(String), {
      basedOnChanged: 100,
      attributes: { title: 'async', revision_log: 'OpenKB commit (manual)' },
    })
  })

  it('a dirty predicate makes a hash-clean doc commit; none keeps it clean', async () => {
    const ydoc = seed(DOC_MARKS)
    ydoc.getMap('_meta').set('last_commit_hash', contentHash(serializeYDoc(ydoc)))
    const arg = { trigger: 'quiet' as const, identity: { token: 'collab' } }

    expect((await commitDocument(hp('node:1', ydoc), 'node:1', {
      ...arg, hooks: { dirtyChecks: [() => false] },
    })).outcome).toBe('clean')
    expect((await commitDocument(hp('node:1', ydoc), 'node:1', {
      ...arg, hooks: { dirtyChecks: [() => true] },
    })).outcome).toBe('committed')
  })

  it('an async dirty predicate commits, and a predicate after a true one is not asked', async () => {
    const ydoc = seed(DOC_MARKS)
    ydoc.getMap('_meta').set('last_commit_hash', contentHash(serializeYDoc(ydoc)))
    const arg = { trigger: 'quiet' as const, identity: { token: 'collab' } }

    // Async because the collaboration server asks Drupal whether anything
    // stands to publish before turning a Save into a write.
    expect((await commitDocument(hp('node:1', ydoc), 'node:1', {
      ...arg, hooks: { dirtyChecks: [async () => true] },
    })).outcome).toBe('committed')

    const asked: string[] = []
    const fresh = seed(DOC_MARKS)
    fresh.getMap('_meta').set('last_commit_hash', contentHash(serializeYDoc(fresh)))
    expect((await commitDocument(hp('node:1', fresh), 'node:1', {
      ...arg,
      hooks: { dirtyChecks: [
        () => { asked.push('cheap'); return true },
        async () => { asked.push('costly'); return true },
      ] },
    })).outcome).toBe('committed')
    expect(asked).toEqual(['cheap'])
  })

  it('a CommitValidationError from an extender blocks as invalid with per-field errors', async () => {
    const ydoc = seed(DOC_MARKS)
    const res = await commitDocument(hp('node:1', ydoc), 'node:1', {
      trigger: 'manual',
      identity: { token: 'collab' },
      now: () => 55,
      hooks: {
        payloadExtenders: [() => {
          throw new CommitValidationError('Validation failed', { field_owner: ['nope'] })
        }],
      },
    })
    expect(res.outcome).toBe('invalid')
    expect(res.fields).toEqual({ field_owner: ['nope'] })
    expect(commitMock).not.toHaveBeenCalled()
    expect(ydoc.getMap('_meta').get('commit_error')).toMatchObject({
      at: 55, kind: 'validation', fields: { field_owner: ['nope'] },
    })
  })

  it('the body-adopt branch commits when a dirty predicate claims the write', async () => {
    // An explicit Save over a standing draft, where Drupal moved to exactly
    // this body. The adopt branch is the exit it reaches, so returning `clean`
    // there would drop the Save and leave the draft standing.
    const ydoc = seed(DOC_MARKS)
    const markdown = serializeYDoc(ydoc)
    ydoc.getMap('_meta').set('drupal_changed', 100)
    ydoc.getMap('_meta').set('last_commit_hash', contentHash(markdown))
    readsPage({ titleHeading: '', id: 'uuid-1', nid: 1, changed: 200, body: markdown } as never)
    commitMock.mockResolvedValue({ changed: 300, review: null })

    const res = await commitDocument(hp('node:1', ydoc), 'node:1', {
      trigger: 'manual',
      identity: { token: 'collab' },
      sessionWrite: { actingUid: 3, coAuthors: [], blocks: {} },
      hooks: { dirtyChecks: [async () => true] },
    })

    expect(res.outcome).toBe('committed')
    expect(commitMock).toHaveBeenCalledOnce()
  })

  it('the body-adopt branch still PATCHes a pending extender payload', async () => {
    const ydoc = seed(DOC_MARKS)
    ydoc.getMap('_meta').set('drupal_changed', 100)
    const markdown = serializeYDoc(ydoc)
    // Drupal moved (changed 100 → 200) but holds exactly this body: without a
    // field payload that is `clean` (covered above); with one, the adopted
    // baseline must unblock the PATCH instead of dropping the field change.
    readsPage({ titleHeading: '', id: 'uuid-1', nid: 1, changed: 200, body: markdown } as never)

    const res = await commitDocument(hp('node:1', ydoc), 'node:1', {
      trigger: 'manual',
      identity: { token: 'collab' },
      hooks: { payloadExtenders: [extra => ({ ...extra, attributes: { title: 'X' } })] },
    })
    expect(res.outcome).toBe('committed')
    expect(commitMock).toHaveBeenCalledOnce()
  })
})

describe('the title heading', () => {
  const DOC_H1: Json = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'A heading the author wrote' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'body' }] },
    ],
  }

  it('is written back byte-identical', async () => {
    const ydoc = seed({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'edited' }] }] })
    readsPage({
      titleHeading: '# Data model {#b-3a1c9e04}\n\n',
      id: 'uuid-1',
      nid: 1,
      changed: 100,
      body: 'body',
    } as never)
    commitMock.mockResolvedValue({ changed: 200, review: null })

    await commitDocument(hp('node:1', ydoc), 'node:1', { trigger: 'manual', identity: { token: 'collab' } })

    expect(commitMock.mock.lastCall![2]).toBe('# Data model {#b-3a1c9e04}\n\nedited\n')
  })

  it('follows a rename made by the same write', async () => {
    const ydoc = seed({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'edited' }] }] })
    readsPage({
      titleHeading: '# Data model {#b-3a1c9e04}\n\n',
      id: 'uuid-1',
      nid: 1,
      changed: 100,
      body: 'body',
    } as never)
    commitMock.mockResolvedValue({ changed: 200, review: null })

    await commitDocument(hp('node:1', ydoc), 'node:1', {
      trigger: 'manual',
      identity: { token: 'collab' },
      hooks: { payloadExtenders: [extra => ({ ...extra, attributes: { title: 'Domain model' } })] },
    })

    expect(commitMock.mock.lastCall![2]).toBe('# Domain model {#b-3a1c9e04}\n\nedited\n')
  })

  it('goes in front of a heading the author wrote, on a body that carried none', async () => {
    const ydoc = seed(DOC_H1)
    readsPage({ titleHeading: '', title: 'Data model', id: 'uuid-1', nid: 1, changed: 100 } as never)
    commitMock.mockResolvedValue({ changed: 200, review: null })

    const res = await commitDocument(hp('node:1', ydoc), 'node:1', {
      trigger: 'manual',
      identity: { token: 'collab' },
    })

    expect(res.markdown).toBe('# A heading the author wrote\n\nbody')
    expect(commitMock.mock.lastCall![2])
      .toMatch(/^# Data model \{#b-[0-9a-f]{8}\}\n\n# A heading the author wrote\n\nbody\n$/)
  })

  it('sets the gap under it to one blank line, whatever the document opens with', async () => {
    const ydoc = seed({
      type: 'doc',
      content: [
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: 'edited' }] },
      ],
    })
    readsPage({
      titleHeading: '# Data model {#b-3a1c9e04}\n\n',
      title: 'Data model',
      id: 'uuid-1',
      nid: 1,
      changed: 100,
      body: 'edited\n',
    } as never)
    commitMock.mockResolvedValue({ changed: 200, review: null })

    const res = await commitDocument(hp('node:1', ydoc), 'node:1', { trigger: 'manual', identity: { token: 'collab' } })

    expect(res.markdown).toMatch(/^\n/)
    expect(commitMock.mock.lastCall![2]).toBe('# Data model {#b-3a1c9e04}\n\nedited\n')
  })

  it('keeps the stored final newline, whatever the serializer emits', async () => {
    const ydoc = seed({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'edited' }] }] })
    readsPage({
      titleHeading: '# Data model {#b-3a1c9e04}\n\n',
      title: 'Data model',
      id: 'uuid-1',
      nid: 1,
      changed: 100,
      body: 'edited\n',
    } as never)
    commitMock.mockResolvedValue({ changed: 200, review: null })

    await commitDocument(hp('node:1', ydoc), 'node:1', { trigger: 'manual', identity: { token: 'collab' } })

    expect(commitMock.mock.lastCall![2]).toBe('# Data model {#b-3a1c9e04}\n\nedited\n')
  })
})

describe('violationFields', () => {
  it('maps JSON:API pointers and detail prefixes to field names', () => {
    expect(violationFields([
      { detail: 'title: This value should not be null.', source: { pointer: '/data/attributes/title' } },
      { detail: 'field_tags.0.target_id: The referenced entity (taxonomy_term: 99) does not exist.', source: { pointer: '/data/relationships/field_tags/data/0' } },
      { detail: 'field_type.0.value: The value you selected is not a valid choice.' },
      { detail: 'Something entirely unlocatable.' },
    ])).toEqual({
      'title': ['This value should not be null.'],
      'field_tags': ['The referenced entity (taxonomy_term: 99) does not exist.'],
      'field_type': ['The value you selected is not a valid choice.'],
      '': ['Something entirely unlocatable.'],
    })
  })

  it('empty and absent input map to no fields', () => {
    expect(violationFields(undefined)).toEqual({})
    expect(violationFields([])).toEqual({})
  })
})
