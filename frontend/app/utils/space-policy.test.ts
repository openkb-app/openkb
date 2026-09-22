import { describe, expect, it } from 'vitest'
import { AGENT_REVIEW_FLAG, MODERATION_FLAG, READ_ACCESS_OPTIONS } from './space-policy'

describe('space policy texts', () => {
  it('names the two audiences for read access', () => {
    expect(READ_ACCESS_OPTIONS.map(option => option.value)).toEqual(['members_only', 'all_users'])
  })

  it('names the on-state of each publishing flag and explains both states', () => {
    expect(MODERATION_FLAG.label).toBe('Review before publishing')
    expect(AGENT_REVIEW_FLAG.label).toBe('Agent edits need a human sign-off')
    for (const flag of [MODERATION_FLAG, AGENT_REVIEW_FLAG]) {
      expect(flag.hint.on.length, flag.label).toBeGreaterThan(0)
      expect(flag.hint.off.length, flag.label).toBeGreaterThan(0)
      expect(flag.hint.on).not.toBe(flag.hint.off)
    }
  })

  it('gives every read-access option a label and a hint', () => {
    for (const option of READ_ACCESS_OPTIONS) {
      expect(option.label.length, String(option.value)).toBeGreaterThan(0)
      expect(option.hint.length, String(option.value)).toBeGreaterThan(0)
    }
  })
})
