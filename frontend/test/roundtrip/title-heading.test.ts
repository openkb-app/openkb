import { beforeEach, describe, expect, test, vi } from 'vitest'
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap'
import { productionImpl } from './harness'
import { editorSchema } from '../../server/utils/editor-schema'
import { splitTitleHeading } from '../../server/utils/title-heading'

vi.mock('../../server/utils/drupal', () => ({
  fetchCeWorkingCopy: vi.fn(),
  commitKbPageWithAuth: vi.fn(),
}))
const { fetchCeWorkingCopy, commitKbPageWithAuth } = await import('../../server/utils/drupal')
const { commitDocument } = await import('../../server/utils/commit')

const TITLE = 'Title heading probe'
const HEADING = `# ${TITLE} {#b-tprobe}`
const MINTED_HEADING = new RegExp(`^# ${TITLE} \\{#b-[0-9a-f]{8}\\}$`)

const cases = [
  { what: 'a leading heading, byte-identical', body: `${HEADING}\n\nFirst paragraph. {#b-tpara1}\n`, stored: `${HEADING}\n\nFirst paragraph. {#b-tpara1}\n` },
  { what: 'no final newline', body: `${HEADING}\n\nFirst paragraph. {#b-tpara1}`, stored: `${HEADING}\n\nFirst paragraph. {#b-tpara1}\n` },
  { what: 'no heading at all: one is minted', body: 'First paragraph. {#b-tpara1}\n', stored: null },
  { what: 'blank lines under the heading', body: `${HEADING}\n\n\n\nFirst paragraph. {#b-tpara1}\n`, stored: `${HEADING}\n\nFirst paragraph. {#b-tpara1}\n` },
]

/** Saves `stored` through the editor and returns what the commit wrote. */
async function save(stored: string, changed: number): Promise<string> {
  const { titleHeading, body } = splitTitleHeading(stored)
  vi.mocked(fetchCeWorkingCopy).mockResolvedValue({
    page: { titleHeading, id: 'uuid-1', nid: 1, path: '/kb/x', title: TITLE, body, changed },
  } as never)
  vi.mocked(commitKbPageWithAuth).mockResolvedValue({ changed: changed + 1, review: null } as never)

  const doc = await productionImpl.load(body)
  const ydoc = prosemirrorJSONToYDoc(editorSchema, doc.toJSON() as never, 'default')
  ydoc.getMap('_meta').set('drupal_changed', changed)
  const result = await commitDocument({ documents: new Map([['node:1', ydoc]]) } as never, 'node:1', {
    trigger: 'manual', identity: { token: 'collab' },
  })
  expect(result.outcome).toBe('committed')
  return vi.mocked(commitKbPageWithAuth).mock.calls.at(-1)![2] as unknown as string
}

beforeEach(() => {
  vi.mocked(fetchCeWorkingCopy).mockReset()
  vi.mocked(commitKbPageWithAuth).mockReset()
})

/**
 * A stored body through the editor and back: split off the title heading, load
 * the rest the way the editor does, commit it the way a save does. Each seed
 * normalises once, then every later save writes the same bytes.
 */
describe('the title heading round-trips through the editor', () => {
  for (const { what, body, stored } of cases) {
    test(what, async () => {
      const first = await save(body, 100)
      if (stored === null) {
        const [heading, ...rest] = first.split('\n')
        expect(heading).toMatch(MINTED_HEADING)
        expect(rest.join('\n')).toBe('\nFirst paragraph. {#b-tpara1}\n')
      }
      else {
        expect(first).toBe(stored)
      }
      expect(await save(first, 200)).toBe(first)
    })
  }
})
