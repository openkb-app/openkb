import { describe, it, expect } from 'vitest'
import { announce } from './chat-answer'
import type { GroundingState } from './chat-answer'

function grounding(state: GroundingState, retrieved?: number) {
  return { mode: 'grounded', state, retrieved }
}

describe('announce', () => {
  it('says how many sources a grounded answer stands on', () => {
    expect(announce(grounding('grounded'), 2)).toBe('Answered from 2 sources.')
    expect(announce(grounding('grounded'), 1)).toBe('Answered from 1 source.')
  })

  it('names the state an answer without sources is in', () => {
    expect(announce(grounding('ungrounded', 2), 0)).toContain('not from your knowledge base')
    expect(announce(grounding('ungrounded', 0), 0)).toContain('nothing in the pages you can read matched')
    expect(announce(grounding('insufficient_evidence'), 0)).toContain('Nothing in the pages you can read')
    expect(announce(grounding('dependency_unavailable'), 0)).toContain('Search is unavailable')
  })

  it('says nothing about an answer nothing grounded', () => {
    expect(announce(null, 0)).toBe('')
  })
})
