import { describe, it, expect, vi, beforeEach } from 'vitest'
import handler from './token'
import { makeEvent, type FakeEvent } from '../../test-support/h3'

const passthrough = vi.fn()
vi.mock('../../utils/drupal-proxy', () => ({ drupalPassthrough: (...a: unknown[]) => passthrough(...a) }))

/** A request to the token route with `method`. */
function event(method: string): FakeEvent {
  return makeEvent({ cookie: 'SSESSabc=1' }, { method, path: '/session/token' })
}

describe('/session/token', () => {
  beforeEach(() => {
    passthrough.mockReset().mockResolvedValue('the-token')
  })

  it.each(['GET', 'HEAD'])('relays %s to Drupal', async (method) => {
    const e = event(method)
    await expect(handler(e)).resolves.toBe('the-token')
    expect(passthrough).toHaveBeenCalledWith(e, 'session/token')
  })

  it.each(['POST', 'OPTIONS', 'PUT', 'DELETE'])('answers %s with 405 and Allow', (method) => {
    const e = event(method)
    expect(() => handler(e)).toThrow(expect.objectContaining({ statusCode: 405 }))
    expect(e.sent.Allow).toBe('GET, HEAD')
    expect(passthrough).not.toHaveBeenCalled()
  })
})
