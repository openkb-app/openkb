import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'
import {
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js'

/**
 * The two discovery documents and the 401 header that points at them — the
 * whole of what a client is handed before it has any credential.
 *
 * Validated against the MCP SDK's own Zod schemas as well as asserted field by
 * field: the schemas catch a shape a spec-compliant client would reject, the
 * assertions catch the split topology going wrong — the issuer or the browser
 * leg drifting onto the Drupal origin, or the token endpoint drifting onto
 * ours.
 */

const DRUPAL = 'http://drupal.example.test:8080'
const SCOPES_URL = `${DRUPAL}/openkb/agent/registration/metadata`
const fetchUpstream = vi.fn()

vi.mock('./drupal', () => ({ drupalBaseUrl: () => DRUPAL }))
vi.mock('./upstream', () => ({ fetchUpstream: (...a: unknown[]) => fetchUpstream(...a) }))

const HOST = 'kb.example.test:8091'

/** An event as h3's request helpers read one. */
function eventFor(path: string, headers: Record<string, string> = {}): H3Event {
  return {
    path,
    node: { req: { url: path, headers: { host: HOST, ...headers } }, res: {} },
  } as unknown as H3Event
}

/** What Drupal answers on the registration-metadata route. */
function statesScopes(scopes: string[]): Response {
  return { ok: true, status: 200, json: async () => ({ scopes_supported: scopes }) } as unknown as Response
}

async function metadata() {
  return await import('./oauth-metadata')
}

beforeEach(() => {
  // The scope list is cached in module scope; each case starts fresh.
  vi.resetModules()
  fetchUpstream.mockReset().mockResolvedValue(statesScopes(['agent:read', 'agent:write']))
})

describe('protected-resource metadata', () => {
  it('names this app as the resource and as its own authorization server', async () => {
    const { protectedResourceMetadata, PRM_PATH } = await metadata()
    const doc = await protectedResourceMetadata(eventFor(PRM_PATH))

    expect(OAuthProtectedResourceMetadataSchema.safeParse(doc).success).toBe(true)
    expect(doc.resource).toBe(`http://${HOST}/api/mcp`)
    // The issuer a client follows to step 3 — this app, not Drupal: the AS
    // metadata document lives here.
    expect(doc.authorization_servers).toEqual([`http://${HOST}`])
    expect(doc.scopes_supported).toEqual(['agent:read', 'agent:write'])
    expect(doc.bearer_methods_supported).toEqual(['header'])
  })

  it('follows the host the client actually reached, through a proxy', async () => {
    const { protectedResourceMetadata, PRM_PATH } = await metadata()
    const doc = await protectedResourceMetadata(eventFor(PRM_PATH, {
      'x-forwarded-host': 'kb.public.example',
      'x-forwarded-proto': 'https',
    }))
    // A document naming the container's own host would send the client's next
    // request somewhere it cannot reach.
    expect(doc.resource).toBe('https://kb.public.example/api/mcp')
    expect(doc.authorization_servers).toEqual(['https://kb.public.example'])
  })
})

describe('authorization-server metadata', () => {
  it('issues from here, keeps the browser leg here, and points token and keys at Drupal', async () => {
    const { authorizationServerMetadata, AS_METADATA_PATH } = await metadata()
    const doc = await authorizationServerMetadata(eventFor(AS_METADATA_PATH))

    expect(OAuthMetadataSchema.safeParse(doc).success).toBe(true)
    expect(doc.issuer).toBe(`http://${HOST}`)
    // The one step a person sees runs on this origin, in this app's theme.
    // Everything it decides is still simple_oauth's, reached through /ce-api.
    expect(doc.authorization_endpoint).toBe(`http://${HOST}/oauth/authorize`)
    expect(doc.token_endpoint).toBe(`${DRUPAL}/oauth/token`)
    expect(doc.jwks_uri).toBe(`${DRUPAL}/.well-known/jwks.json`)
    // Registration is ours — the pass-through, not a Drupal-facing URL.
    expect(doc.registration_endpoint).toBe(`http://${HOST}/register`)
  })

  it('sends the browser to the host the client reached, through a proxy', async () => {
    const { authorizationServerMetadata, AS_METADATA_PATH } = await metadata()
    const doc = await authorizationServerMetadata(eventFor(AS_METADATA_PATH, {
      'x-forwarded-host': 'kb.public.example',
      'x-forwarded-proto': 'https',
    }))
    // A person opening the container's own host reaches nothing at all.
    expect(doc.authorization_endpoint).toBe('https://kb.public.example/oauth/authorize')
  })

  it('offers only what a public client can do', async () => {
    const { authorizationServerMetadata, AS_METADATA_PATH } = await metadata()
    const doc = await authorizationServerMetadata(eventFor(AS_METADATA_PATH))

    expect(doc.grant_types_supported).toEqual(['authorization_code', 'refresh_token'])
    expect(doc.response_types_supported).toEqual(['code'])
    // Registration issues no secret, so PKCE is the client's only proof and
    // S256 the only method — plain would make the challenge worthless.
    expect(doc.token_endpoint_auth_methods_supported).toEqual(['none'])
    expect(doc.code_challenge_methods_supported).toEqual(['S256'])
  })
})

describe('the scopes advertised', () => {
  it('are the ones Drupal states, not a list kept here', async () => {
    fetchUpstream.mockResolvedValue(statesScopes(['agent:read']))
    const { authorizationServerMetadata, AS_METADATA_PATH } = await metadata()
    const doc = await authorizationServerMetadata(eventFor(AS_METADATA_PATH))

    // Bounded: both discovery documents wait on this one request, so a Drupal
    // that never answers may not hang discovery with it.
    expect(fetchUpstream).toHaveBeenCalledWith(SCOPES_URL, { signal: expect.any(AbortSignal) })
    // A site that narrowed its ceiling to read-only advertises read-only; a
    // constant here would have every registration refused on a scope the site
    // no longer grants.
    expect(doc.scopes_supported).toEqual(['agent:read'])
  })

  it.each([
    ['the route is not there', { ok: false, status: 404, json: async () => ({}) }],
    ['the answer is not a scope list', { ok: true, status: 200, json: async () => ({}) }],
  ])('are left out when %s', async (_case, response) => {
    fetchUpstream.mockResolvedValue(response as unknown as Response)
    const { authorizationServerMetadata, protectedResourceMetadata, AS_METADATA_PATH, PRM_PATH } = await metadata()

    // Optional in RFC 8414 and RFC 9728 both, and a guessed list is worse than
    // none: it would name scopes the site refuses.
    const as = await authorizationServerMetadata(eventFor(AS_METADATA_PATH))
    expect(as.scopes_supported).toBeUndefined()
    expect(OAuthMetadataSchema.safeParse(as).success).toBe(true)

    const prm = await protectedResourceMetadata(eventFor(PRM_PATH))
    expect(prm.scopes_supported).toBeUndefined()
    expect(OAuthProtectedResourceMetadataSchema.safeParse(prm).success).toBe(true)
  })

  it('survive Drupal being unreachable', async () => {
    fetchUpstream.mockRejectedValue(new Error('ECONNREFUSED'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { authorizationServerMetadata, AS_METADATA_PATH } = await metadata()
    const doc = await authorizationServerMetadata(eventFor(AS_METADATA_PATH))
    expect(doc.scopes_supported).toBeUndefined()
    expect(doc.issuer).toBe(`http://${HOST}`)
  })

  it('are asked for once for the pair of documents a client fetches', async () => {
    const { authorizationServerMetadata, protectedResourceMetadata, AS_METADATA_PATH, PRM_PATH } = await metadata()
    await protectedResourceMetadata(eventFor(PRM_PATH))
    await authorizationServerMetadata(eventFor(AS_METADATA_PATH))
    expect(fetchUpstream).toHaveBeenCalledTimes(1)
  })
})

describe('the 401 challenge', () => {
  it('points at this resource\'s own metadata document', async () => {
    const { wwwAuthenticate } = await metadata()
    expect(wwwAuthenticate(eventFor('/api/mcp'))).toBe(
      `Bearer resource_metadata="http://${HOST}/.well-known/oauth-protected-resource/api/mcp"`,
    )
  })

  it('quotes the path-suffixed URL RFC 9728 defines, not the bare one', async () => {
    const { PRM_PATH, MCP_RESOURCE_PATH } = await metadata()
    expect(PRM_PATH).toBe(`/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}`)
  })
})

describe('the routes serving them', () => {
  it('serve the documents, open to any origin', async () => {
    const prm = await import('../routes/.well-known/oauth-protected-resource/api/mcp.get')
    const as = await import('../routes/.well-known/oauth-authorization-server.get')
    const { PRM_PATH, AS_METADATA_PATH } = await metadata()

    for (const [handler, path] of [[prm.default, PRM_PATH], [as.default, AS_METADATA_PATH]] as const) {
      const event = eventFor(path)
      const headers: Record<string, string> = {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(event.node.res as any).setHeader = (name: string, value: string) => { headers[name] = value }
      const doc = await handler(event)
      expect(doc).toBeTruthy()
      // Discovery precedes any credential, and an MCP client may be a browser.
      expect(headers['access-control-allow-origin']).toBe('*')
    }
  })
})
