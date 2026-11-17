import type { CommentAssignee, CommentThread } from '#shared/block-comments'
import type { PresencePeer } from '#shared/utils/presence'
import { actorLabel, ownedLabel } from '#shared/utils/attribution'
import { CHAT_AGENT_LABEL } from '#shared/utils/chat-agent'

/**
 * Who a comment thread can be handed to, and which threads are mine.
 *
 * Pure over its inputs, so the picker's order, the mention parsing and the
 * "is this mine" test are pinned without a browser.
 */

/** One entry of the picker. */
export interface AssigneeCandidate extends CommentAssignee {
  /** Awareness colour when the candidate is in the room; absent otherwise. */
  color?: string
  /** Whether they have the page open right now — what the picker groups by. */
  present: boolean
}

/** One agent client of the reader's own, as Drupal's `openkb/me/agents` serves them. */
export interface OwnAgent {
  label: string
}

/** A person on the space's roster, as `/api/spaces/<slug>` serves them. */
export interface RosterMember {
  uid: number
  name: string
}

/** Whose move a thread is, read from this reader's side. */
export type ReaderStanding = 'me' | 'my-agent' | null

/**
 * Whether the thread is the reader's own move, one of their agents', or
 * neither. Both run through the reader's account, so the client label is what
 * tells them apart — and they are listed apart: work handed to an agent is work
 * the reader is not doing.
 */
export function readerStanding(
  assignee: CommentAssignee | null | undefined,
  me: CommentAssignee | null | undefined,
): ReaderStanding {
  if (!assignee || !me || assignee.uid == null || assignee.uid !== me.uid) return null
  return assignee.via ? 'my-agent' : 'me'
}

/**
 * Who can be assigned, in the order the picker offers them: the other people in
 * the session, then the space's other editors, then the agents in the session,
 * then the reader's own agents that are not here. A thread is usually handed
 * to somebody already looking at the page.
 *
 * The reader themself is left out — a thread is handed to somebody else — but
 * their own agents are not: work handed to an agent is work the reader is not
 * doing.
 *
 * An agent of the reader's own is assignable whether or not it is connected:
 * the thread waits, and the agent is answered it on its next connection
 * (`openkb_list_assignments`). It is addressed by `{uid, via}` — the reader's
 * account and the client's label — the same key it holds when it is here.
 */
export function assigneeCandidates(
  peers: readonly PresencePeer[],
  roster: readonly RosterMember[],
  own: { uid: number, name: string, agents: readonly OwnAgent[] } | null = null,
): AssigneeCandidate[] {
  const present: AssigneeCandidate[] = []
  const seen = new Set<string>()
  /** Whether `who` is the reader themself, not one of their agents. */
  const isReader = (who: CommentAssignee): boolean =>
    !who.via && own != null && who.uid === own.uid
  for (const peer of peers) {
    if (peer.uid == null || isReader({ uid: peer.uid, name: peer.name, via: peer.via ?? null })) continue
    // An account starts its own AI assistant only.
    if (peer.via === CHAT_AGENT_LABEL) continue
    const candidate: AssigneeCandidate = {
      uid: peer.uid,
      name: peer.name,
      via: peer.via ?? null,
      color: peer.color,
      present: true,
    }
    if (seen.has(assigneeKey(candidate))) continue
    seen.add(assigneeKey(candidate))
    present.push(candidate)
  }
  const absent = roster
    .map(member => ({ uid: member.uid, name: member.name, via: null, present: false }))
    .filter(member => !seen.has(assigneeKey(member)) && !isReader(member))
  const mine = (own?.agents ?? [])
    .map(agent => ({ uid: own!.uid, name: own!.name, via: agent.label, present: false }))
    .filter((agent) => {
      if (seen.has(assigneeKey(agent))) return false
      seen.add(assigneeKey(agent))
      return true
    })
  return [
    ...present.filter(candidate => !candidate.via),
    ...absent,
    ...present.filter(candidate => candidate.via),
    ...mine,
  ]
}

/** A string naming one person or one agent of an account; empty for nobody. */
export function assigneeKey(who: { uid?: number | null, via?: string | null } | null | undefined): string {
  return who ? `${who.uid}|${who.via ?? ''}` : ''
}

/** Whether two assignees are the same person or the same agent of an account. */
export function isSameAssignee(
  one: CommentAssignee | null | undefined,
  other: CommentAssignee | null | undefined,
): boolean {
  return assigneeKey(one) === assigneeKey(other)
}

/**
 * The agents of the reader's own a thread can be handed to: the connected
 * clients, and the AI assistant for an account that can chat.
 */
