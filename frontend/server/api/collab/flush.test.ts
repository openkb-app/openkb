import { describe, it, expect, vi } from 'vitest'
import type { H3Event } from 'h3'
import handler from './flush.post'

const executeNow = vi.fn()
const hp = {
  documents: new Map([
    ['node:1', { name: 'node:1', isLoading: false }],
    ['node:2', { name: 'node:2', isLoading: false }],
  ]),
  debouncer: {
    isDebounced: (id: string) => id === 'onStoreDocument-node:1',
    executeNow,
  },
}

vi.mock('nitropack/runtime', () => ({
  useNitroApp: () => ({ hocuspocus: hp }),
}))

function eventWithRemote(remoteAddress: string | undefined): H3Event {
  return { node: { req: { socket: { remoteAddress } } } } as unknown as H3Event
}

describe('POST /api/collab/flush', () => {
  it('flushes only documents with a pending debounced store', async () => {
    await expect(handler(eventWithRemote('127.0.0.1'))).resolves.toEqual({ flushed: 1 })
    expect(executeNow).toHaveBeenCalledWith('onStoreDocument-node:1')
    expect(executeNow).toHaveBeenCalledTimes(1)
  })

  it('rejects non-loopback callers', async () => {
    await expect(handler(eventWithRemote('10.1.2.3'))).rejects.toMatchObject({ statusCode: 403 })
  })
})
