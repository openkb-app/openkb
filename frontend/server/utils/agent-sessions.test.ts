import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  agentSessionKey,
  claimAgentWrites,
  closeAgentSessions,
  heldAgentSession,
  holdAgentSession,
  keepAgentSessionAlive,
  agentSessionRemainingMs,
} from './agent-sessions'
import { AGENT_SESSION_IDLE_MS, AGENT_SESSION_MAX_MS } from './collab-timing'
import type { AgentActor, AgentSession } from './agent-peer'

const ACTOR: AgentActor = { token: 'tok', uid: 7, name: 'fago', via: 'Claude' }

function stub(documentName = 'node:1') {
  const leave = vi.fn(async () => {})
  const persist = vi.fn(async () => true)
  const session = { documentName, leave } as unknown as AgentSession
  return { session, actor: ACTOR, persist, leave }
}

afterEach(async () => {
  await closeAgentSessions({ persist: false })
  vi.useRealTimers()
})

describe('agentSessionKey', () => {
  it('separates two credentials of the same account on the same node', () => {
    expect(agentSessionKey(1, { token: 'a' })).not.toBe(agentSessionKey(1, { token: 'b' }))
    expect(agentSessionKey(1, { token: 'a' })).not.toBe(agentSessionKey(2, { token: 'a' }))
    expect(agentSessionKey(1, { token: 'a' })).toBe(agentSessionKey(1, { token: 'a' }))
  })

  it('never carries the credential itself', () => {
    expect(agentSessionKey(1, { token: 'super-secret' })).not.toContain('super-secret')
  })
})

