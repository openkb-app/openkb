import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** The uids each lookup asked for. */
let lookups: number[][] = []
/** Whether the next lookup fails. */
let failNext = false

/** A fresh copy of the shared name map. */
async function names() {
  vi.resetModules()
  return await import('./useAccountNames')
}

/** Lets the batched lookups run. */
async function settled(): Promise<void> {
  for (let round = 0; round < 5; round++) await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
  lookups = []
  failNext = false
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const uids = new URL(url, 'http://localhost').searchParams.get('uid')!.split(',').map(Number)
    lookups.push(uids)
    if (failNext) {
      failNext = false
      return new Response('', { status: 503 })
    }
    const users = uids.filter(uid => uid !== 13).map(uid => ({ uid, name: `user-${uid}` }))
    return new Response(JSON.stringify({ users }))
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('account names', () => {
  it('asks for more uids than one lookup answers in several lookups', async () => {
    const { requestAccountName, accountName } = await names()
    for (let uid = 1; uid <= 60; uid++) requestAccountName(uid)
    await settled()

    expect(lookups.map(uids => uids.length)).toEqual([50, 10])
    expect(accountName(60)).toBe('user-60')
  })

  it('tells an account the lookup does not know from one still asked for', async () => {
    const { requestAccountName, accountUnknown } = await names()
    requestAccountName(13)
    expect(accountUnknown(13)).toBe(false)
    await settled()

    expect(accountUnknown(13)).toBe(true)
    expect(accountUnknown(0)).toBe(true)
    expect(accountUnknown(2 ** 31)).toBe(true)
  })

  it('asks again after a failed lookup', async () => {
    const { requestAccountName, accountName, accountUnknown } = await names()
    failNext = true
    requestAccountName(5)
    await settled()
    expect(accountUnknown(5)).toBe(false)

    requestAccountName(5)
    await settled()
    expect(lookups).toEqual([[5], [5]])
    expect(accountName(5)).toBe('user-5')
  })
})
