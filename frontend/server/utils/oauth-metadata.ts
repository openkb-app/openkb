import type { H3Event } from 'h3'
import { getRequestURL } from 'h3'
import {
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  type OAuthMetadata,
  type OAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { drupalBaseUrl } from './drupal'
import { fetchUpstream } from './upstream'

/**
 * The two discovery documents that turn a pasted `/api/mcp` URL into a login.
 *
 * The topology they describe is split, and that is the whole reason they are
 * written here rather than taken from the SDK's `mcpAuthMetadataRouter`: the
 * protected resource, the browser leg and registration are this Nitro app,
 * while the token endpoint and the signing keys are stock simple_oauth on the
 * Drupal origin. The SDK's router derives every endpoint from one base URL, so
 * it cannot express that; it is also an Express router that refuses any
 * non-HTTPS issuer outside literal `localhost`, which every http dev and
 * review-app host is.
 *
 * What the SDK is still used for is the part that matters — its Zod schemas
 * validate both documents before they go out, so a shape error is a failing
 * test rather than a client that silently gives up.
 *
 * The issuer is **this app's own origin**, taken from the request: whichever
 * host a client reached us on is the host its follow-up discovery request will
 * go to, which is what RFC 8414 requires of an issuer. Behind the review-app
 * proxy that is the public host, not the container's.
 */

/** RFC 8414 §3 — where the AS metadata for an issuer lives. */
export const AS_METADATA_PATH = '/.well-known/oauth-authorization-server'

/** The MCP endpoint this app protects. */
export const MCP_RESOURCE_PATH = '/api/mcp'

/** RFC 9728 §3.1 — the PRM URL for a resource, path-suffixed. */
export const PRM_PATH = `/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}`

/** Where a client registers itself — the pass-through, not Drupal. */
export const REGISTRATION_PATH = '/register'

/**
 * Where the browser leg starts — this app, not Drupal.
 *
 * The path is Drupal's own `/oauth/authorize`, served here as any other page
 * is: the custom-elements page fetch carries the request to stock simple_oauth
 * and brings back either its consent form or the redirect the protocol
 * produced. Pointing clients here is what keeps a person inside openKB for the
 * one step of the flow they actually see.
 */
export const AUTHORIZE_PATH = '/oauth/authorize'

/** Where Drupal states what a registration may ask for. */
const SCOPES_PATH = '/openkb/agent/registration/metadata'

/** How long an answer from Drupal is reused before asking again. */
const SCOPES_TTL_MS = 60_000

/** Both discovery documents wait on this one request — it may not hang. */
const SCOPES_TIMEOUT_MS = 2_000

let cachedScopes: { value: string[], until: number } | undefined

/**
 * The scopes to advertise, by wire name — Drupal's ceiling, not a constant.
 *
 * Which scopes a self-registering client may ask for is site config, and a
 * client reads this list to decide what to request; a copy of it here would
 * drift the moment the ceiling is narrowed and make every registration fail on
 * a scope the site no longer grants.
 *
 * Cached briefly, because both documents are unauthenticated and a client
 * fetches them back to back. When Drupal cannot be asked — it is down, it does
 * not answer inside the timeout, or the registration module is not installed
 * and the route 404s — the field is left out rather than guessed: it is
 * optional in RFC 8414 and RFC 9728, and a wrong list is worse than no list.
 * The timeout is what keeps a hung Drupal from hanging discovery itself: both
 * documents wait on this request.
 */
export async function scopesSupported(): Promise<string[]> {
  if (cachedScopes && cachedScopes.until > Date.now()) {
    return cachedScopes.value
  }
  let scopes: string[] = []
  try {
    const res = await fetchUpstream(`${drupalBaseUrl()}${SCOPES_PATH}`, {
      signal: AbortSignal.timeout(SCOPES_TIMEOUT_MS),
    })
    const body = res.ok ? await res.json() as { scopes_supported?: unknown } : {}
    if (Array.isArray(body.scopes_supported)) {
      scopes = body.scopes_supported.filter((scope): scope is string => typeof scope === 'string')
    }
  }
  catch {
    console.error('[oauth-metadata] Drupal did not state its registration scopes')
  }
  cachedScopes = { value: scopes, until: Date.now() + SCOPES_TTL_MS }
  return scopes
}

/** This app's public origin, as the requesting client sees it. */
export function resourceOrigin(event: H3Event): string {
  const url = getRequestURL(event, { xForwardedHost: true, xForwardedProto: true })
  return url.origin
}

/** RFC 9728 protected-resource metadata for `/api/mcp`. */
export async function protectedResourceMetadata(event: H3Event): Promise<OAuthProtectedResourceMetadata> {
  const origin = resourceOrigin(event)
  const scopes = await scopesSupported()
  return OAuthProtectedResourceMetadataSchema.parse({
    resource: `${origin}${MCP_RESOURCE_PATH}`,
    authorization_servers: [origin],
    ...(scopes.length ? { scopes_supported: scopes } : {}),
    resource_name: 'OpenKnowledgebase',
    bearer_methods_supported: ['header'],
  })
}

/**
 * RFC 8414 authorization-server metadata.
 *
 * Issuer, registration and authorization are ours; the token endpoint and the
 * signing keys are absolute URLs on the Drupal origin, which owns them end to
 * end. Authorization is ours only in where it is *rendered* — every decision
 * behind it is still simple_oauth's, reached through `/ce-api`.
 * `token_endpoint_auth_method: none` and S256-only are not a preference —
 * registration issues public clients with no secret, so PKCE is the only proof
 * they have.
 */
export async function authorizationServerMetadata(event: H3Event): Promise<OAuthMetadata> {
  const origin = resourceOrigin(event)
  const drupal = drupalBaseUrl()
  const scopes = await scopesSupported()
  return OAuthMetadataSchema.parse({
    issuer: origin,
    authorization_endpoint: `${origin}${AUTHORIZE_PATH}`,
    token_endpoint: `${drupal}/oauth/token`,
    jwks_uri: `${drupal}/.well-known/jwks.json`,
    registration_endpoint: `${origin}${REGISTRATION_PATH}`,
    ...(scopes.length ? { scopes_supported: scopes } : {}),
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
  })
}

/**
 * The `WWW-Authenticate` value an unauthenticated `/api/mcp` answers with.
 *
 * The `resource_metadata` parameter is the entry point to everything above:
 * without it a client has a 401 and nowhere to go (RFC 9728 §5.1).
 */
export function wwwAuthenticate(event: H3Event): string {
  return `Bearer resource_metadata="${resourceOrigin(event)}${PRM_PATH}"`
}
