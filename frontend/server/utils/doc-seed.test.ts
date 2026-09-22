import { describe, it, expect, vi } from 'vitest'
import * as Y from 'yjs'
import { prosemirrorJSONToYDoc, prosemirrorToYXmlFragment } from '@tiptap/y-tiptap'
import { parseMarkdownToDoc } from '../../app/comark/markdown-engine'
import { editorSchema } from './editor-schema'
import { contentHash, serializeYDoc } from './commit'
import { advanceDocumentChanged, fieldsBaseline, resetDocumentToBody, seedFields, seedFromDrupal, type SeedDeps } from './doc-seed'
import type { FieldValues } from './entity-fields'
import { readThreads, recordCommentMessage } from '#shared/block-comments'
import { commentsSynced } from './collab-comments'

type Json = Record<string, unknown>

function docWithText(text: string): Y.Doc {
  const json: Json = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  }
  return prosemirrorJSONToYDoc(editorSchema, json as never, 'default')
}

/** The markdown Drupal would hold for a document seeded via {@link docWithText}. */
function markdownFor(doc: Y.Doc): string {
  return serializeYDoc(doc)
}

/** The first peer filling an empty fragment from Drupal's markdown. */
function hydrateFrom(doc: Y.Doc, body: string): void {
  prosemirrorToYXmlFragment(parseMarkdownToDoc(body), doc.getXmlFragment('default'))
}

function deps(changed: number | null, body: string | null): SeedDeps {
  return {
    fetchChanged: vi.fn(async () => changed),
    fetchBody: vi.fn(async () => body),
    now: () => 4242,
  }
}

const fragmentText = (doc: Y.Doc) => doc.getXmlFragment('default').toString()

