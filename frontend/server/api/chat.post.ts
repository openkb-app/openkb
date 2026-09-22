import { createError, defineEventHandler, getHeader, readBody, sendStream, setHeader } from 'h3'
import { useRuntimeConfig } from '#imports'
import { drupalBaseUrl } from '../utils/drupal'

// Proxy the AI-SDK UI-message stream through Drupal's vercel_ai_sdk module.
// The Drupal endpoint is the source of truth — no Nuxt-side mock fallback.
// Forwards the session cookie so per-user access checks apply.
// 401/403 from upstream surface as 401 here so the chat drawer can render a
// friendly "log in to chat" state.

export default defineEventHandler(async (event) => {
  const body = (await readBody(event).catch(() => ({}))) as Record<string, unknown>
  const cookie = getHeader(event, 'cookie')

  const upstream = `${drupalBaseUrl()}/vercel-ai/chat`

  const agentId
    = (typeof body.agentId === 'string' && body.agentId !== '' ? body.agentId : null)
      ?? (useRuntimeConfig(event).public.chatAgentId as string | undefined)
      ?? 'openkb'

  let res: Response
  try {
    res = await fetch(upstream, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify({ ...body, agentId }),
    })
  }
  catch (err) {
    throw createError({
      statusCode: 502,
      statusMessage: `vercel_ai_sdk unreachable at ${upstream}: ${(err as Error).message}. Enable the module: docker compose exec cli drush en vercel_ai_sdk -y`,
    })
  }

  if (res.status === 401 || res.status === 403) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Authentication required',
      data: { error: 'Authentication required' },
    })
  }

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw createError({
      statusCode: res.status || 502,
      statusMessage: `vercel_ai_sdk responded ${res.status}: ${text.slice(0, 200)}`,
    })
  }

  // Mirror SSE headers so the AI SDK transport recognises the stream.
  setHeader(event, 'content-type', 'text/event-stream')
  setHeader(event, 'cache-control', 'no-cache')
  setHeader(event, 'connection', 'keep-alive')
  setHeader(event, 'x-vercel-ai-ui-message-stream', 'v1')
  setHeader(event, 'x-accel-buffering', 'no')

  return sendStream(event, res.body)
})