export function assignableOwnAgents(agents: readonly OwnAgent[], canChat: boolean): OwnAgent[] {
  return canChat ? [...agents, { label: CHAT_AGENT_LABEL }] : [...agents]
}

/**
 * Who the next new comment starts assigned to: the choice of the reader's last
 * new comment, while that assignee is still on offer; else the reader's
 * assistant while the chat is open; else nobody.
 *
 * `last` is undefined before the reader's first new comment and null when it
 * went to nobody. `assistant` is null where the reader has none.
 */
export function defaultAssigneeForNextNewComment(
  last: CommentAssignee | null | undefined,
  candidates: readonly AssigneeCandidate[],
  assistant: CommentAssignee | null,
  chatOpen: boolean,
): CommentAssignee | null {
  if (last === null) return null
  if (last && candidates.some(candidate => isSameAssignee(candidate, last))) return last
  return chatOpen ? assistant : null
}

/**
 * How a mention names somebody in the draft — the wording this reader sees
 * everywhere else: a person by their account name, somebody else's agent by
 * its owner too, the reader's own by its bare label.
 */
export function mentionName(
  who: { uid?: number | null, name: string, via?: string | null },
  viewerUid?: number | null,
): string {
  return ownedLabel(who, viewerUid ?? null)
}

/**
 * Who an edit of a draft newly mentions — who the mention selects as the
 * assignee. Only a mention that overlaps the inserted text counts: a deletion,
 * or a candidate coming or going, selects nobody. Of several, the last wins.
 *
 * A character repeated at the edit point fits either side of it, so the
 * inserted span is read twice, prefix first and suffix first. A candidate
 * counts only if a mention of them overlaps both readings.
 */
export function addedMention(
  before: string,
  after: string,
  candidates: readonly AssigneeCandidate[],
  viewerUid?: number | null,
): AssigneeCandidate | null {
  const readings = [insertedSpan(before, after, false), insertedSpan(before, after, true)]
    .map(span => ({ span, keys: new Set<string>() }))
  if (readings.some(({ span }) => span.start === span.end)) {
    return null
  }
  const mentions: AssigneeCandidate[] = []
  let at = 0
  for (const { text, mention } of draftRuns(after, candidates, viewerUid)) {
    const runEnd = at + text.length
    if (mention) {
      const overlapping = readings.filter(({ span }) => at < span.end && span.start < runEnd)
      if (overlapping.length > 0) {
        mentions.push(mention)
      }
      for (const { keys } of overlapping) {
        keys.add(assigneeKey(mention))
      }
    }
    at = runEnd
  }
  let added: AssigneeCandidate | null = null
  for (const mention of mentions) {
    if (readings.every(({ keys }) => keys.has(assigneeKey(mention)))) {
      added = mention
    }
  }
  return added
}

/** The span of `after` an edit of `before` inserted; empty for a pure deletion. */
function insertedSpan(before: string, after: string, suffixFirst: boolean): { start: number, end: number } {
  const shorter = Math.min(before.length, after.length)
  if (suffixFirst) {
    const suffix = commonSuffixLength(before, after, shorter)
    const prefix = commonPrefixLength(before, after, shorter - suffix)
    return { start: prefix, end: after.length - suffix }
  }
  const prefix = commonPrefixLength(before, after, shorter)
  const suffix = commonSuffixLength(before, after, shorter - prefix)
  return { start: prefix, end: after.length - suffix }
}

/** How many leading UTF-16 units `one` and `other` share, at most `limit`. */
function commonPrefixLength(one: string, other: string, limit: number): number {
  let length = 0
  while (length < limit && one[length] === other[length]) {
    length++
  }
  return length
}

/** How many trailing UTF-16 units `one` and `other` share, at most `limit`. */
function commonSuffixLength(one: string, other: string, limit: number): number {
  let length = 0
  while (length < limit && one[one.length - 1 - length] === other[other.length - 1 - length]) {
    length++
  }
  return length
}

/** One run of a draft: plain words, or a whole mention of somebody. */
export interface DraftRun {
  text: string
  /** Who the run mentions; null on a run of plain words. */
  mention: AssigneeCandidate | null
}

/** One name a mention may be written under, and who it names. */
interface MentionForm {
  name: string
  candidate: AssigneeCandidate
}

/**
 * `text` split on the `@name`s in `forms`, each mention run named by `as`.
 * Longest name first, so `@editor10` is not read as a mention of `editor1`.
 */
