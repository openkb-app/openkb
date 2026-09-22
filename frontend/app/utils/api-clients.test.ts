import { describe, it, expect } from 'vitest'
import { clientDate, connectedCell, lastUsedCell } from './api-clients'

/**
 * A client that has never been used is the normal state of a freshly
 * provisioned one, and a table cell left blank reads as a rendering bug rather
 * than as a fact. Both dates are optional on the wire for the same reason:
 * they are facts about the consumer, not guarantees.
 */
describe('the client dates', () => {
  it('reads an instant as a short absolute date', () => {
    expect(clientDate('2026-08-21T14:00:00+00:00')).toMatch(/2026/)
  })

  it('says nothing about a date it does not have', () => {
    expect(clientDate(null)).toBeNull()
    expect(clientDate(undefined)).toBeNull()
    expect(clientDate('not a date')).toBeNull()
  })

  it('fills every cell, dateless clients included', () => {
    expect(lastUsedCell(null)).toBe('Never')
    expect(connectedCell(null)).toBe('Unknown')
    expect(lastUsedCell('2026-08-21T14:00:00+00:00')).toMatch(/2026/)
    expect(connectedCell('2026-08-21T14:00:00+00:00')).toMatch(/2026/)
  })
})
