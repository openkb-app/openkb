import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'
import { fieldSpecs } from './entity-fields'
import { getKbPage } from './kb-read'
import { blockVersion } from './block-versions'
import { splitTitleHeading } from './title-heading'

/**
 * Which requests a read costs, and where its values come from.
 *
 * Both reads are CE pages: the display carries the body and every frontmatter
 * field, so one request answers each. The working copy costs a second only
 * where a forward draft is there to read, and it is served to the accounts
 * that may write the page.
 */

/**
 * The one parser both `kb-read.ts` and `block-versions.ts` reach for, wrapped
 * so a read's parse cost is assertable and so the parse-error branch can be
 * driven on demand. The implementation stays the real one.
 */
const parseMarkdown = vi.hoisted(() => vi.fn())
vi.mock('../../app/comark/markdown-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../app/comark/markdown-engine')>()
  parseMarkdown.mockImplementation(actual.parseMarkdownToDoc)
  return { ...actual, parseMarkdownToDoc: (md: string) => parseMarkdown(md) }
})

const fetchCePage = vi.fn()
const fetchCeWorkingCopy = vi.fn()
const fetchFrontmatterSpecs = vi.fn()
const fetchInlineComments = vi.fn()

vi.mock('./drupal', () => ({
  drupalBaseUrl: () => 'http://drupal.test',
  fetchCePage: (...a: unknown[]) => fetchCePage(...a),
  fetchCeWorkingCopy: (...a: unknown[]) => fetchCeWorkingCopy(...a),
  fetchFrontmatterSpecs: (...a: unknown[]) => fetchFrontmatterSpecs(...a),
  fetchInlineComments: (...a: unknown[]) => fetchInlineComments(...a),
}))

const collabIdentityConfigured = vi.fn(() => true)
vi.mock('./collab-identity', () => ({
  collabIdentityConfigured: () => collabIdentityConfigured(),
  asCollabServer: (run: (auth: Record<string, string>) => unknown) =>
    run({ Authorization: 'Bearer collab-server' }),
}))

const liveContent = vi.fn()
const liveThreads = vi.fn()
vi.mock('./session-read', () => ({
  liveContent: (...a: unknown[]) => liveContent(...a),
  liveThreads: (...a: unknown[]) => liveThreads(...a),
}))

const fetchModerationStatus = vi.fn()
vi.mock('./moderation', () => ({
  fetchModerationStatus: (...a: unknown[]) => fetchModerationStatus(...a),
}))

const SPECS = fieldSpecs({
  properties: {
    summary: { type: 'string', 'x-field-name': 'field_summary' },
    tags: {
      type: 'array',
      items: { type: 'object', 'x-entity-reference': { entity_type: 'taxonomy_term' } },
      'x-field-name': 'field_tags',
    },
  },
})

const EVENT = { node: { req: { headers: {} } } } as unknown as H3Event

const CE_PAGE = {
  page: {
    id: 'u-7',
    nid: 7,
    path: '/team-wiki/getting-started',
    title: 'Getting started',
    titleHeading: '# Getting started {#b-0}\n\n',
    body: 'Body text. {#b-1}',
    changed: 1782000000,
    blockMeta: '',
    space: null,
  },
  props: {
    title: 'Getting started',
    summary: 'An abstract.',
    tags: [{ uuid: 't-1', label: 'platform' }],
  },
  canEdit: false,
  hasDraft: false,
}

/** What {@link fetchCeWorkingCopy} answers: one CE read, either revision. */
function workingCopy(
  page: Partial<typeof CE_PAGE.page> = {},
  props: Record<string, unknown> = {},
) {
  return {
    page: { ...CE_PAGE.page, ...page },
    props: { title: CE_PAGE.page.title, ...props },
    canEdit: true,
    hasDraft: true,
  }
}