describe('seedFromDrupal', () => {
  it('first load: seeds the changed + hash baseline, keeps the fragment', async () => {
    const doc = docWithText('hello')
    const outcome = await seedFromDrupal('node:1', doc, deps(100, 'hello\n'))

    expect(outcome).toBe('seeded')
    expect(doc.getMap('_meta').get('drupal_changed')).toBe(100)
    // The baseline is what a commit WOULD write for that body, not its bytes:
    // the trailing newline never survives a serialization (NORMALIZATIONS F12),
    // and a baseline holding it calls an untouched session dirty.
    expect(doc.getMap('_meta').get('last_commit_hash')).toBe(contentHash('hello'))
    expect(fragmentText(doc)).toContain('hello')
  })

  it('Drupal moved while nobody edited: rewrites the fragment from Drupal', async () => {
    const doc = docWithText('stale from the previous session')
    const meta = doc.getMap('_meta')
    meta.set('drupal_changed', 100)
    meta.set('last_commit_hash', contentHash(markdownFor(doc)))

    const outcome = await seedFromDrupal('node:1', doc, deps(200, 'fresh from Drupal\n'))

    expect(outcome).toBe('reset')
    expect(fragmentText(doc)).toContain('fresh from Drupal')
    expect(fragmentText(doc)).not.toContain('stale from the previous session')
    expect(meta.get('drupal_changed')).toBe(200)
    expect(meta.get('reset_at')).toBe(4242)
    expect(meta.get('last_commit_hash')).toBe(contentHash('fresh from Drupal'))
    expect(meta.get('external_change_detected')).toBeUndefined()
  })

  // The reset used to clear the fragment and leave re-hydration to whichever
  // client connected next. With no client connected — exactly the state a
  // last-peer-disconnect checkpoint fires in — the document stayed empty, and
  // the checkpoint serialized that emptiness into a commit (422 on the required
  // body, or a genuinely blanked page). Moderation made resets frequent
  // enough for it to show, but an empty-fragment window a checkpoint can
  // photograph is wrong on its own terms.
  it('reset never leaves a committable-empty document, with no client involved', async () => {
    const doc = docWithText('stale from the previous session')
    const meta = doc.getMap('_meta')
    meta.set('drupal_changed', 100)
    meta.set('last_commit_hash', contentHash(markdownFor(doc)))
    // What Drupal holds is what a commit wrote, i.e. serializer output.
    const drupalBody = markdownFor(docWithText('fresh from Drupal'))

    const outcome = await seedFromDrupal('node:1', doc, deps(200, drupalBody))

    expect(outcome).toBe('reset')
    // Nobody hydrated this document — the reset itself put Drupal's content in.
    expect(doc.getXmlFragment('default').length).toBeGreaterThan(0)
    expect(serializeYDoc(doc)).toBe(drupalBody)
    // And what it serializes to is exactly the hash baseline the reset wrote,
    // so a checkpoint firing right now is a clean no-op rather than a write.
    expect(contentHash(serializeYDoc(doc))).toBe(meta.get('last_commit_hash'))
  })

  // The snapshot store is keyed by node id and outlives the node, so a
  // document name can come round again onto a different page — every
  // environment that reinstalls its site behind a kept store does exactly
  // that. Handing that page's first peer the previous one's deletion stamp
  // closes their editor on a deletion that never happened to them.
  it('a deletion stamp on a node Drupal still has is cleared', async () => {
    const doc = docWithText('a new page on a reused document name')
    const meta = doc.getMap('_meta')
    meta.set('deleted_at', 1700000000000)

    const outcome = await seedFromDrupal('node:1', doc, deps(100, 'a new page on a reused document name\n'))

    expect(outcome).toBe('seeded')
    expect(meta.get('deleted_at')).toBeUndefined()
  })

  it('a deletion stamp survives while Drupal cannot answer for the node', async () => {
    const doc = docWithText('deleted under its peers')
    const meta = doc.getMap('_meta')
    meta.set('deleted_at', 1700000000000)

    const outcome = await seedFromDrupal('node:1', doc, deps(null, null))

    expect(outcome).toBe('unavailable')
    expect(meta.get('deleted_at')).toBe(1700000000000)
  })

  it('reset onto an empty Drupal body clears the fragment', async () => {
    const doc = docWithText('stale')
    const meta = doc.getMap('_meta')
    meta.set('drupal_changed', 100)
    meta.set('last_commit_hash', contentHash(markdownFor(doc)))

    const outcome = await seedFromDrupal('node:1', doc, deps(200, ''))

    expect(outcome).toBe('reset')
    expect(doc.getXmlFragment('default').length).toBe(0)
  })

  it('a stale external_change flag is cleared by the reset', async () => {
    const doc = docWithText('stale')
    const meta = doc.getMap('_meta')
    meta.set('drupal_changed', 100)
    meta.set('last_commit_hash', contentHash(markdownFor(doc)))
    meta.set('external_change_detected', { actual: 150, at: 1 })

    await seedFromDrupal('node:1', doc, deps(200, 'fresh\n'))

    expect(meta.get('external_change_detected')).toBeUndefined()
  })

  it('Drupal wins over a hot document that diverged from its baseline', async () => {
    const doc = docWithText('whatever the last session left behind')
    const meta = doc.getMap('_meta')
    meta.set('drupal_changed', 100)
    meta.set('last_commit_hash', contentHash('an older revision\n'))

    const outcome = await seedFromDrupal('node:1', doc, deps(200, 'fresh from Drupal\n'))

    expect(outcome).toBe('reset')
    expect(fragmentText(doc)).toContain('fresh from Drupal')
    expect(meta.get('drupal_changed')).toBe(200)
  })

  it('hot doc already equals Drupal: adopts the baseline instead of warning', async () => {
    // A checkpoint that PATCHed Drupal but lost its _meta write to the unload,
    // or a client-side revert onto the external revision.
    const doc = docWithText('the very same text')
    const meta = doc.getMap('_meta')
    meta.set('drupal_changed', 100)
    meta.set('last_commit_hash', contentHash('an older revision\n'))

    const outcome = await seedFromDrupal('node:1', doc, deps(200, markdownFor(doc)))

    expect(outcome).toBe('adopted')
    expect(fragmentText(doc)).toContain('the very same text')
    expect(meta.get('drupal_changed')).toBe(200)
    expect(meta.get('last_commit_hash')).toBe(contentHash(markdownFor(doc)))
    expect(meta.get('external_change_detected')).toBeUndefined()
  })

  it('in sync: no writes at all', async () => {
    const doc = docWithText('same')
    const meta = doc.getMap('_meta')
    meta.set('drupal_changed', 100)
    meta.set('last_commit_hash', contentHash(markdownFor(doc)))

    const outcome = await seedFromDrupal('node:1', doc, deps(100, markdownFor(doc)))

    expect(outcome).toBe('in-sync')
    expect(meta.get('reset_at')).toBeUndefined()
    expect(fragmentText(doc)).toContain('same')
  })

  it('pre-commit-service snapshot: backfills only the hash baseline', async () => {
    const doc = docWithText('legacy snapshot')
    doc.getMap('_meta').set('drupal_changed', 100)

    const outcome = await seedFromDrupal('node:1', doc, deps(100, markdownFor(doc)))

    expect(outcome).toBe('backfilled')
    expect(doc.getMap('_meta').get('last_commit_hash')).toBe(contentHash(markdownFor(doc)))
    expect(fragmentText(doc)).toContain('legacy snapshot')
  })

  it('same-second external write: the body hash catches what `changed` cannot', async () => {
    // Drupal's `changed` is second-granular — a checkpoint and an external
    // write in the same second carry the identical timestamp.
    const doc = docWithText('what the last session committed')
    const meta = doc.getMap('_meta')
    meta.set('drupal_changed', 100)
    meta.set('last_commit_hash', contentHash(markdownFor(doc)))

    const outcome = await seedFromDrupal('node:1', doc, deps(100, 'an external agent wrote this\n'))

    expect(outcome).toBe('reset')
    expect(fragmentText(doc)).toContain('an external agent wrote this')
    expect(meta.get('last_commit_hash')).toBe(contentHash('an external agent wrote this'))
  })

  it('a body spelled non-canonically is not a session that changed something', async () => {
    // `_em_`, `* item` bullets and a setext heading are all valid markdown
    // comark reads exactly as its own spelling of them, and every one of them
    // is in NORMALIZATIONS.md — so an imported or hand-written page
    // serializes back differently while saying the same thing. Baselined on the
    // stored bytes, a session where nobody typed a character is dirty from the
    // moment a peer hydrates it: the disconnect checkpoint writes a revision
    // canonicalizing the whole body, Drupal's per-block diff calls every
    // drifted block changed, and the window names nobody for any of them — so
    // each one is stamped as writing no server witnessed, unapprovable by
    // anybody, from a visit that changed nothing. Some of the transforms lose
    // content outright (block HTML), so the same visit deletes it.
    const legacy = 'Title\n=====\n\nA paragraph with _emphasis_ in it. {#b-1}\n\n* one\n* two\n'
    const doc = new Y.Doc()
    const outcome = await seedFromDrupal('node:1', doc, deps(100, legacy))
    expect(outcome).toBe('seeded')

    // The first peer hydrates the fragment from that same body — the state a
    // read-only visit leaves the document in.
    hydrateFrom(doc, legacy)

    // Through the transforms a checkpoint runs, which is what its dirty check
    // compares — so what this asserts is that the checkpoint is a clean no-op.
    const wouldWrite = serializeYDoc(doc)
    expect(wouldWrite).not.toBe(legacy)
    expect(doc.getMap('_meta').get('last_commit_hash')).toBe(contentHash(wouldWrite))
  })

  it('Drupal unreachable: leaves the document untouched', async () => {
    const doc = docWithText('hot')
    doc.getMap('_meta').set('drupal_changed', 100)
    const d = deps(null, null)

    const outcome = await seedFromDrupal('node:1', doc, d)

    expect(outcome).toBe('unavailable')
    expect(d.fetchBody).not.toHaveBeenCalled()
    expect(fragmentText(doc)).toContain('hot')
  })

  it('foreign document namespace is ignored', async () => {
    const doc = docWithText('x')
    const d = deps(200, 'y\n')

    expect(await seedFromDrupal('other:1', doc, d)).toBe('unavailable')
    expect(d.fetchChanged).not.toHaveBeenCalled()
  })

  it('an empty hot fragment is never treated as dirty', async () => {
    const doc = new Y.Doc()
    const meta = doc.getMap('_meta')
    meta.set('drupal_changed', 100)
    meta.set('last_commit_hash', contentHash('whatever\n'))

    expect(await seedFromDrupal('node:1', doc, deps(200, 'fresh\n'))).toBe('reset')
    expect(meta.get('drupal_changed')).toBe(200)
  })
})

