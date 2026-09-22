/**
 * The awareness `user` object and its render mapping for the editor's
 * collaborator strip: raw awareness states (the same ones feeding the peer
 * count and the carets) → a render-ready peer list. Pure functions — no
 * awareness wiring here.
 *
 * Shared, not client-side: the server publishes awareness too. An agent peer
 * joining a session (server/utils/agent-peer.ts) builds its `user` object from
 * the same shape and the same {@link collabColor}, so a bot in the strip is
 * indistinguishable in kind from a browser peer — only its `via` label sets it
 * apart.
 */

import { ownedLabel } from './attribution'

/** The `user` object a client publishes into its awareness state. */
export interface AwarenessUser {
  name?: string
  color?: string
  /** Drupal uid of the account behind the peer — what {@link peerProfilePath}
   *  points at. Absent for a peer that has not resolved an account. */
  uid?: number
  /** Agent sessions acting for a user (OKB-61) publish the acting label,
   *  e.g. `via: 'claude'` → rendered as "fago via claude". */
  via?: string
}

/**
 * The blocks a peer says it is working on (OKB-164).
 *
 * A signal, never a lock — no write-path behaviour depends on one. It rides
 * awareness rather than the document because it describes the peer, not the
 * page, and because it must vanish when the peer does.
 */
export interface BlockClaim {
  /** Block ids, as `{#b-…}` names them. */
  blocks: string[]
}

/** One entry of the provider's awareness `states` array. */
export interface AwarenessPeerState {
  clientId: number
  user?: AwarenessUser
  claim?: BlockClaim
  [key: string | number]: unknown
}

/** The state a server-side peer publishes: a `user`, plus what it is doing. */
export interface AgentPeerState {
  user: AwarenessUser
  claim?: BlockClaim
}

/** A connected peer as the presence strip renders it. */
export interface PresencePeer {
  clientId: number
  name: string
  color: string
  isSelf: boolean
  uid?: number
  via?: string
}

export const FALLBACK_NAME = 'Someone'
/** Awareness colour for a peer whose session published none. An identity
    colour, not a theme one — it names a person, so no brand token applies. */
export const FALLBACK_COLOR = '#94a3b8'

/**
 * Stable per-user awareness color, derived from the Drupal uid via the
 * golden-angle hue walk — adjacent uids land far apart on the wheel. This is
 * the single color source for carets, per-field indicators and the presence
 * strip alike (published once into the awareness `user` object).
 */
export function collabColor(uid: number): string {
  const hue = Math.round((uid * 137.508) % 360)
  return `hsl(${hue} 65% 45%)`
}

/** The two notations awareness carries, as 0-1 sRGB channels. */
function srgbOf(color: string): [number, number, number] {
  const hsl = /^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/.exec(color)
  if (hsl) {
    const [h, s, l] = [Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100]
    const c = (1 - Math.abs(2 * l - 1)) * s
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
    const m = l - c / 2
    const wheel: [number, number, number][] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]]
    const [r, g, b] = wheel[Math.floor(h / 60) % 6]!
    return [r + m, g + m, b + m]
  }
  const hex = color.replace('#', '')
  const full = hex.length === 3 ? [...hex].map(digit => digit + digit).join('') : hex
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number]
}

/** WCAG relative luminance of a colour. */
export function luminanceOf(color: string): number {
  const [r, g, b] = srgbOf(color).map(channel =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * Ink for a letter on an identity colour, in either scheme: black or white,
 * whichever the background is further from. Either alone fails half the wheel;
 * crossing over here keeps the worse of the two at 4.5:1.
 */
export function readableInkOn(color: string): string {
  return luminanceOf(color) > 0.179 ? '#000000' : '#ffffff'
}

/** Up-to-two-letter initials for an avatar: first letters of the first two words. */
export function initialsOf(name: string): string {
  const letters = name
    .split(/\s+/)
    .map(word => [...word][0])
    .filter((c): c is string => !!c && /\p{L}|\p{N}/u.test(c))
  return letters.slice(0, 2).join('').toUpperCase() || '?'
}

/**
 * How a peer is named wherever the strip cannot show a name: the avatar's
 * accessible name and its tooltip.
 */
export function peerLabel(peer: PresencePeer, viewerUid?: number | null): string {
  const name = ownedLabel(peer, viewerUid)
  return peer.isSelf ? `${name} (you)` : name
}

/**
 * Where a peer's avatar leads: Drupal's profile for the account behind it.
 *
 * Only a person has one. An agent peer carries its owner's uid (it *is* that
 * account) but is not that person sitting there, so it stays label-only — as
 * does anyone whose session resolved no account.
 */
export function peerProfilePath(peer: PresencePeer): string | undefined {
  return peer.uid && !peer.via ? `/user/${peer.uid}` : undefined
}

/**
 * Awareness states → presence list. Every connected client is one peer (self
 * included, flagged and sorted first); order is otherwise stable by clientId
 * so avatars don't shuffle on unrelated awareness updates.
 */
export function presenceFromStates(
  states: AwarenessPeerState[],
  selfClientId: number | null,
): PresencePeer[] {
  return states
    .map((state) => {
      const user = state.user ?? {}
      return {
        clientId: state.clientId,
        name: user.name ?? FALLBACK_NAME,
        color: user.color ?? FALLBACK_COLOR,
        isSelf: state.clientId === selfClientId,
        ...(user.uid ? { uid: user.uid } : {}),
        ...(user.via ? { via: user.via } : {}),
      }
    })
    .sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || a.clientId - b.clientId)
}

/**
 * Awareness states → block id → the peers claiming that block.
 *
 * The projection behind the editor's "working here" marks. Self is left out:
 * the local peer knows where its own cursor is, and a marker on the block one
 * is typing in is noise.
 */
export function claimsByBlock(
  states: AwarenessPeerState[],
  selfClientId: number | null,
): Record<string, PresencePeer[]> {
  const byBlock: Record<string, PresencePeer[]> = {}
  for (const peer of presenceFromStates(states, selfClientId)) {
    if (peer.isSelf) continue
    const claimed = states.find(state => state.clientId === peer.clientId)?.claim?.blocks ?? []
    for (const id of claimed) (byBlock[id] ??= []).push(peer)
  }
  return byBlock
}

/** How a block's claimants read on the marker — the non-color signal. */
export function claimLabel(peers: PresencePeer[], viewerUid?: number | null): string {
  const [first, ...rest] = peers
  if (!first) return ''
  const who = peerLabel(first, viewerUid)
  return rest.length > 0 ? `${who} +${rest.length} editing` : `${who} editing`
}