describe('getKbPage', () => {
  beforeEach(() => {
    fetchCePage.mockReset().mockResolvedValue(CE_PAGE)
    fetchCeWorkingCopy.mockReset()
    fetchFrontmatterSpecs.mockReset().mockResolvedValue(SPECS)
    liveContent.mockReset().mockReturnValue(null)
    fetchModerationStatus.mockReset()
  })

  it('projects the published page off the CE page it already read', async () => {
    const page = await getKbPage(EVENT, 'team-wiki/getting-started.md')

    // The page comes back once: the frontmatter block above the body, and the
    // fields structured. No second copy of the body beside it.
    expect(page).toEqual({
      path: '/team-wiki/getting-started',
      title: 'Getting started',
      frontmatter: { summary: 'An abstract.', tags: [{ id: 't-1', label: 'platform' }] },
      markdown: expect.stringContaining('summary: An abstract.'),
      // What an updateBlocks op sends back as `expect` (OKB-164).
      versions: { 'b-1': expect.stringMatching(/^[0-9a-f]{12}$/) },
    })
    expect(page!.markdown).toContain('Body text.')
    expect(fetchCePage).toHaveBeenCalledWith(EVENT, 'team-wiki/getting-started')
    expect(fetchCeWorkingCopy).not.toHaveBeenCalled()
  })

  it('reads the working copy over ce-api, off the page the path read already has', async () => {
    const editable = { ...CE_PAGE, canEdit: true }
    fetchCePage.mockResolvedValue(editable)
    fetchCeWorkingCopy.mockResolvedValue(
      workingCopy({ body: 'Draft body.' }, { summary: 'Draft abstract.', tags: [] }),
    )

    const page = await getKbPage(EVENT, 'team-wiki/getting-started', { version: 'working-copy' })

    expect(page).toMatchObject({
      markdown: expect.stringContaining('Draft body.'),
      frontmatter: { summary: 'Draft abstract.', tags: [] },
    })
    // The path read is handed over, so the live revision is not fetched twice.
    expect(fetchCeWorkingCopy).toHaveBeenCalledWith({}, 7, editable)
  })

  it('reads the stored conversations as the collab server, not as the caller', async () => {
    // `use inline comments api` is a permission no agent scope names, so the
    // caller's own Bearer would be refused where the collab server's is not.
    fetchCePage.mockResolvedValue({ ...CE_PAGE, canEdit: true })
    fetchCeWorkingCopy.mockResolvedValue(
      workingCopy({ body: 'Draft body.' }, { summary: 'Draft.', tags: [] }),
    )
    liveThreads.mockResolvedValue(null)
    fetchInlineComments.mockResolvedValue({ messages: [] })

    const page = await getKbPage(EVENT, 'team-wiki/getting-started', {
      version: 'working-copy',
      withComments: true,
    })

    expect(page?.comments).toEqual([])
    expect(fetchInlineComments).toHaveBeenCalledWith(
      { Authorization: 'Bearer collab-server' }, 'node', 7,
    )
  })

  it('raises a failed conversation read rather than reporting no threads', async () => {
    fetchCePage.mockResolvedValue({ ...CE_PAGE, canEdit: true })
    fetchCeWorkingCopy.mockResolvedValue(
      workingCopy({ body: 'Draft body.' }, { summary: 'Draft.', tags: [] }),
    )
    liveThreads.mockResolvedValue(null)
    fetchInlineComments.mockRejectedValue(Object.assign(new Error('Boom'), { statusCode: 500 }))

    await expect(getKbPage(EVENT, 'team-wiki/getting-started', {
      version: 'working-copy',
      withComments: true,
    })).rejects.toThrow('Boom')
  })

  it('lets an open collab session speak for the working copy', async () => {
    fetchCePage.mockResolvedValue({ ...CE_PAGE, canEdit: true })
    fetchCeWorkingCopy.mockResolvedValue(
      workingCopy({ body: 'Committed draft.' }, { summary: 'Committed.', tags: [] }),
    )
    liveContent.mockResolvedValue({ body: 'Live body.', fields: { summary: 'Live.' } })

    const page = await getKbPage(EVENT, 'team-wiki/getting-started', { version: 'working-copy' })

    expect(page).toMatchObject({
      markdown: expect.stringContaining('Live body.'),
      frontmatter: { summary: 'Live.' },
    })
  })

  it('refuses the working copy to an account that may not write the page', async () => {
    // The draft address and `getPageForEditing` are the editing surfaces'
    // reads. A reader is refused rather than served the published body under
    // a draft address, and nothing is read on their behalf.
    liveContent.mockResolvedValue({ body: 'Live body.', fields: { summary: 'Live.' } })

    await expect(getKbPage(EVENT, 'team-wiki/getting-started', { version: 'working-copy' }))
      .rejects.toMatchObject({ statusCode: 403 })
    expect(fetchCeWorkingCopy).not.toHaveBeenCalled()
    expect(liveContent).not.toHaveBeenCalled()
  })

  it('serves the body a write would hold, without the title heading', async () => {
    // The stored body carries `# <title>` — the seeded corpus and every page
    // the in-app CTA creates do. A commit takes it off, and so does every
    // serialization of the live document, so a read that kept it would offer
    // an `expect` for a block no write can match.
    const page = await getKbPage(EVENT, 'team-wiki/getting-started.md')

    expect(page!.markdown).not.toContain('# Getting started')
    expect(page!.versions).not.toHaveProperty('b-0')
    expect(page!.versions).toHaveProperty('b-1')
  })

  it('strips the heading on the draft lane too, so both reads agree', async () => {
    fetchCePage.mockResolvedValue({ ...CE_PAGE, canEdit: true })
    fetchCeWorkingCopy.mockResolvedValue(workingCopy())
    liveContent.mockResolvedValue(null)

    const published = await getKbPage(EVENT, 'team-wiki/getting-started')
    const draft = await getKbPage(EVENT, 'team-wiki/getting-started', { version: 'working-copy' })

    expect(draft!.versions).toEqual(published!.versions)
  })

  it('leaves a body carrying no title heading byte-for-byte alone', async () => {
    // Only the case that needs normalizing pays the parse: a legacy spelling
    // must not be canonicalized behind the reader's back.
    fetchCePage.mockResolvedValue({
      ...CE_PAGE,
      page: { ...CE_PAGE.page, body: 'Plain _em_ body. {#b-1}' },
    })

    const page = await getKbPage(EVENT, 'team-wiki/getting-started.md')

    expect(page!.markdown).toContain('Plain _em_ body. {#b-1}')
  })

  it('answers null for a path that resolves to no page', async () => {
    fetchCePage.mockResolvedValue(null)
    expect(await getKbPage(EVENT, 'team-wiki/missing')).toBeNull()
    expect(fetchFrontmatterSpecs).not.toHaveBeenCalled()
  })
})

