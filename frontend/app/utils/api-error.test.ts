import { describe, it, expect } from 'vitest'
import { serverMessage } from './api-error'

describe('serverMessage', () => {
  // What the commit route answers a Save refused over a block still under
  // review: the readable sentence is per field, and h3 nests createError's
  // `data` under a `data` key of the body $fetch hands over.
  it('reads the per-field message out of a 422', () => {
    const err = {
      statusMessage: 'Request failed (422)',
      data: {
        statusMessage: 'Request failed (422)',
        data: { fields: { field_kb_body: ['Block b-1 is waiting for: agent.'] } },
      },
    }
    expect(serverMessage(err)).toBe('Block b-1 is waiting for: agent.')
  })

  it('names the first message where several blocks hold the save', () => {
    const err = {
      data: { data: { fields: { field_kb_body: ['Block b-1 is waiting for: agent.', 'Block b-2 is waiting for: peer.'] } } },
    }
    expect(serverMessage(err)).toBe('Block b-1 is waiting for: agent.')
  })

  it('falls back to the statusMessage where the refusal names no field', () => {
    expect(serverMessage({ data: { statusMessage: 'Block b-1 needs a second pair of eyes.' } }))
      .toBe('Block b-1 needs a second pair of eyes.')
  })

  it('reads a statusMessage the error carries at the top level', () => {
    expect(serverMessage({ statusMessage: 'Editor content is not loaded yet — nothing to save.' }))
      .toBe('Editor content is not loaded yet — nothing to save.')
  })

  // A transport failure carries no server message; the caller words that one.
  it('is null where the server said nothing', () => {
    expect(serverMessage(new Error('Failed to fetch'))).toBeNull()
    expect(serverMessage(undefined)).toBeNull()
  })
})
