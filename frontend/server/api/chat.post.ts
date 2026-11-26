import { createError, defineEventHandler, sendStream, setHeader } from 'h3'
import { useRuntimeConfig } from '#imports'
import { drupalBaseUrl } from '../utils/drupal'
import { forwardedAuthHeaders } from '../utils/actor'
import { fetchUpstream, upstreamError, UPSTREAM_UNAVAILABLE } from '../utils/upstream'
import { readCappedBody } from '../utils/capped-body'

// Proxy the AI-SDK UI-message stream through Drupal's vercel_ai_sdk module.
// The Drupal endpoint is the source of truth — no Nuxt-side mock fallback.
// Forwards the caller's one carrier so per-user access checks apply: a Bearer
// token, else the session cookie with the CSRF token the browser sent (ADR 0019).
// An upstream 401, or a 403 for a caller with no carrier, surfaces as 401 so
// the chat drawer renders its "log in to chat" state. A 403 for a caller with
// a carrier (missing/stale CSRF token, no chat permission) stays a 403. Every
// other failure maps like any other
// upstream call (server/utils/upstream.ts): a 400 for a turn the bridge
// refused stays a 400, which the drawer words apart from an outage.

/** Room for a long chat history; Drupal's input length guardrail sets the real limit. */
export const MAX_BODY_BYTES = 64 * 1024

export default defineEventHandler(async (event) => {
  const body = parseObject(await readCappedBody(event, MAX_BODY_BYTES))

  const agentId
    = (typeof body.agentId === 'string' && body.agentId !== '' ? body.agentId : null)
      ?? (useRuntimeConfig(event).public.chatAgentId as string | undefined)
      ?? 'openkb_chat'

  const auth = forwardedAuthHeaders(event)
  const res = await fetchUpstream(`${drupalBaseUrl()}/vercel-ai/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...auth,
    },
    body: JSON.stringify({ ...body, agentId }),
  })

  if (res.status === 401 || (res.status === 403 && !Object.keys(auth).length)) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Authentication required',
      data: { error: 'Authentication required' },
    })
  }

  if (!res.ok) throw await upstreamError(res, 'vercel_ai_sdk chat')
  if (!res.body) {
    console.error('[upstream] vercel_ai_sdk chat answered without a body')
    throw createError({ statusCode: 503, statusMessage: UPSTREAM_UNAVAILABLE })
  }

  // Mirror SSE headers so the AI SDK transport recognises the stream.
  setHeader(event, 'content-type', 'text/event-stream')
  setHeader(event, 'cache-control', 'no-cache')
  setHeader(event, 'connection', 'keep-alive')
  setHeader(event, 'x-vercel-ai-ui-message-stream', 'v1')
  setHeader(event, 'x-accel-buffering', 'no')

  return sendStream(event, res.body)
})

function parseObject(raw: Buffer): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw.toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  }
  catch {
    return {}
  }
}