describe('the session registry', () => {
  it('hands the same session back to the next call', async () => {
    const held = stub()
    holdAgentSession('k', held)
    expect((await heldAgentSession('k'))?.session).toBe(held.session)
    expect(held.leave).not.toHaveBeenCalled()
  })

  it('holds nothing for a key nobody opened', async () => {
    expect(await heldAgentSession('nobody')).toBeNull()
  })

  it('closes an idle session, and persists what it wrote', async () => {
    vi.useFakeTimers()
    const held = stub()
    holdAgentSession('k', held)

    await vi.advanceTimersByTimeAsync(AGENT_SESSION_IDLE_MS - 1)
    expect(await heldAgentSession('k')).not.toBeNull()

    await vi.advanceTimersByTimeAsync(AGENT_SESSION_IDLE_MS)
    expect(await heldAgentSession('k')).toBeNull()
    expect(held.leave).toHaveBeenCalledOnce()
    expect(held.persist).toHaveBeenCalledOnce()
  })

  it('keeps a session a write keeps using — the idle window restarts', async () => {
    vi.useFakeTimers()
    const held = stub()
    holdAgentSession('k', held)

    for (let write = 0; write < 3; write++) {
      await vi.advanceTimersByTimeAsync(AGENT_SESSION_IDLE_MS - 100)
      expect(await heldAgentSession('k')).not.toBeNull()
    }
    expect(held.leave).not.toHaveBeenCalled()
  })

  it('closes a session past its absolute age, however busy it stayed', async () => {
    vi.useFakeTimers()
    const held = stub()
    holdAgentSession('k', held)

    // Kept alive by writes the whole way, so only the age cap can end it —
    // which is the point of having one.
    const opened = Date.now()
    while (Date.now() - opened < AGENT_SESSION_MAX_MS) {
      await vi.advanceTimersByTimeAsync(AGENT_SESSION_IDLE_MS - 100)
      if (await heldAgentSession('k') === null) break
    }
    expect(await heldAgentSession('k')).toBeNull()
    expect(held.leave).toHaveBeenCalledOnce()
  })

  it('never outlives its absolute age, whenever the last write landed', async () => {
    vi.useFakeTimers()
    const held = stub()
    holdAgentSession('k', held)

    // Write until inside one idle window of the cap, then stop: an idle window
    // measured from that last write would reach past the age the session is
    // allowed to hold its authorization for.
    const opened = Date.now()
    while (Date.now() - opened < AGENT_SESSION_MAX_MS - AGENT_SESSION_IDLE_MS) {
      await vi.advanceTimersByTimeAsync(AGENT_SESSION_IDLE_MS - 100)
      await heldAgentSession('k')
    }
    expect(held.leave).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(AGENT_SESSION_MAX_MS - (Date.now() - opened))
    expect(held.leave).toHaveBeenCalledOnce()
    expect(held.persist).toHaveBeenCalledOnce()
  })

  it('keeps a session whose call is still in flight, however long it runs', async () => {
    vi.useFakeTimers()
    const held = stub()
    holdAgentSession('k', held)
    // What a waitForChanges does: join, then say nothing for its whole timeout.
    await heldAgentSession('k')
    const release = keepAgentSessionAlive('k')

    await vi.advanceTimersByTimeAsync(AGENT_SESSION_IDLE_MS * 2)
    expect(held.leave).not.toHaveBeenCalled()

    // And the window runs from the call's end, not from its start.
    release()
    await vi.advanceTimersByTimeAsync(AGENT_SESSION_IDLE_MS - 100)
    expect(held.leave).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(held.leave).toHaveBeenCalledOnce()
  })

  it('waits for the last call to end before the idle window starts', async () => {
    vi.useFakeTimers()
    const held = stub()
    holdAgentSession('k', held)
    const first = keepAgentSessionAlive('k')
    const second = keepAgentSessionAlive('k')

    first()
    await vi.advanceTimersByTimeAsync(AGENT_SESSION_IDLE_MS * 2)
    expect(held.leave).not.toHaveBeenCalled()

    second()
    await vi.advanceTimersByTimeAsync(AGENT_SESSION_IDLE_MS)
    expect(held.leave).toHaveBeenCalledOnce()
  })

  it('still closes a session at its absolute age while a call is in flight', async () => {
    vi.useFakeTimers()
    const held = stub()
    holdAgentSession('k', held)
    // The cap is the authorization's bound, so no caller may hold a session
    // past it by staying on the line.
    keepAgentSessionAlive('k')

    await vi.advanceTimersByTimeAsync(AGENT_SESSION_MAX_MS - 100)
    expect(held.leave).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(held.leave).toHaveBeenCalledOnce()
  })

  it('holds nothing on a key no session is open for', () => {
    expect(() => keepAgentSessionAlive('nobody')()).not.toThrow()
  })

  it('reports what is left of a session\'s age — the bound on a call riding it', () => {
    vi.useFakeTimers()
    holdAgentSession('k', stub())
    vi.advanceTimersByTime(1_000)
    expect(agentSessionRemainingMs('k')).toBe(AGENT_SESSION_MAX_MS - 1_000)
    // An unopened session bounds nothing narrower than a fresh one.
    expect(agentSessionRemainingMs('nobody')).toBe(AGENT_SESSION_MAX_MS)
  })

  it('closes every session on one document, without persisting', async () => {
    const here = stub('node:1')
    const alsoHere = stub('node:1')
    const elsewhere = stub('node:2')
    holdAgentSession('a', here)
    holdAgentSession('b', alsoHere)
    holdAgentSession('c', elsewhere)

    await closeAgentSessions({ document: 'node:1', persist: false })

    expect(here.leave).toHaveBeenCalledOnce()
    expect(alsoHere.leave).toHaveBeenCalledOnce()
    expect(here.persist).not.toHaveBeenCalled()
    expect(await heldAgentSession('c')).not.toBeNull()
  })

  it('closes everything on shutdown', async () => {
    const first = stub('node:1')
    const second = stub('node:2')
    holdAgentSession('a', first)
    holdAgentSession('b', second)

    await closeAgentSessions({ persist: false })

    expect(first.leave).toHaveBeenCalledOnce()
    expect(second.leave).toHaveBeenCalledOnce()
    expect(await heldAgentSession('a')).toBeNull()
    expect(await heldAgentSession('b')).toBeNull()
  })

  it('persists before it leaves — the document must still be loaded', async () => {
    // Leaving drops the last connection and unloads the document; a checkpoint
    // after that has nothing left to write from, and the session's whole run
    // never reaches Drupal.
    const order: string[] = []
    const held = stub()
    held.persist = vi.fn(async () => { order.push('persist'); return true })
    held.session.leave = vi.fn(async () => { order.push('leave') })
    holdAgentSession('k', held)

    await closeAgentSessions({ key: 'k' })

    expect(order).toEqual(['persist', 'leave'])
  })

  it('leaves the room even when persisting throws — a stuck peer is worse', async () => {
    const held = stub()
    held.persist = vi.fn(async () => { throw new Error('drupal exploded') })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    holdAgentSession('k', held)

    await closeAgentSessions({ key: 'k' })

    expect(held.session.leave).toHaveBeenCalledOnce()
    expect(await heldAgentSession('k')).toBeNull()
  })

  it('checks the previous writer in when another session takes the document over', async () => {
    const first = stub('node:1')
    const second = stub('node:1')
    holdAgentSession('a', first)
    holdAgentSession('b', second)

    expect(await claimAgentWrites('b')).toBe(true)

    expect(first.persist).toHaveBeenCalledOnce()
    expect(second.persist).not.toHaveBeenCalled()
  })

  it('never lets a session that handed the document on sign the next writer\'s ops', async () => {
    const first = stub('node:1')
    const second = stub('node:1')
    holdAgentSession('a', first)
    holdAgentSession('b', second)
    await claimAgentWrites('b')
    first.persist.mockClear()

    await closeAgentSessions({})

    expect(first.persist).not.toHaveBeenCalled()
    expect(second.persist).toHaveBeenCalledOnce()
  })

  it('leaves a document whose handover nobody could commit to its own rules', async () => {
    // A browser peer is in the room, so the outgoing session's checkpoint is
    // not its to make. Both actors' work is pending in one document now, so
    // neither may sign it — the peers' own checkpoint carries it.
    const first = stub('node:1')
    const second = stub('node:1')
    first.persist = vi.fn(async () => false)
    holdAgentSession('a', first)
    holdAgentSession('b', second)

    expect(await claimAgentWrites('b')).toBe(false)
    await closeAgentSessions({})

    expect(second.persist).not.toHaveBeenCalled()
  })

  it('does not touch a session on another document', async () => {
    const here = stub('node:1')
    const elsewhere = stub('node:2')
    holdAgentSession('a', here)
    holdAgentSession('b', elsewhere)

    expect(await claimAgentWrites('b')).toBe(false)
    expect(here.persist).not.toHaveBeenCalled()
  })

  it('drops a session whose close failed, rather than holding a broken one', async () => {
    const held = stub()
    held.session.leave = vi.fn(async () => { throw new Error('socket gone') })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    holdAgentSession('k', held)

    await closeAgentSessions({ key: 'k' })

    expect(await heldAgentSession('k')).toBeNull()
  })
})