describe('seedFromDrupal — fields lane', () => {
  const drupalFields = {
    title: 'Getting started',
    summary: 'One paragraph.',
    owner: { id: 'uuid-marta', label: 'Marta Vogel' },
    tags: [{ id: 'uuid-search', label: 'search' }],
  }

  function fieldDeps(
    changed: number | null,
    body: string | null,
    fields: FieldValues | null,
  ): SeedDeps {
    return { ...deps(changed, body), fetchFields: vi.fn(async () => fields) }
  }

  it('first load: seeds the fields map and records the Drupal baseline', async () => {
    const doc = docWithText('hello')

    await seedFromDrupal('node:1', doc, fieldDeps(100, 'hello\n', drupalFields))

    expect(Object.fromEntries(doc.getMap('fields').entries())).toEqual(drupalFields)
    expect(fieldsBaseline(doc)).toEqual(drupalFields)
  })

  it('session-less reconcile: Drupal wins over stale field values', async () => {
    const doc = docWithText('same')
    const meta = doc.getMap('_meta')
    meta.set('drupal_changed', 100)
    meta.set('last_commit_hash', contentHash(markdownFor(doc)))
    doc.getMap('fields').set('summary', 'what the previous session left')

    await seedFromDrupal('node:1', doc, fieldDeps(100, markdownFor(doc), drupalFields))

    expect(doc.getMap('fields').get('summary')).toBe('One paragraph.')
    expect(fieldsBaseline(doc)).toEqual(drupalFields)
  })

  it('writes only the keys that actually differ', async () => {
    const doc = docWithText('hello')
    seedFields(doc, drupalFields)
    let updates = 0
    doc.getMap('fields').observe(() => { updates += 1 })

    await seedFromDrupal('node:1', doc, fieldDeps(100, 'hello\n', { ...drupalFields, summary: 'Rewritten.' }))

    expect(updates).toBe(1)
    expect(doc.getMap('fields').get('summary')).toBe('Rewritten.')
    expect(doc.getMap('fields').get('owner')).toEqual(drupalFields.owner)
  })

  it('drops a key the exposure contract no longer carries', async () => {
    // The document was persisted while `space` was on the frontmatter form
    // display; Drupal now serves a narrower value set. Leaving the key in the
    // live map would make it diverge from the baseline forever, and the commit
    // has nothing to address it with.
    const doc = docWithText('hello')
    seedFields(doc, { ...drupalFields, space: { id: 'uuid-space', label: 'General' } })

    await seedFromDrupal('node:1', doc, fieldDeps(100, 'hello\n', drupalFields))

    expect(doc.getMap('fields').has('space')).toBe(false)
    expect(fieldsBaseline(doc)).toEqual(drupalFields)
  })

  it('an unreachable schema leaves the fields untouched but still reconciles the body', async () => {
    const doc = docWithText('stale')
    const meta = doc.getMap('_meta')
    meta.set('drupal_changed', 100)
    meta.set('last_commit_hash', contentHash(markdownFor(doc)))
    seedFields(doc, drupalFields)

    const outcome = await seedFromDrupal('node:1', doc, fieldDeps(200, 'fresh\n', null))

    expect(outcome).toBe('reset')
    expect(doc.getMap('fields').get('summary')).toBe('One paragraph.')
    expect(fieldsBaseline(doc)).toEqual(drupalFields)
  })

  it('documents without a field source keep working', async () => {
    const doc = docWithText('hello')

    expect(await seedFromDrupal('node:1', doc, deps(100, 'hello\n'))).toBe('seeded')
    expect(doc.getMap('fields').size).toBe(0)
    expect(fieldsBaseline(doc)).toBeNull()
  })
})

