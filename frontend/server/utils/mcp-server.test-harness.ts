import { vi } from 'vitest'
import type { H3Event } from 'h3'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap'
import type { StaleBlockError } from './agent-peer'

/**
 * The rig the MCP suites share: the mocked layers a tool call runs over, and a
 * real MCP client connected to the server over an in-memory transport — the
 * same tools/list + tools/call path the HTTP endpoint serves.
 *
 * It lives beside mcp-server.ts rather than under mcp-tools/, so no MCP type
 * reaches that directory, in test code either.
 *
 * A suite declares the mocks it needs with the exported factories, e.g.
 * `vi.mock('./kb-read', () => kbReadMock)`. Those factories run when the
 * mocked module is first imported, so this file reaches every mocked module
 * through `await import(...)` and a suite imports this file before any of
 * them — otherwise the factory would close over a binding not yet
 * initialised.
 */

export const getKbPage = vi.fn()
export const fetchFrontmatterSchema = vi.fn()
export const findKbPageByPath = vi.fn()
export const fetchFrontmatterSpecs = vi.fn()
export const listDrupalTools = vi.fn()
export const callDrupalTool = vi.fn()

/**
 * The write tools route through the session router; the router itself is
 * covered by session-router.test.ts. Keeping the error classes real is what
 * lets the tools' `instanceof` mapping be exercised for what it is.
 */
export const routeAgentEdit = vi.fn()

/** The session a watching tool joins; the router's own gate is tested there. */
export const joinAgentSession = vi.fn()

export const kbReadMock = { getKbPage: (...a: unknown[]) => getKbPage(...a) }
export const drupalMock = {
  fetchFrontmatterSchema: (...a: unknown[]) => fetchFrontmatterSchema(...a),
  findKbPageByPath: (...a: unknown[]) => findKbPageByPath(...a),
  fetchFrontmatterSpecs: (...a: unknown[]) => fetchFrontmatterSpecs(...a),
}
export const hocuspocusMock = { useAgentRouter: () => ({}) }

/**
 * The Drupal tools are relayed over MCP (drupal-tools.ts, covered there);
 * mocked so the wiring can be asserted with tools these suites have never
 * heard of, which is the property the relay exists for.
 */
export const drupalToolsMock = {
  listDrupalTools: (...a: unknown[]) => listDrupalTools(...a),
  callDrupalTool: (...a: unknown[]) => callDrupalTool(...a),
}

export async function sessionRouterMock(
  importOriginal: <T>() => Promise<T>,
): Promise<Record<string, unknown>> {
  const actual = await importOriginal<typeof import('./session-router')>()
  return {
    ...actual,
    routeAgentEdit: (...a: unknown[]) => routeAgentEdit(...a),
    joinAgentSession: (...a: unknown[]) => joinAgentSession(...a),
  }
}

export const EVENT = {
  context: {},
  node: {
    req: { headers: { authorization: 'Bearer agent-token' } },
    // waitForChanges gives up its wait when the client goes away.
    res: { on: () => {} },
  },
} as unknown as H3Event

export const SPECS = [
  { key: 'summary', name: 'field_summary', multiple: false, reference: false },
  { key: 'owner', name: 'field_owner', multiple: false, reference: true, entityType: 'user', bundles: [] },
]

export const APPLIED = {
  nid: 7,
  entry: 'started',
  observers: 0,
  applied: { fields: ['summary'], body: false, blocks: {} },
}

export const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      'x-field-name': 'field_summary',
      'x-widget': { type: 'string_textarea', settings: { rows: 3, placeholder: 'One-paragraph abstract.' } },
    },
    owner: {
      type: 'object',
      'x-field-name': 'field_owner',
      'x-widget': { type: 'entity_reference_autocomplete', settings: { match_limit: 10, size: 60 } },
    },
  },
  required: ['summary'],
  additionalProperties: false,
}

/** A page as the read layer projects it — one body, in the markdown. */
export const PAGE = {
  path: 'intro',
  title: 'Intro',
  frontmatter: { summary: 'An abstract.', owner: null },
  markdown: '---\nsummary: An abstract.\nowner: null\n---\n\n# Intro {#b-1}',
  versions: { 'b-1': '05b561c1ae22' },
}

export const STALE = 'c070666432ee'

/** A refusal the real CAS check produced, not a hand-written stand-in. */
export async function refusalFromTheCasCheck(): Promise<StaleBlockError> {
  const { refuseStaleBlocks } = await import('./agent-peer')
  const { editorSchema } = await import('./editor-schema')
  const doc = prosemirrorJSONToYDoc(editorSchema, {
    type: 'doc',
    content: [{ type: 'paragraph', attrs: { id: 'b-1' }, content: [{ type: 'text', text: 'first' }] }],
  } as never, 'default')
  try {
    refuseStaleBlocks(doc, [{ id: 'b-1', expect: STALE, markdown: 'agent rewrite' }])
  }
  catch (err) {
    return err as StaleBlockError
  }
  throw new Error('the CAS check accepted a stale version')
}

/** The state every suite starts a case from. */
export function resetMocks(): void {
  getKbPage.mockReset()
  fetchFrontmatterSchema.mockReset().mockResolvedValue(SCHEMA)
  findKbPageByPath.mockReset().mockResolvedValue({ id: 'n-1', nid: 7, path: 'intro' })
  fetchFrontmatterSpecs.mockReset().mockResolvedValue(SPECS)
  routeAgentEdit.mockReset().mockResolvedValue(APPLIED)
  joinAgentSession.mockReset()
  listDrupalTools.mockReset().mockResolvedValue([])
  callDrupalTool.mockReset().mockResolvedValue({ content: [{ type: 'text', text: 'relayed' }] })
}

/** A client and the server it drives, over the in-memory transport. */
export async function connect() {
  const { createMcpServer } = await import('./mcp-server')
  const server = await createMcpServer(EVENT)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(clientTransport)
  return { client, server }
}
