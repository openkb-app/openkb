import { describe, it, expect } from 'vitest'
import { AGENT_REVIEW_OPTIONS, MODERATION_OPTIONS, READ_ACCESS_OPTIONS } from './space-policy'

/**
 * The choices the create dialog and the settings card both render. What is
 * pinned is the contract the dialog relies on: every group offers exactly the
 * values the write path can send, each with a label, an icon and a hint.
 */

describe('the space policy choices', () => {
  it('offers both agent-review values, the sign-off one first', () => {
    expect(AGENT_REVIEW_OPTIONS.map(option => option.value)).toEqual([true, false])
    expect(AGENT_REVIEW_OPTIONS[0]!.label).toBe('Agent edits need a human sign-off')
    expect(AGENT_REVIEW_OPTIONS[1]!.label).toBe('Agent edits publish like human edits')
  })

  it('gives every choice in every group a label, an icon and a hint', () => {
    for (const group of [READ_ACCESS_OPTIONS, MODERATION_OPTIONS, AGENT_REVIEW_OPTIONS]) {
      for (const option of group) {
        expect(option.label).toBeTruthy()
        expect(option.icon).toMatch(/^i-/)
        expect(option.hint).toBeTruthy()
      }
    }
  })
})