/**
 * The editorial standing an agent otherwise had to infer from prose (OKB-173).
 * One source — Drupal's moderation read, under the caller's own carrier — plus
 * the sidecar of the revision being projected.
 */
describe('getKbPage status', () => {
  const MODERATED = {
    nid: 7,
    moderated: true,
    state: 'draft',
    hasPublishedRevision: true,
    hasUnpublishedChanges: true,
    canPublish: true,
    reviewSteps: ['peer'],
  }

  /** Two blocks awaiting a peer sign-off, one already signed off. */
  const PENDING_META = JSON.stringify({
    'b-1': { 'pending:peer': { by: [3], ok: [] } },
    'b-2': { 'pending:peer': { by: [3], ok: [] } },
    'b-3': { 'review:peer': { uid: 4, at: 1782000000 } },
  })

  beforeEach(() => {
    fetchCePage.mockReset().mockResolvedValue({ ...CE_PAGE, canEdit: true })
    fetchCeWorkingCopy.mockReset()
    fetchFrontmatterSpecs.mockReset().mockResolvedValue(SPECS)
    liveContent.mockReset().mockReturnValue(null)
    fetchModerationStatus.mockReset()
  })

  it('reports a published page with no draft as nothing to publish', async () => {
    fetchModerationStatus.mockResolvedValue({
      ...MODERATED,
      state: 'published',
      hasUnpublishedChanges: false,
      canPublish: true,
    })

    const page = await getKbPage(EVENT, 'team-wiki/getting-started', { withStatus: true })

    expect(page!.status).toEqual({ draft_exists: false, blocks_pending: 0, can_publish: false })
    expect(fetchModerationStatus).toHaveBeenCalledWith({}, 7)
  })

  it('counts the blocks of the revision it served that still owe an enforced step', async () => {
    fetchCePage.mockResolvedValue({ ...CE_PAGE, canEdit: true })
    fetchCeWorkingCopy.mockResolvedValue(workingCopy({ blockMeta: PENDING_META }))
    fetchModerationStatus.mockResolvedValue(MODERATED)

    const page = await getKbPage(EVENT, 'team-wiki/getting-started', {
      version: 'working-copy',
      withStatus: true,
    })

    // Only the steps the space enforces count: the agent step is not one here.
    // And a block still owing one is what the publish gate refuses on, so the
    // account holding the transition still may not publish.
    expect(page!.status).toEqual({ draft_exists: true, blocks_pending: 2, can_publish: false })
  })

  it('answers can_publish off the working copy on a published read', async () => {
    // What is live owes nothing; the draft above it owes two. A publish
    // transitions the draft, so `can_publish` is the draft's answer while
    // `blocks_pending` stays the answer for the revision served.
    fetchCeWorkingCopy.mockResolvedValue(workingCopy({ blockMeta: PENDING_META }))
    fetchModerationStatus.mockResolvedValue(MODERATED)

    const page = await getKbPage(EVENT, 'team-wiki/getting-started', { withStatus: true })

    expect(page!.status).toEqual({ draft_exists: true, blocks_pending: 0, can_publish: false })
    expect(fetchCeWorkingCopy).toHaveBeenCalledWith({}, 7, { ...CE_PAGE, canEdit: true })
  })

  it('reads no working copy where there is no draft to read', async () => {
    fetchModerationStatus.mockResolvedValue({
      ...MODERATED,
      state: 'published',
      hasUnpublishedChanges: false,
    })

    await getKbPage(EVENT, 'team-wiki/getting-started', { withStatus: true })

    expect(fetchCeWorkingCopy).not.toHaveBeenCalled()
  })

  it('reports a draft whose blocks are all signed off as ready to publish', async () => {
    fetchCeWorkingCopy.mockResolvedValue(workingCopy({
      blockMeta: JSON.stringify({ 'b-1': { 'review:peer': { uid: 4, at: 1782000000 } } }),
    }))
    fetchModerationStatus.mockResolvedValue(MODERATED)

    const page = await getKbPage(EVENT, 'team-wiki/getting-started', {
      version: 'working-copy',
      withStatus: true,
    })

    expect(page!.status).toEqual({ draft_exists: true, blocks_pending: 0, can_publish: true })
  })

  it('is the calling account\'s answer: no edit access, no status and no status read', async () => {
    fetchCePage.mockResolvedValue({ ...CE_PAGE, canEdit: false })

    const page = await getKbPage(EVENT, 'team-wiki/getting-started', { withStatus: true })

    // The moderation route is gated on the same update access `canEdit`
    // reports, so a reader is never sent into a 403.
    expect(page!.status).toBeUndefined()
    expect(fetchModerationStatus).not.toHaveBeenCalled()
  })

  it('costs nothing when the caller did not ask for it', async () => {
    await getKbPage(EVENT, 'team-wiki/getting-started')
    expect(fetchModerationStatus).not.toHaveBeenCalled()
  })

  it('leaves the field off rather than failing the read when the status is unreachable', async () => {
    fetchModerationStatus.mockRejectedValue({ statusCode: 503 })

    const page = await getKbPage(EVENT, 'team-wiki/getting-started', { withStatus: true })

    expect(page!.markdown).toContain('Body text.')
    expect(page!.status).toBeUndefined()
  })
})