describe('resetDocumentToBody', () => {
  it('replaces the body and moves the baseline onto the written revision', () => {
    const doc = docWithText('the draft nobody wants')
    const meta = doc.getMap('_meta')
    meta.set('drupal_changed', 100)
    meta.set('last_commit_hash', contentHash(markdownFor(doc)))
    meta.set('external_change_detected', { actual: 150, at: 1 })
    meta.set('commit_error', { at: 1, kind: 'validation', message: 'nope' })

    resetDocumentToBody(doc, 'back to the live text\n', 200, () => 4242)

    expect(fragmentText(doc)).toContain('back to the live text')
    expect(fragmentText(doc)).not.toContain('the draft nobody wants')
    expect(meta.get('drupal_changed')).toBe(200)
    expect(meta.get('last_commit_hash')).toBe(contentHash('back to the live text\n'))
    expect(meta.get('reset_at')).toBe(4242)
    // A revert clears the two flags it has just made untrue: the session is on
    // Drupal's newest revision, and the values that failed validation are gone.
    expect(meta.get('external_change_detected')).toBeUndefined()
    expect(meta.get('commit_error')).toBeUndefined()
  })

  it('leaves the reverted document clean — the next checkpoint writes nothing', () => {
    // The published body a revert reads back was itself written by a commit,
    // so it is already in canonical serialized form. That is what makes the
    // recorded hash and the re-seeded fragment's own serialization agree.
    const published = markdownFor(docWithText('back to the live text'))
    const doc = docWithText('the draft nobody wants')
    doc.getMap('_meta').set('drupal_changed', 100)

    resetDocumentToBody(doc, published, 200)

    // Serializing the re-seeded fragment must reproduce the hash the reset
    // recorded, or every session after a revert commits a phantom revision.
    expect(contentHash(markdownFor(doc))).toBe(doc.getMap('_meta').get('last_commit_hash'))
  })

  it('signals the checkpoint last, so peers drop their mirror on settled state', () => {
    const doc = docWithText('draft')
    resetDocumentToBody(doc, 'published\n', 200, () => 4242)

    expect(doc.getMap('_meta').get('last_commit')).toEqual({
      at: 4242,
      changed: 200,
      hash: contentHash('published\n'),
      trigger: 'revert',
    })
  })
})

