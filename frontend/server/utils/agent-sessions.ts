import { createHash } from 'node:crypto'
import { AGENT_SESSION_IDLE_MS, AGENT_SESSION_MAX_MS } from './collab-timing'
import type { AgentActor, AgentSession } from './agent-peer'

/**
 * The agent sessions this process is holding open.
 *
 * An agent joins a document's session on its first write and stays in it, the
 * way a human stays in the page: one peer in the presence strip for a whole
 * editing run.
 *
 * A session also carries the authorization it was opened under. The join gate
 * (server/utils/session-router.ts) ran once, against this exact credential and
 * this exact node; every later write on the same session rides that decision
 * and asks Drupal nothing. That is what makes a streamed write cheap, and it is
 * the reason the key below fingerprints the *credential* rather than the
 * account: one account may hold several tokens with different scopes, and a
 * session must never be reusable by a caller who did not earn it.
 *
 * Two lifetimes bound how long one decision may stand:
 *
 *   - idle ({@link AGENT_SESSION_IDLE_MS}), reset on every write and suspended
 *     while a call is in flight ({@link keepAgentSessionAlive}) — a thinking
 *     agent keeps its seat, a crashed one gives it up;
 *   - absolute age ({@link AGENT_SESSION_MAX_MS}) — an idle timer alone never
 *     expires a session that keeps writing, and it also caps every idle window,
 *     so the age is the whole session's bound and not the last window's start.
 *
 * Either lapse closes the session, and the next write opens a fresh one against
 * a fresh gate. That is also the revocation bound: a token revoked, or write
 * access withdrawn, mid-session is noticed when the session closes and not
 * before.
 */

/** An open session and the authorization it holds. */
export interface HeldAgentSession {
  session: AgentSession
  /** The actor the gate admitted — reused as-is by every later write. */
  actor: AgentActor
  /**
   * Check the session's work in under its own actor, and answer whether that
   * work reached Drupal. Runs when it lapses or hands the document on, not
   * when it is torn down.
   */
  persist: () => Promise<boolean>
}

interface OpenSession extends HeldAgentSession {
  openedAt: number
  idle?: ReturnType<typeof setTimeout>
  /** Calls in flight on this session — see {@link keepAgentSessionAlive}. */
  inFlight: number
}

const open = new Map<string, OpenSession>()

/**
 * Which session's uncommitted ops each document is carrying.
 *
 * A checkpoint serializes the whole document and signs it with one identity, so
 * it may only be signed by the actor whose ops it carries. One session at a
 * time therefore owns a document's pending work: a second writer checks the
 * first one's in on its way through ({@link claimAgentWrites}), and a session
 * that does not own the document never checkpoints it.
 *
 * `null` is what a handover nobody could commit leaves behind — the document
 * holds two actors' work, so no agent session signs it, and the document's own
 * checkpoint rules (a human peer's carrier, the quiet timer) commit it.
 */
const writers = new Map<string, string | null>()

/**
 * The registry key: the node, plus a digest of the credential that opened the
 * session. The credential itself is never stored.
 */
export function agentSessionKey(nid: number, carrier: { token?: string }): string {
  return `${nid}:${createHash('sha256').update(carrier.token ?? '').digest('hex')}`
}

/**
 * A session's timers are its own; none may hold the process open. The window is
 * cut short at the absolute deadline, so a session that writes until just
 * before its age cap still closes at the cap.
 */
function idleTimer(key: string, entry: OpenSession, now = Date.now()): ReturnType<typeof setTimeout> {
  const idle = entry.inFlight > 0 ? Infinity : AGENT_SESSION_IDLE_MS
  const delay = Math.min(idle, entry.openedAt + AGENT_SESSION_MAX_MS - now)
  const handle = setTimeout(() => { void lapse(key) }, Math.max(delay, 0))
  ;(handle as { unref?: () => void }).unref?.()
  return handle
}

/** Restarts a session's lapse timer for the window it is now in. */
function armIdle(key: string, entry: OpenSession, now = Date.now()): void {
  clearTimeout(entry.idle)
  entry.idle = idleTimer(key, entry, now)
}

/** Closes a session that ran out of time, persisting what it wrote. */
async function lapse(key: string): Promise<void> {
  await closeAgentSessions({ key })
}

/**
 * The session held for this key, or null when none is open or it has aged out.
 * A hit restarts the idle window.
 */
