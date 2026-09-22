import { describe, expect, it } from 'vitest'
import {
  assigneeCandidates,
  assignedCounts,
  draftRuns,
  filterThreads,
  insertMention,
  mentionName,
  mentionedCandidate,
  messageRuns,
} from './comment-assignee'
import { actorLabel, ownedLabel } from '#shared/utils/attribution'
import type { CommentThread } from '#shared/block-comments'
import type { PresencePeer } from '#shared/utils/presence'

function peer(clientId: number, name: string, uid: number, via?: string): PresencePeer {
  return { clientId, name, uid, color: '#123456', isSelf: false, ...(via ? { via } : {}) }
}

function thread(threadId: string, over: Partial<CommentThread> = {}): CommentThread {
  return {
    blockId: 'b-1',
    threadId,
    anchor: null,
    messages: [],
    resolved: false,
    assignee: null,
    assignedTo: [],
    assignedBy: null,
    openedAt: 1,
    lastAt: 1,
    ...over,
  }
}

describe('who can be assigned', () => {
  it('offers the people in the page, then the space, then the agents', () => {
    const candidates = assigneeCandidates(
      [peer(1, 'Ada', 7), peer(2, 'Ada', 7, 'Claude')],
      [{ uid: 9, name: 'Bob' }],
    )
    expect(candidates.map(c => actorLabel(c.name, c.via))).toEqual(['Ada', 'Bob', 'Ada via Claude'])
    expect(candidates.map(c => c.present)).toEqual([true, false, true])
  })

  it('lists somebody once, however many of their sessions are in the page', () => {
    const candidates = assigneeCandidates(
      [peer(1, 'Ada', 7), peer(2, 'Ada', 7)],
      [{ uid: 7, name: 'Ada' }],
    )
    expect(candidates).toHaveLength(1)
  })

  it('leaves the reader out, in the page and on the roster, but not their agents', () => {
    const candidates = assigneeCandidates(
      [peer(1, 'Ada', 7), peer(2, 'Bob', 9), peer(3, 'Ada', 7, 'Claude')],
      [{ uid: 7, name: 'Ada' }, { uid: 5, name: 'Cleo' }],
      { uid: 7, name: 'Ada', agents: [{ label: 'Codex' }] },
    )

    expect(candidates.map(candidate => [candidate.name, candidate.via]))
      .toEqual([['Bob', null], ['Cleo', null], ['Ada', 'Claude'], ['Ada', 'Codex']])
  })
})

describe('mentioning somebody in a draft', () => {
  const candidates = assigneeCandidates([peer(1, 'Ada', 7), peer(2, 'Bob', 9)], [])
  const editors = assigneeCandidates(
    [peer(1, 'editor1', 7), peer(2, 'editor10', 9), peer(3, 'Adam', 5)],
    [],
  )

  it('replaces the typed @ with the name, and leaves room to keep typing', () => {
    expect(insertMention('ask @ about this', 4, 'Ada')).toBe('ask @Ada about this')
    expect(insertMention('ask @', 4, 'Ada')).toBe('ask @Ada ')
  })

  it('spaces the mention off the word before it, so it stays its own word', () => {
    expect(insertMention('cc@', 2, 'Ada')).toBe('cc @Ada ')
  })

  it('reads the last mention, which is the one just typed', () => {
    expect(mentionedCandidate('@Ada no, @Bob', candidates)?.name).toBe('Bob')
  })

  it('does not read a longer name as a shorter one it starts with', () => {
    expect(mentionedCandidate('@Adam', editors)?.name).toBe('Adam')
    expect(mentionedCandidate('@editor10', editors)?.name).toBe('editor10')
    expect(mentionedCandidate('@editor1 ', editors)?.name).toBe('editor1')
  })

  it('names somebody else\'s agent by its owner, and the reader\'s own by itself', () => {
    const agents = assigneeCandidates([peer(1, 'Ada', 7), peer(2, 'Ada', 7, 'Claude')], [])

    expect(agents.map(candidate => mentionName(candidate))).toEqual(['Ada', 'Ada via Claude'])
    expect(agents.map(candidate => mentionName(candidate, 7))).toEqual(['Ada', 'Claude'])
    expect(insertMention('ask @', 4, 'Claude')).toBe('ask @Claude ')
  })

  it('reads an agent mention as the agent, and the owner is not mentioned by it', () => {
    const agents = assigneeCandidates([peer(1, 'Ada', 7), peer(2, 'Ada', 7, 'Claude')], [])

    expect(mentionedCandidate('@Ada via Claude please check', agents)?.via).toBe('Claude')
    expect(mentionedCandidate('@Claude please check', agents, 7)?.via).toBe('Claude')
    expect(mentionedCandidate('@Ada please check', agents)?.via).toBe(null)
  })

  it('reads a name a person and my own agent share as my agent', () => {
    const both = assigneeCandidates(
      [peer(1, 'claude', 9)],
      [],
      { uid: 7, name: 'fago', agents: [{ label: 'claude' }] },
    )

    expect(mentionedCandidate('@claude please check', both, 7)?.via).toBe('claude')
  })

  it('finds nobody in a draft that mentions nobody', () => {
    expect(mentionedCandidate('needs a source', candidates)).toBeNull()
    expect(mentionedCandidate('@Nobody', candidates)).toBeNull()
  })
})

