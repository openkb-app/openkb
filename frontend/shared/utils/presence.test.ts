import { describe, expect, it } from 'vitest'
import {
  FALLBACK_COLOR,
  claimLabel,
  claimsByBlock,
  collabColor,
  initialsOf,
  luminanceOf,
  peerLabel,
  peerProfilePath,
  presenceFromStates,
  readableInkOn,
} from './presence'

describe('initialsOf', () => {
  it('takes the first letters of the first two words', () => {
    expect(initialsOf('Wolfgang Ziegler')).toBe('WZ')
    expect(initialsOf('admin')).toBe('A')
    expect(initialsOf('Anna Maria Muster')).toBe('AM')
  })

  it('skips punctuation-only words and survives empty input', () => {
    expect(initialsOf('- fago')).toBe('F')
    expect(initialsOf('')).toBe('?')
    expect(initialsOf('   ')).toBe('?')
  })
})

describe('collabColor', () => {
  it('is stable per uid and distinct for adjacent uids', () => {
    expect(collabColor(1)).toBe(collabColor(1))
    expect(collabColor(1)).not.toBe(collabColor(2))
    expect(collabColor(1)).toMatch(/^hsl\(\d+ 65% 45%\)$/)
  })
})

describe('readableInkOn', () => {
  // Reuses luminanceOf; the four absolute values below are the check on it.
  const contrast = (a: string, b: string) => {
    const [light, dark] = [luminanceOf(a), luminanceOf(b)].sort((x, y) => y - x) as [number, number]
    return (light + 0.05) / (dark + 0.05)
  }

  it('reads the two notations awareness carries', () => {
    expect(luminanceOf('#000000')).toBe(0)
    expect(luminanceOf('#ffffff')).toBe(1)
    expect(luminanceOf('hsl(60 65% 45%)')).toBeCloseTo(0.4756, 4)
    expect(luminanceOf(FALLBACK_COLOR)).toBeCloseTo(0.3595, 4)
  })

  it('turns with the background, not with the colour scheme', () => {
    expect(readableInkOn('hsl(60 65% 45%)')).toBe('#000000')
    expect(readableInkOn('hsl(240 65% 45%)')).toBe('#ffffff')
  })

  it('clears 4.5:1 on every colour an avatar can be painted', () => {
    const wheel = new Set<string>()
    for (let uid = 0; uid < 1000; uid++) {
      const background = collabColor(uid)
      wheel.add(background)
      expect(contrast(readableInkOn(background), background)).toBeGreaterThanOrEqual(4.5)
    }
    // The whole wheel, not a sample of it.
    expect(wheel.size).toBeGreaterThanOrEqual(360)
    expect(contrast(readableInkOn(FALLBACK_COLOR), FALLBACK_COLOR)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('peerLabel', () => {
  const peer = { clientId: 1, name: 'Wolfgang Ziegler', color: '#abc', isSelf: false }

  it('names a human by their account name', () => {
    expect(peerLabel(peer)).toBe('Wolfgang Ziegler')
  })

  it('names an agent peer by its full attribution', () => {
    expect(peerLabel({ ...peer, name: 'editor1', via: 'Claude Code' }))
      .toBe('editor1 via Claude Code')
  })

  it('marks the local peer', () => {
    expect(peerLabel({ ...peer, isSelf: true })).toBe('Wolfgang Ziegler (you)')
    expect(peerLabel({ ...peer, name: 'editor1', via: 'Claude Code', isSelf: true }))
      .toBe('editor1 via Claude Code (you)')
  })
})

describe('peerProfilePath', () => {
  const peer = { clientId: 1, name: 'Wolfgang Ziegler', color: '#abc', isSelf: false, uid: 3 }

  it('points a person at their Drupal profile', () => {
    expect(peerProfilePath(peer)).toBe('/user/3')
    expect(peerProfilePath({ ...peer, isSelf: true })).toBe('/user/3')
  })

  it('gives an agent peer no profile, though it carries its owner uid', () => {
    expect(peerProfilePath({ ...peer, via: 'Claude' })).toBeUndefined()
  })

  it('gives a peer with no account none either', () => {
    expect(peerProfilePath({ ...peer, uid: undefined })).toBeUndefined()
    expect(peerProfilePath({ ...peer, uid: 0 })).toBeUndefined()
  })
})

describe('presenceFromStates', () => {
  it('maps states to peers, self first, rest ordered by clientId', () => {
    const peers = presenceFromStates([
      { clientId: 7, user: { name: 'Bea', color: '#abc' } },
      { clientId: 3, user: { name: 'Me', color: '#def' } },
      { clientId: 5, user: { name: 'Alf', color: '#123' } },
    ], 3)
    expect(peers.map(p => p.clientId)).toEqual([3, 5, 7])
    expect(peers[0]).toMatchObject({ name: 'Me', isSelf: true })
    expect(peers[1]).toMatchObject({ name: 'Alf', isSelf: false })
  })

  it('falls back for peers that have not published a user object yet', () => {
    const [peer] = presenceFromStates([{ clientId: 1 }], null)
    expect(peer).toMatchObject({ name: 'Someone', color: '#94a3b8', isSelf: false })
    expect(peer!.uid).toBeUndefined()
    expect(peer!.via).toBeUndefined()
  })

  it('carries the account uid and the agent via label through', () => {
    const [peer] = presenceFromStates(
      [{ clientId: 2, user: { name: 'fago', uid: 7, via: 'Claude' } }],
      null,
    )
    expect(peer!.uid).toBe(7)
    expect(peer!.via).toBe('Claude')
  })
})

describe('claimsByBlock', () => {
  it('groups claiming peers by block, leaving self out', () => {
    const byBlock = claimsByBlock([
      { clientId: 2, user: { name: 'fago', via: 'Claude' }, claim: { blocks: ['b-1', 'b-2'] } },
      { clientId: 4, user: { name: 'ada' }, claim: { blocks: ['b-2'] } },
      // Self's own claim is not a marker anyone needs.
      { clientId: 3, user: { name: 'Me' }, claim: { blocks: ['b-1'] } },
      { clientId: 5, user: { name: 'Idle' } },
    ], 3)

    expect(Object.keys(byBlock).sort()).toEqual(['b-1', 'b-2'])
    expect(byBlock['b-1']!.map(p => p.name)).toEqual(['fago'])
    expect(byBlock['b-2']!.map(p => p.name)).toEqual(['fago', 'ada'])
  })

  it('labels a block with who is working, not with a colour', () => {
    const byBlock = claimsByBlock([
      { clientId: 2, user: { name: 'fago', uid: 7, via: 'Claude' }, claim: { blocks: ['b-1'] } },
      { clientId: 4, user: { name: 'ada' }, claim: { blocks: ['b-1'] } },
    ], null)

    expect(claimLabel(byBlock['b-1']!)).toBe('fago via Claude +1 editing')
    expect(claimLabel(byBlock['b-1']!.slice(0, 1))).toBe('fago via Claude editing')
    expect(claimLabel(byBlock['b-1']!.slice(0, 1), 7)).toBe('Claude editing')
    expect(claimLabel([])).toBe('')
  })
})
