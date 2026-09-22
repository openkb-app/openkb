import { describe, it, expect } from 'vitest'
import { joinAccessUrl, parseJoinAnswer } from './collab-join'

describe('joinAccessUrl', () => {
  it('points at the join gate for one node', () => {
    expect(joinAccessUrl('https://cms.example.com/', 12))
      .toBe('https://cms.example.com/openkb/node/12/join-access')
  })
})

describe('parseJoinAnswer', () => {
  it('reads update access, the denied fields and the account', () => {
    expect(parseJoinAnswer({
      account: { uid: 7, name: 'editor1' },
      update: true,
      denied_fields: ['field_owner', 'title'],
    })).toEqual({
      update: true,
      denied: ['field_owner', 'title'],
      account: { uid: 7, name: 'editor1' },
    })
  })

  it('is empty — not null — when the account may edit every field', () => {
    expect(parseJoinAnswer({ account: { uid: 7, name: 'e' }, update: true, denied_fields: [] }).denied)
      .toEqual([])
  })

  it('names the anonymous account with uid 0, so the gate can tell it apart', () => {
    expect(parseJoinAnswer({ account: { uid: 0, name: '' }, update: false, denied_fields: [] }).account)
      .toEqual({ uid: 0, name: '' })
  })

  it('grants nothing on an answer it cannot read, so the gate refuses', () => {
    expect(parseJoinAnswer(null)).toEqual({ update: false, denied: null, account: null })
    expect(parseJoinAnswer({})).toEqual({ update: false, denied: null, account: null })
    expect(parseJoinAnswer({ update: true }).denied).toBeNull()
    expect(parseJoinAnswer({ update: 'yes', denied_fields: [] }).update).toBe(false)
    expect(parseJoinAnswer({ update: true, denied_fields: 'none' }).denied).toBeNull()
  })
})