function splitMentions(
  text: string,
  forms: readonly MentionForm[],
  as: (form: MentionForm) => string,
): DraftRun[] {
  const named = [...forms].sort((one, other) => other.name.length - one.name.length)
  const runs: DraftRun[] = []
  let plain = ''
  for (let at = 0; at < text.length;) {
    const hit = text[at] === '@'
      ? named.find(({ name }) => text.startsWith(`@${name}`, at)
        && !/[\p{L}\p{N}]/u.test(text[at + name.length + 1] ?? ''))
      : undefined
    if (!hit) {
      plain += text[at]
      at++
      continue
    }
    if (plain) runs.push({ text: plain, mention: null })
    plain = ''
    runs.push({ text: `@${as(hit)}`, mention: hit.candidate })
    at += hit.name.length + 1
  }
  if (plain) runs.push({ text: plain, mention: null })
  return runs
}

/**
 * A draft split into plain runs and the mentions in it, so the composer can set
 * a mention off from the words around it. A textarea cannot style part of its
 * value, so the runs are drawn behind it, word for word: each chip sits on the
 * word it is about.
 */
export function draftRuns(
  text: string,
  candidates: readonly AssigneeCandidate[],
  viewerUid?: number | null,
): DraftRun[] {
  // Agents first: a name the reader's own agent shares with a person names the
  // agent. Only its owner writes that form, and they wrote it about their agent.
  const ordered = [
    ...candidates.filter(candidate => candidate.via),
    ...candidates.filter(candidate => !candidate.via),
  ]
  const forms = ordered.map(candidate => ({ name: mentionName(candidate, viewerUid), candidate }))
  return splitMentions(text, forms, form => form.name)
}

/**
 * Every name a mention of somebody may stand under in stored text: a person by
 * their account name, an agent by its bare label (its owner's wording) or by
 * its owner too (everybody else's).
 */
function mentionForms(candidate: AssigneeCandidate): MentionForm[] {
  if (!candidate.via) return [{ name: candidate.name, candidate }]
  return [
    { name: candidate.via, candidate },
    { name: actorLabel(candidate.name, candidate.via), candidate },
  ]
}

/**
 * A stored message split the same way, with every mention named the way this
 * reader is shown that person or agent everywhere else. The text is kept as it
 * was typed, and the author's wording is not every reader's: an agent its owner
 * mentioned `@claude` reads `@editor1 via claude` to the rest, which is what
 * the chip beside it says.
 */
export function messageRuns(
  text: string,
  candidates: readonly AssigneeCandidate[],
  viewerUid?: number | null,
): DraftRun[] {
  const forms = candidates.flatMap(mentionForms)
  return splitMentions(text, forms, form => mentionName(form.candidate, viewerUid))
}

/**
 * The draft with the `@` at `at` turned into a mention of `name`
 * ({@link mentionName}). It is spaced off on both sides, so a mention always
 * stands on its own — which is what {@link addedMention} reads back.
 */
export function insertMention(text: string, at: number, name: string): string {
  const before = text.slice(0, at)
  const rest = text.slice(at + 1)
  const lead = before === '' || /\s$/.test(before) ? '' : ' '
  const trail = /^\s/.test(rest) ? '' : ' '
  return `${before}${lead}@${name}${trail}${rest}`
}

/** What the drawer's comment list can be narrowed to. */
export const THREAD_FILTERS = ['mine', 'agents', 'all'] as const
export type ThreadFilter = (typeof THREAD_FILTERS)[number]

/**
 * The threads one filter shows. "Mine" is the open threads handed to the reader
 * themself and "agents" those handed to one of their agents; a resolved thread
 * is nobody's move, however it is assigned.
 */
export function filterThreads<T extends CommentThread>(
  threads: readonly T[],
  filter: ThreadFilter,
  me: CommentAssignee | null,
): T[] {
  if (filter === 'all') return [...threads]
  const standing: ReaderStanding = filter === 'mine' ? 'me' : 'my-agent'
  return threads.filter(thread =>
    !thread.resolved && readerStanding(thread.assignee, me) === standing)
}

/** Open threads waiting on the reader, split by who is holding them. */
export interface AssignedCounts {
  /** Handed to the reader themself. */
  mine: number
  /** Handed to one of the reader's own agents. */
  myAgents: number
  /** Both together — the header badge's number. */
  total: number
}

/**
 * How much open work is on the reader's desk. An agent of theirs holding a
 * thread is still their page to answer for, so the badge counts it; the drawer
 * keeps the two apart, and so does the badge's accessible name.
 *
 * Counted off {@link filterThreads}, the drawer's own reading, so the badge and
 * the tabs can never disagree about what is there.
 */
export function assignedCounts(
  threads: readonly CommentThread[],
  me: CommentAssignee | null,
): AssignedCounts {
  const mine = filterThreads(threads, 'mine', me).length
  const myAgents = filterThreads(threads, 'agents', me).length
  return { mine, myAgents, total: mine + myAgents }
}
