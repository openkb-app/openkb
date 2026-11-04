import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineEventHandler, toWebHandler } from 'h3'
import { requireSidecarSecret, sidecarKey } from './sidecar-secret'

/** Calls a route guarded by the secret check with the given headers. */
async function callGuardedRoute(headers: Record<string, string>): Promise<number> {
  const app = createApp()
  app.use(defineEventHandler((event) => {
    requireSidecarSecret(event)
    return 'ok'
  }))
  return (await toWebHandler(app)(new Request('http://kb.example.test/api/comark/render', { method: 'POST', headers }))).status
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('requireSidecarSecret', () => {
  it('derives the key as Drupal does: hash_hmac(\'sha256\', \'comark-sidecar\', $secret)', () => {
    expect(sidecarKey('shared')).toBe('5b50daa7296e4a3dccb62727edcb288179e9ef8422c4a76e9f384eda0a0923f8')
  })

  it('passes the derived key', async () => {
    vi.stubEnv('OKB_COLLAB_CLIENT_SECRET', 'shared')
    expect(await callGuardedRoute({ 'x-comark-secret': sidecarKey('shared') })).toBe(200)
  })

  it('refuses a call without the key, with another, or with the secret itself', async () => {
    vi.stubEnv('OKB_COLLAB_CLIENT_SECRET', 'shared')
    expect(await callGuardedRoute({})).toBe(401)
    expect(await callGuardedRoute({ 'x-comark-secret': sidecarKey('sharex') })).toBe(401)
    expect(await callGuardedRoute({ 'x-comark-secret': 'shared' })).toBe(401)
  })

  it('refuses every call where no secret is set', async () => {
    vi.stubEnv('OKB_COLLAB_CLIENT_SECRET', '')
    expect(await callGuardedRoute({ 'x-comark-secret': '' })).toBe(503)
  })
})