describe('narrowing the list', () => {
  const me = { uid: 7, name: 'Ada' }
  const threads = [
    thread('c-1'),
    thread('c-2', { assignee: { uid: 7, name: 'Ada' } }),
    thread('c-3', { assignee: { uid: 9, name: 'Bob' } }),
    thread('c-4', { resolved: true, assignee: { uid: 7, name: 'Ada' } }),
    thread('c-5', { assignee: { uid: 7, name: 'Ada', via: 'claude' } }),
    thread('c-6', { assignee: { uid: 9, name: 'Bob', via: 'claude' } }),
  ]

  it('keeps the threads handed to me apart from the ones handed to my agents', () => {
    expect(filterThreads(threads, 'mine', me).map(t => t.threadId)).toEqual(['c-2'])
    expect(assignedCounts(threads, me)).toEqual({ mine: 1, myAgents: 1, total: 2 })
  })

  it('counts nothing for a reader the session does not know', () => {
    expect(assignedCounts(threads, null)).toEqual({ mine: 0, myAgents: 0, total: 0 })
  })

  it('counts an agent\'s thread even where none is mine, so the badge still shows', () => {
    const agentsOnly = [thread('c-1'), thread('c-5', { assignee: { uid: 7, name: 'Ada', via: 'claude' } })]

    expect(assignedCounts(agentsOnly, me)).toEqual({ mine: 0, myAgents: 1, total: 1 })
  })

  it('leaves a resolved thread out, however it is assigned', () => {
    const settled = [
      thread('c-4', { resolved: true, assignee: { uid: 7, name: 'Ada' } }),
      thread('c-7', { resolved: true, assignee: { uid: 7, name: 'Ada', via: 'claude' } }),
    ]

    expect(assignedCounts(settled, me).total).toBe(0)
  })

  it('counts nobody else\'s agent as mine', () => {
    const theirs = [thread('c-6', { assignee: { uid: 9, name: 'Bob', via: 'claude' } })]

    expect(assignedCounts(theirs, me)).toEqual({ mine: 0, myAgents: 0, total: 0 })
  })

  it('lists what my own agents were handed, and nobody else\'s', () => {
    expect(filterThreads(threads, 'agents', me).map(t => t.threadId)).toEqual(['c-5'])
  })

  it('leaves out somebody else\'s agent', () => {
    expect(filterThreads(threads, 'mine', me).map(t => t.threadId)).not.toContain('c-6')
    expect(filterThreads(threads, 'agents', me).map(t => t.threadId)).not.toContain('c-6')
  })
})

describe('the reader\'s own agents', () => {
  const own = { uid: 7, name: 'fago', agents: [{ label: 'Claude' }, { label: 'Codex' }] }

  it('offers an agent that is not in the page, so a thread can wait for it', () => {
    const candidates = assigneeCandidates([], [], own)

    expect(candidates.map(candidate => [candidate.via, candidate.present]))
      .toEqual([['Claude', false], ['Codex', false]])
    expect(candidates[0]).toMatchObject({ uid: 7, name: 'fago' })
  })

  it('offers an agent once, as the peer it is, when it is in the page', () => {
    const here = [{ uid: 7, name: 'fago', via: 'Claude', color: '#abc' }] as never

    const candidates = assigneeCandidates(here, [], own)

    expect(candidates.filter(candidate => candidate.via === 'Claude')).toHaveLength(1)
    expect(candidates.find(candidate => candidate.via === 'Claude'))
      .toMatchObject({ present: true })
  })
})

describe('what an assignee is called', () => {
  it('names the owner of somebody else\'s agent, and mine by its bare name', () => {
    const agent = { uid: 7, name: 'fago', via: 'Claude' }

    expect(ownedLabel(agent, 7)).toBe('Claude')
    expect(ownedLabel(agent, 3)).toBe('fago via Claude')
    expect(ownedLabel({ uid: 3, name: 'editor1', via: null }, 7)).toBe('editor1')
  })
})

describe('setting a mention off from the prose', () => {
  const agents = assigneeCandidates([peer(1, 'Ada', 7), peer(2, 'Ada', 7, 'Claude')], [])

  it('splits the draft into the words and the whole mentions in them', () => {
    expect(draftRuns('cc @Ada please', agents).map(run => [run.text, run.mention?.name ?? null]))
      .toEqual([['cc ', null], ['@Ada', 'Ada'], [' please', null]])
  })

  it('carries who the mention is, so an agent can be set off as one', () => {
    const runs = draftRuns('@Claude go', agents, 7)

    expect(runs[0]).toMatchObject({ text: '@Claude' })
    expect(runs[0]!.mention?.via).toBe('Claude')
  })

  it('reads nothing as a mention that is not one', () => {
    expect(draftRuns('@Adam and @Nobody', agents).map(run => run.mention)).toEqual([null])
    expect(draftRuns('', agents)).toEqual([])
  })
})

describe('a posted message, read', () => {
  const agents = assigneeCandidates([peer(1, 'editor1', 3), peer(2, 'editor1', 3, 'claude')], [])
  const stored = 'Please take this over, @claude'

  it('names an agent the way the reader is shown it everywhere else', () => {
    expect(messageRuns(stored, agents, 3).map(run => run.text))
      .toEqual(['Please take this over, ', '@claude'])
    expect(messageRuns(stored, agents, 9).map(run => run.text))
      .toEqual(['Please take this over, ', '@editor1 via claude'])
  })

  it('reads the long form too, whoever typed it', () => {
    const runs = messageRuns('over to @editor1 via claude now', agents, 3)

    expect(runs.map(run => run.text)).toEqual(['over to ', '@claude', ' now'])
    expect(runs[1]!.mention?.via).toBe('claude')
  })

  it('leaves the words that name nobody alone', () => {
    expect(messageRuns('@nobody at all', agents, 3).map(run => run.mention)).toEqual([null])
  })
})