export async function heldAgentSession(key: string, now = Date.now()): Promise<HeldAgentSession | null> {
  const entry = open.get(key)
  if (!entry) return null
  if (now - entry.openedAt >= AGENT_SESSION_MAX_MS) {
    await lapse(key)
    return null
  }
  armIdle(key, entry, now)
  return entry
}

/** Keeps a freshly opened session for the calls that follow. */
export function holdAgentSession(key: string, held: HeldAgentSession, now = Date.now()): void {
  const entry: OpenSession = { ...held, openedAt: now, inFlight: 0 }
  armIdle(key, entry, now)
  open.set(key, entry)
  if (!writers.has(held.session.documentName)) writers.set(held.session.documentName, key)
}

/**
 * Holds the idle window open while one call is in flight, until the returned
 * release runs. The window measures a caller that has stopped talking, and a
 * `waitForChanges` long-poll is a call that says nothing for minutes by design.
 * The absolute age cap is untouched.
 */
export function keepAgentSessionAlive(key: string): () => void {
  const entry = open.get(key)
  if (!entry) return () => {}
  entry.inFlight += 1
  armIdle(key, entry)
  let released = false
  return () => {
    // Nothing to give back once the session is gone, or once given back.
    if (released || open.get(key) !== entry) return
    released = true
    entry.inFlight -= 1
    armIdle(key, entry)
  }
}

/**
 * What is left of a session's absolute age — the longest a call riding it may
 * run, since the cap closes the session under a long-poll and takes the agent's
 * seat with it.
 */
export function agentSessionRemainingMs(key: string, now = Date.now()): number {
  const entry = open.get(key)
  return entry ? Math.max(entry.openedAt + AGENT_SESSION_MAX_MS - now, 0) : AGENT_SESSION_MAX_MS
}

/**
 * Makes this session the document's pending writer, before it applies ops.
 *
 * Whoever wrote there before checks their work in first, under their own actor
 * — see {@link writers}.
 *
 * Answers whether the document changed hands *and* came out clean. It carries
 * only this session's work from here on, so the caller may point the document's
 * captured carrier at this writer too, and a timer-driven checkpoint is then
 * credited to the actor whose ops it serializes.
 */
export async function claimAgentWrites(key: string): Promise<boolean> {
  const entry = open.get(key)
  if (!entry) return false
  const document = entry.session.documentName
  const held = writers.get(document)
  if (held === key || held === null) return false
  if (held === undefined) {
    writers.set(document, key)
    return false
  }
  const previous = open.get(held)
  const flushed = previous ? await previous.persist() : false
  writers.set(document, flushed ? key : null)
  return flushed
}

/**
 * Closes open sessions and takes them out of the room.
 *
 * @param options.key       Close only this session.
 * @param options.document  Close only sessions on this document.
 * @param options.persist   Checkpoint what each wrote (default true). False for
 *                          a teardown — a settle stands the document down
 *                          *because* nothing may write to the node, and a
 *                          shutdown flushes the snapshot instead.
 */
export async function closeAgentSessions(
  options: { key?: string, document?: string, persist?: boolean } = {},
): Promise<void> {
  const matches = [...open.entries()].filter(([key, entry]) =>
    (options.key === undefined || key === options.key)
    && (options.document === undefined || entry.session.documentName === options.document),
  )
  for (const [key, entry] of matches) {
    open.delete(key)
    clearTimeout(entry.idle)
    const document = entry.session.documentName
    // Only the document's pending writer checks it in. A session that handed
    // the document on would sign another actor's ops with its own name.
    const persist = options.persist !== false && writers.get(document) === key
    try {
      // Persist first, leave second. Leaving drops the last connection to the
      // document, which unloads it — a checkpoint after that has no document
      // left to write from and the session's work never reaches Drupal. The
      // leave is a `finally`: a session that cannot persist its work must not
      // also stay in the room forever.
      try {
        if (persist) {
          if (await entry.persist()) writers.delete(document)
          else writers.set(document, null)
        }
      }
      finally {
        await entry.session.leave()
      }
    }
    catch (err) {
      console.error(`[collab] closing agent session on ${document} failed:`, (err as Error).message)
    }
    // The claim goes when its own session does. A `null` outlives it: the work
    // it stands for is still pending in the document, and no agent may sign it.
    if (writers.get(document) === key) writers.delete(document)
  }
  // A teardown takes the documents themselves — a settled node is about to be
  // deleted, a shutdown ends the process — so their claims go with them.
  if (options.persist === false) {
    if (options.document !== undefined) writers.delete(options.document)
    else if (options.key === undefined) writers.clear()
  }
}