describe('advanceDocumentChanged', () => {
  it('moves the concurrency token without touching the body or its hash', () => {
    const doc = docWithText('unchanged by a publish')
    const meta = doc.getMap('_meta')
    const hash = contentHash(markdownFor(doc))
    meta.set('drupal_changed', 100)
    meta.set('last_commit_hash', hash)
    meta.set('external_change_detected', { actual: 150, at: 1 })

    advanceDocumentChanged(doc, 200, () => 4242)

    expect(meta.get('drupal_changed')).toBe(200)
    expect(meta.get('last_commit_hash')).toBe(hash)
    expect(meta.get('last_save_at')).toBe(4242)
    expect(meta.get('external_change_detected')).toBeUndefined()
    expect(fragmentText(doc)).toContain('unchanged by a publish')
  })
})

describe('seedFromDrupal — conversations lane', () => {
  const OWNER = '11111111-1111-4111-8111-111111111111'
  const said = {
    anchor: 'b-1',
    thread_id: 'c-1',
    msg_id: 'm-1',
    uid: 7,
    data: { uid: 7, at: 1, text: 'said in an earlier session' },
  }

  function commentDeps(stored: { uuid: string, messages: typeof said[] } | null): SeedDeps {
    return { ...deps(100, 'hello\n'), fetchComments: vi.fn(async () => stored) }
  }

  it('takes Drupal\'s conversations, and that is what makes the document statable', async () => {
    const doc = docWithText('hello')

    await seedFromDrupal('node:1', doc, commentDeps({ uuid: OWNER, messages: [said] }))

    expect(readThreads(doc).map(thread => thread.messages[0]!.text)).toEqual([said.data.text])
    expect(commentsSynced(doc)).toBe(true)
  })

  it('leaves the document unstatable when Drupal could not be asked', async () => {
    const doc = docWithText('hello')
    recordCommentMessage(doc, 'b-1', 'c-1', 'm-1', { uid: 7, at: 1, text: 'typed here' })

    await seedFromDrupal('node:1', doc, commentDeps(null))

    expect(readThreads(doc)).toHaveLength(1)
    expect(commentsSynced(doc)).toBe(false)
  })
})