/**
 * What a read costs in parses, and what it hashes.
 *
 * A read parses the stored body once and reads both halves off that parse: the
 * bytes it serves and the canonical form block versions hash. The versions are
 * the `expect` contract an agent's `updateBlocks` op is checked against, so
 * they may not move for a reason nobody can see — the table below is frozen,
 * and a diff in it is a change to that contract, not a test to re-bless.
 */
describe('getKbPage body projection', () => {
  /** Stored body → the body served, and the versions hashed off it. */
  const CORPUS: Record<string, { body: string, markdown: string, versions: Record<string, string> }> = {
    'a seeded title heading, taken off': {
      body: '# Getting started {#b-0}\n\nBody text. {#b-1}',
      markdown: 'Body text. {#b-1}',
      versions: { 'b-1': '42a334910219' },
    },
    'no leading heading: served byte-for-byte': {
      body: 'Plain _em_ body. {#b-1}\n\n* item one\n* item two\n',
      markdown: 'Plain _em_ body. {#b-1}\n\n* item one\n* item two\n',
      versions: { 'b-1': '271b411c5fc1' },
    },
    'a real `#` heading behind the title: kept, and versioned': {
      body: '# Getting started {#b-0}\n\n# A real heading {#b-1}\n\nBody. {#b-2}',
      markdown: '# A real heading {#b-1}\n\nBody. {#b-2}',
      versions: { 'b-1': 'c13808b6c26b', 'b-2': '16adc21fc3fb' },
    },
    'nothing but the title': {
      body: '# Getting started {#b-0}\n',
      markdown: '',
      versions: {},
    },
    'an empty body': {
      body: '',
      markdown: '',
      versions: {},
    },
    'a legacy spelling: served as stored, versioned canonically': {
      body: 'A heading {#b-2}\n---\n\nAfter. {#b-3}\n',
      markdown: 'A heading {#b-2}\n---\n\nAfter. {#b-3}\n',
      versions: { 'b-2': 'cd380b735a50', 'b-3': '1da40a942286' },
    },
    'a fenced block, kept whole': {
      body: '::callout{type="info" #b-9}\nBody text.\n\nSecond para.\n::\n\nAfter. {#b-1}\n',
      markdown: '::callout{type="info" #b-9}\nBody text.\n\nSecond para.\n::\n\nAfter. {#b-1}\n',
      versions: { 'b-9': 'eb8e521d41ce', 'b-1': '4057b8bad0cf' },
    },
  }

  /** A read of one stored body, split at the boundary the mappers split at. */
  async function read(stored: string) {
    fetchCePage.mockResolvedValue({
      page: { ...CE_PAGE.page, ...splitTitleHeading(stored) },
      props: { title: CE_PAGE.page.title },
    })
    fetchFrontmatterSpecs.mockResolvedValue(fieldSpecs({ properties: {} }))
    parseMarkdown.mockClear()
    return (await getKbPage(EVENT, 'team-wiki/getting-started.md'))!
  }

  beforeEach(() => {
    fetchCePage.mockReset()
    fetchCeWorkingCopy.mockReset()
    fetchFrontmatterSpecs.mockReset()
    liveContent.mockReset().mockReturnValue(null)
    fetchModerationStatus.mockReset()
  })

  for (const [name, expected] of Object.entries(CORPUS)) {
    it(`serves and versions ${name}`, async () => {
      const page = await read(expected.body)

      expect(page.markdown).toBe(expected.markdown)
      expect(page.versions).toEqual(expected.versions)
    })

    it(`parses ${name} once`, async () => {
      await read(expected.body)

      // Both halves come off one parse. An empty body needs none at all.
      expect(parseMarkdown.mock.calls.length).toBeLessThanOrEqual(1)
    })
  }

  it('parses a body with content exactly once', async () => {
    await read('# Getting started {#b-0}\n\nBody text. {#b-1}')
    expect(parseMarkdown).toHaveBeenCalledTimes(1)
  })

  it('versions content, not spelling', async () => {
    // Drupal may hold an older spelling of the same block; a session serializes
    // it canonically. Hashing the served bytes would call that a change nobody
    // made, so the canonical form is what gets hashed.
    const underscores = await read('An _emphasis_ here. {#b-1}')
    const asterisks = await read('An *emphasis* here. {#b-1}')
    expect(underscores.versions).toEqual(asterisks.versions)

    const setext = await read('A heading {#b-2}\n---\n')
    const atx = await read('## A heading {#b-2}\n')
    expect(setext.versions).toEqual(atx.versions)
  })

  it('serves the body as characters, and versions the stored spelling', async () => {
    // Whoever reads here reads source — a model over MCP, a person on the
    // `.md` address — so no entity reaches them (ADR 0014). Code keeps the
    // serializer's spelling, and so does the hash: the `expect` contract is
    // about the stored block, not about how it is served.
    const stored = 'Wiki &amp; AI, 5 &lt; 6, &lt;span&gt;x&lt;/span&gt; {#b-1}\n\n```\ncode &amp; fence\n```\n'
    const page = await read(stored)

    expect(page.markdown).toContain('Wiki & AI, 5 < 6, <span>x</span> {#b-1}')
    expect(page.markdown).toContain('code &amp; fence')
    expect(page.versions['b-1']).toBe(blockVersion('Wiki &amp; AI, 5 &lt; 6, &lt;span&gt;x&lt;/span&gt; {#b-1}'))
  })

  it('serves and versions a body nothing can parse as its own bytes', async () => {
    parseMarkdown.mockImplementationOnce(() => {
      throw new Error('no')
    })

    const page = await read('Unparseable {#b-1}\n')

    // The one parse it was owed is the one that threw: nothing parses it again
    // to hash it, and the stored bytes stand for both halves.
    expect(parseMarkdown).toHaveBeenCalledTimes(1)
    expect(page.markdown).toBe('Unparseable {#b-1}\n')
    expect(page.versions).toEqual({ 'b-1': blockVersion('Unparseable {#b-1}') })
  })
})
